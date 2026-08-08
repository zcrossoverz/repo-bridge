/**
 * Configuration — everything the bridge is allowed to do is decided here.
 *
 * Config comes from environment variables only (12-factor). Nothing in this file
 * reads from the model; the model can never widen its own permissions at runtime.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export type PermissionLevel = 'read_only' | 'edit' | 'develop' | 'full';

/** Ordered weakest → strongest. Used for `atLeast()` comparisons. */
const LEVEL_ORDER: PermissionLevel[] = ['read_only', 'edit', 'develop', 'full'];

export interface WorkspaceRoot {
  /** Short handle the model uses, e.g. "quantix". */
  alias: string;
  /** Absolute, normalised path on the execution host. */
  path: string;
}

/**
 * How the HTTP transport authenticates callers.
 *
 *  oauth      — OAuth 2.1 (MCP authorization spec). The mode ChatGPT Web uses:
 *               it discovers metadata, registers a client, and runs an
 *               authorization-code + PKCE flow. Production default.
 *  path-token — the shared secret carried in the URL path (/mcp/<token>) or a
 *               bearer header. Development fallback for temporary tunnels and
 *               for clients that can set headers (curl, MCP Inspector).
 *  none       — no HTTP authentication. Only legitimate on loopback, or behind
 *               an explicit insecure override.
 */
export type AuthMode = 'none' | 'path-token' | 'oauth';

export interface Config {
  /** How the MCP server is exposed. */
  mode: 'stdio' | 'http' | 'both';
  host: string;
  port: number;
  /** Optional CIDR-less IP allowlist (exact match on remote address). */
  ipAllowlist: string[];

  auth: {
    mode: AuthMode;
    /**
     * Shared secret. In `path-token` mode it is the token itself; in `oauth`
     * mode it is the passphrase the user types on the consent screen to
     * authorise a client. Unused when mode is `none`.
     */
    token: string;
    /** Required to run `none` on a non-loopback interface. */
    allowInsecure: boolean;
    /**
     * Public origin the bridge is reached at, e.g. https://x.trycloudflare.com.
     * OAuth metadata must advertise the URL the client actually used; when this
     * is empty it is derived from the request's forwarded headers.
     */
    publicUrl: string;
    accessTtlSec: number;
    refreshTtlSec: number;
  };

  permission: PermissionLevel;

  /** Directories the bridge may touch in local mode. */
  workspaceRoots: WorkspaceRoot[];
  /** Where managed clones for remote-Git mode live. */
  managedRoot: string;
  /** Persisted bridge state (workspace registry, task metadata). */
  dataDir: string;

  exec: {
    timeoutMs: number;
    maxOutputBytes: number;
    /** Extra binaries the operator explicitly trusts, on top of the built-in list. */
    extraAllowedCommands: string[];
    /** Binaries the operator explicitly bans, overriding everything else. */
    deniedCommands: string[];
    /**
     * When true `run_command` accepts a raw shell string (pipes, &&, redirects).
     * Off by default: commands are tokenised and spawned without a shell so
     * injected content in a source file can never chain a second command.
     */
    allowShell: boolean;
  };

  git: {
    protectedBranches: string[];
    /** Author identity used for bridge-created commits when the repo has none. */
    authorName: string;
    authorEmail: string;
    /** Appended to commit messages so bridge commits are auditable. */
    commitTrailer: string;
  };

  forge: {
    githubToken: string;
    githubApiBase: string;
    gitlabToken: string;
    gitlabApiBase: string;
  };

  log: {
    level: 'debug' | 'info' | 'warn' | 'error';
    /** Optional file to append structured logs to. */
    file: string;
  };

  /** Extra glob-ish path fragments that must never be read. */
  extraSecretPatterns: string[];
}

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envList(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Workspace roots are declared as `alias=path` or bare `path` entries separated
 * by `;` (or `,`). A bare path gets its directory name as the alias.
 *
 *   REPO_BRIDGE_WORKSPACES="quantix=D:\projects\quantix;E:\Workspace\demo"
 */
function parseWorkspaceRoots(raw: string): WorkspaceRoot[] {
  const out: WorkspaceRoot[] = [];
  // Split on ';' only — Windows drive letters make ',' ambiguous inside paths is
  // not an issue, but ';' is the conventional PATH separator on Windows.
  for (const entry of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    // Guard against "D:\path" being read as alias "D" — an alias never contains
    // a path separator and is always more than one character.
    const looksAliased = eq > 1 && !entry.slice(0, eq).match(/[\\/]/);
    const alias = looksAliased ? entry.slice(0, eq).trim() : '';
    const rawPath = looksAliased ? entry.slice(eq + 1).trim() : entry;
    const abs = path.resolve(rawPath);
    out.push({ alias: alias || path.basename(abs) || abs, path: abs });
  }
  return out;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const dataDir = path.resolve(
    env('REPO_BRIDGE_DATA_DIR', path.join(os.homedir(), '.repo-bridge')),
  );

  const mode = env('REPO_BRIDGE_MODE', 'stdio') as Config['mode'];
  if (!['stdio', 'http', 'both'].includes(mode)) {
    throw new Error(`REPO_BRIDGE_MODE must be stdio|http|both, got "${mode}"`);
  }

  const permission = env('REPO_BRIDGE_PERMISSION', 'develop') as PermissionLevel;
  if (!LEVEL_ORDER.includes(permission)) {
    throw new Error(
      `REPO_BRIDGE_PERMISSION must be one of ${LEVEL_ORDER.join('|')}, got "${permission}"`,
    );
  }

  const token = env('REPO_BRIDGE_TOKEN');
  const host = env('REPO_BRIDGE_HOST', '127.0.0.1');
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);

  const GENERATE_HINT =
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

  // Default: keep existing REPO_BRIDGE_TOKEN deployments working exactly as they
  // did (path-token), and require an explicit choice otherwise.
  const explicitAuth = env('REPO_BRIDGE_AUTH');
  const legacyAllowNoAuth = envBool('REPO_BRIDGE_ALLOW_NO_AUTH', false);
  const authMode = (explicitAuth || (token ? 'path-token' : legacyAllowNoAuth ? 'none' : '')) as AuthMode | '';

  if (mode !== 'stdio') {
    if (!authMode) {
      throw new Error(
        'HTTP mode needs an authentication mode. Set one of:\n' +
          '  REPO_BRIDGE_AUTH=oauth        OAuth 2.1 — required for ChatGPT Web (also set REPO_BRIDGE_TOKEN as the login passphrase)\n' +
          '  REPO_BRIDGE_AUTH=path-token   shared secret in the URL path — development tunnels only\n' +
          '  REPO_BRIDGE_AUTH=none         no authentication — loopback only\n\n' +
          'Generate a secret with:\n' +
          GENERATE_HINT,
      );
    }
    if (!['none', 'path-token', 'oauth'].includes(authMode)) {
      throw new Error(`REPO_BRIDGE_AUTH must be none|path-token|oauth, got "${authMode}"`);
    }
  }

  const allowInsecure = envBool('REPO_BRIDGE_ALLOW_INSECURE', legacyAllowNoAuth);

  if (mode !== 'stdio' && authMode !== 'none' && !token) {
    throw new Error(
      `REPO_BRIDGE_AUTH=${authMode} requires REPO_BRIDGE_TOKEN.\n` +
        (authMode === 'oauth'
          ? 'In oauth mode it is the passphrase you type on the consent screen to authorise a client.\n'
          : 'In path-token mode it is the secret carried in the URL path.\n') +
        'Generate one with:\n' +
        GENERATE_HINT,
    );
  }
  if (token && token.length < 24) {
    throw new Error('REPO_BRIDGE_TOKEN must be at least 24 characters.');
  }

  // The bridge can edit files and run commands. Never let that reach a public
  // interface without authentication by accident.
  if (mode !== 'stdio' && authMode === 'none' && !isLoopback && !allowInsecure) {
    throw new Error(
      `Refusing to expose an unauthenticated MCP server on ${host}.\n` +
        'This bridge can read and write files, run commands, and use git.\n\n' +
        'Choose one:\n' +
        '  REPO_BRIDGE_AUTH=oauth        recommended, and the only mode ChatGPT Web supports\n' +
        '  REPO_BRIDGE_AUTH=path-token   development tunnels only\n' +
        '  REPO_BRIDGE_HOST=127.0.0.1    keep it on loopback\n' +
        '  REPO_BRIDGE_ALLOW_INSECURE=true   accept the risk explicitly (not recommended)',
    );
  }

  const cfg: Config = {
    mode,
    host,
    port: envInt('REPO_BRIDGE_PORT', 8848),
    ipAllowlist: envList('REPO_BRIDGE_IP_ALLOWLIST'),

    auth: {
      mode: (authMode || 'none') as AuthMode,
      token,
      allowInsecure,
      publicUrl: env('REPO_BRIDGE_PUBLIC_URL').replace(/\/+$/, ''),
      accessTtlSec: envInt('REPO_BRIDGE_OAUTH_ACCESS_TTL', 3600),
      refreshTtlSec: envInt('REPO_BRIDGE_OAUTH_REFRESH_TTL', 60 * 60 * 24 * 30),
    },

    permission,

    workspaceRoots: parseWorkspaceRoots(env('REPO_BRIDGE_WORKSPACES')),
    managedRoot: path.resolve(
      env('REPO_BRIDGE_MANAGED_ROOT', path.join(dataDir, 'workspaces')),
    ),
    dataDir,

    exec: {
      timeoutMs: envInt('REPO_BRIDGE_EXEC_TIMEOUT_MS', 600_000),
      maxOutputBytes: envInt('REPO_BRIDGE_MAX_OUTPUT_BYTES', 120_000),
      extraAllowedCommands: envList('REPO_BRIDGE_ALLOW_COMMANDS').map((s) => s.toLowerCase()),
      deniedCommands: envList('REPO_BRIDGE_DENY_COMMANDS').map((s) => s.toLowerCase()),
      allowShell: envBool('REPO_BRIDGE_ALLOW_SHELL', false),
    },

    git: {
      protectedBranches: envList('REPO_BRIDGE_PROTECTED_BRANCHES', [
        'main',
        'master',
        'develop',
        'release/*',
        'production',
      ]),
      authorName: env('REPO_BRIDGE_GIT_AUTHOR_NAME', 'repo-bridge'),
      authorEmail: env('REPO_BRIDGE_GIT_AUTHOR_EMAIL', 'repo-bridge@localhost'),
      commitTrailer: env('REPO_BRIDGE_COMMIT_TRAILER', ''),
    },

    forge: {
      githubToken: env('GITHUB_TOKEN', env('REPO_BRIDGE_GITHUB_TOKEN')),
      githubApiBase: env('REPO_BRIDGE_GITHUB_API', 'https://api.github.com'),
      gitlabToken: env('GITLAB_TOKEN', env('REPO_BRIDGE_GITLAB_TOKEN')),
      gitlabApiBase: env('REPO_BRIDGE_GITLAB_API', 'https://gitlab.com/api/v4'),
    },

    log: {
      level: (env('REPO_BRIDGE_LOG_LEVEL', 'info') as Config['log']['level']),
      file: env('REPO_BRIDGE_LOG_FILE'),
    },

    extraSecretPatterns: envList('REPO_BRIDGE_SECRET_PATTERNS'),
  };

  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.managedRoot, { recursive: true });

  cached = cfg;
  return cfg;
}

/** True when the active permission level is >= `required`. */
export function atLeast(active: PermissionLevel, required: PermissionLevel): boolean {
  return LEVEL_ORDER.indexOf(active) >= LEVEL_ORDER.indexOf(required);
}

export function describeLevel(level: PermissionLevel): string {
  switch (level) {
    case 'read_only':
      return 'read_only — search, read files, inspect git. No modifications.';
    case 'edit':
      return 'edit — read plus create/modify/move/delete files. No command execution, no push.';
    case 'develop':
      return 'develop — edit plus build/test/lint/approved commands and local git (branch, commit).';
    case 'full':
      return 'full — develop plus push and pull-request creation.';
  }
}

/** Test seam: drop the memoised config so a new environment can be loaded. */
export function resetConfigForTests(): void {
  cached = null;
}

/**
 * Git access.
 *
 * All git calls build their argv programmatically — the model never supplies a
 * git command string — so there is no injection surface here and no need to go
 * through the command allowlist. What *is* enforced: git never gets an
 * interactive terminal (it would hang forever waiting for credentials), and
 * credentials are injected per-push rather than written to disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { spawnArgv, type ExecResult } from '../exec/runner.js';
import { matchesBranchPattern } from '../security/commands.js';
import { registerLiteralSecret } from '../security/secrets.js';

export interface GitOptions {
  /** Return the result instead of throwing when git exits non-zero. */
  allowFail?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Extra env. */
  env?: Record<string, string>;
  /** Extra `-c key=value` settings, applied to this invocation only. */
  config?: string[];
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<ExecResult> {
  const cfg = loadConfig();
  const extraConfig = (opts.config ?? []).flatMap((c) => ['-c', c]);
  const result = await spawnArgv(
    [
      'git',
      // Never block on an auth prompt or a pager.
      '-c', 'core.pager=cat',
      '-c', 'credential.helper=',
      '-c', 'advice.detachedHead=false',
      ...extraConfig,
      ...args,
    ],
    {
      cwd,
      timeoutMs: opts.timeoutMs ?? Math.min(cfg.exec.timeoutMs, 180_000),
      maxOutputBytes: opts.maxOutputBytes ?? cfg.exec.maxOutputBytes,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...opts.env },
    },
  );

  if (!result.ok && !opts.allowFail) {
    throw new BridgeError('GIT_ERROR', `git ${args[0] ?? ''} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(0, 8).join('\n')}`, {
      details: { exitCode: result.exitCode, command: result.command },
    });
  }
  return result;
}

export function isGitRepo(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'));
}

export async function assertGitRepo(root: string): Promise<void> {
  if (!isGitRepo(root)) {
    throw new BridgeError('GIT_ERROR', 'This workspace is not a git repository.', {
      hint: 'Run `git init` yourself if that is intended, or open a workspace that contains a repository.',
    });
  }
}

// ── status ───────────────────────────────────────────────────────────────────

export interface FileStatus {
  path: string;
  /** Index (staged) status letter, ' ' when unchanged. */
  staged: string;
  /** Worktree status letter, ' ' when unchanged. */
  worktree: string;
  originalPath?: string;
}

export interface RepoStatus {
  branch: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
  conflicted: string[];
  clean: boolean;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw: string): RepoStatus {
  const fields = raw.split('\0');
  const status: RepoStatus = {
    branch: '(unknown)',
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    clean: true,
  };

  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      status.detached = head === '(detached)';
      status.branch = head;
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      status.staged.push({ path: parts.slice(8).join(' '), staged: xy[0]!, worktree: xy[1]! });
    } else if (line.startsWith('2 ')) {
      // Rename/copy: the original path is the *next* NUL-separated field.
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const newPath = parts.slice(9).join(' ');
      const original = fields[++i] ?? '';
      status.staged.push({ path: newPath, staged: xy[0]!, worktree: xy[1]!, originalPath: original });
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      status.conflicted.push(parts.slice(10).join(' '));
    } else if (line.startsWith('? ')) {
      status.untracked.push(line.slice(2));
    }
  }

  // Split the combined index/worktree entries into the two buckets the model cares about.
  const all = status.staged;
  status.staged = all.filter((f) => f.staged !== '.' && f.staged !== ' ');
  status.unstaged = all.filter((f) => f.worktree !== '.' && f.worktree !== ' ');
  status.clean =
    status.staged.length === 0 &&
    status.unstaged.length === 0 &&
    status.untracked.length === 0 &&
    status.conflicted.length === 0;

  return status;
}

export async function getStatus(root: string): Promise<RepoStatus> {
  const res = await git(root, ['status', '--porcelain=v2', '--branch', '-z']);
  return parseStatus(res.stdout);
}

export async function currentBranch(root: string): Promise<string> {
  const res = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return res.stdout.trim() || 'HEAD';
}

export async function listBranches(root: string): Promise<{ local: string[]; remote: string[]; current: string }> {
  const cur = await currentBranch(root);
  const local = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { allowFail: true });
  const remote = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], { allowFail: true });
  const split = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  return { local: split(local.stdout), remote: split(remote.stdout), current: cur };
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export async function log(root: string, limit = 15, refRange?: string): Promise<CommitInfo[]> {
  const sep = '\x1f';
  const args = ['log', `-n${Math.max(1, Math.min(limit, 200))}`, `--format=%H${sep}%h${sep}%an${sep}%aI${sep}%s`];
  if (refRange) args.push(refRange);
  const res = await git(root, args, { allowFail: true });
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', shortHash = '', author = '', date = '', ...subject] = line.split(sep);
      return { hash, shortHash, author, date, subject: subject.join(sep) };
    });
}

export async function remotes(root: string): Promise<Array<{ name: string; url: string }>> {
  const res = await git(root, ['remote', '-v'], { allowFail: true });
  const seen = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (m && !seen.has(m[1]!)) seen.set(m[1]!, m[2]!);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

/** Best-effort default branch of `origin`, used as the PR base. */
export async function defaultBranch(root: string): Promise<string | null> {
  const head = await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  const name = head.stdout.trim().replace('refs/remotes/origin/', '');
  if (name) return name;
  for (const candidate of ['main', 'master', 'develop']) {
    const exists = await git(root, ['rev-parse', '--verify', `refs/remotes/origin/${candidate}`], { allowFail: true });
    if (exists.ok) return candidate;
  }
  return null;
}

// ── protection ───────────────────────────────────────────────────────────────

export function isProtectedBranch(branch: string): boolean {
  const cfg = loadConfig();
  return cfg.git.protectedBranches.some((p) => matchesBranchPattern(branch, p));
}

export function assertNotProtected(branch: string, action: string): void {
  if (!isProtectedBranch(branch)) return;
  throw new BridgeError('PROTECTED_BRANCH', `Refusing to ${action} on protected branch "${branch}".`, {
    hint:
      `Protected patterns: ${loadConfig().git.protectedBranches.join(', ')}\n` +
      'Create a feature branch first (git_branch with create=true), then commit there and open a pull request.',
  });
}

// ── credentials for remote operations ────────────────────────────────────────

export interface RemoteAuth {
  /** URL with credentials embedded, or null when the remote needs no injection. */
  url: string | null;
  provider: 'github' | 'gitlab' | 'other';
}

/**
 * Build an authenticated push URL from the configured forge token.
 *
 * The token is only ever passed as an argv element for a single git invocation;
 * it is never written into .git/config, and `registerLiteralSecret` guarantees
 * it is scrubbed from any output that reaches the model.
 */
export function authenticateUrl(remoteUrl: string): RemoteAuth {
  const cfg = loadConfig();
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    // SSH form (git@host:owner/repo.git) — the host's own key handles auth.
    return { url: null, provider: /gitlab/i.test(remoteUrl) ? 'gitlab' : /github/i.test(remoteUrl) ? 'github' : 'other' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { url: null, provider: 'other' };
  }

  const host = parsed.hostname.toLowerCase();
  const provider = host.includes('github') ? 'github' : host.includes('gitlab') ? 'gitlab' : 'other';
  const token = provider === 'github' ? cfg.forge.githubToken : provider === 'gitlab' ? cfg.forge.gitlabToken : '';
  if (!token) return { url: null, provider };

  registerLiteralSecret(token);
  parsed.username = provider === 'github' ? 'x-access-token' : 'oauth2';
  parsed.password = token;
  return { url: parsed.toString(), provider };
}

/**
 * `-c` settings that make a single git invocation use the token, via
 * `url.<authenticated>.insteadOf=<clean>`. Nothing is written to .git/config,
 * so a cloned workspace never carries credentials on disk.
 */
export function authConfig(remoteUrl: string): string[] {
  const auth = authenticateUrl(remoteUrl);
  if (!auth.url) return [];
  const clean = remoteUrl.replace(/\.git$/, '');
  const authed = auth.url.replace(/\.git$/, '');
  return [`url.${authed}.insteadOf=${clean}`];
}

/** The push/fetch URL of `origin`, or null when there is no origin. */
export async function originUrl(root: string): Promise<string | null> {
  const list = await remotes(root);
  return list.find((r) => r.name === 'origin')?.url ?? list[0]?.url ?? null;
}

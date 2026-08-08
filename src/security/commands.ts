/**
 * Command policy.
 *
 * The design rule: **no shell**. A command string is tokenised here and spawned
 * as an argv array, so a `;` or `&&` smuggled in from a source file, a test
 * name, or a prompt-injected README cannot chain a second process. Shell
 * metacharacters outside quotes are rejected rather than silently escaped.
 *
 * On top of that: an executable allowlist, a hard-block list for things no
 * coding task needs, and a "destructive" tier that requires explicit confirm.
 */
import path from 'node:path';
import { BridgeError } from '../errors.js';

/** Development tooling the bridge will run without extra configuration. */
const DEFAULT_ALLOWED = new Set([
  // vcs
  'git',
  // node
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'tsc', 'tsx', 'ts-node', 'jest', 'vitest', 'eslint', 'prettier', 'biome',
  // jvm
  'mvn', 'mvnw', 'gradle', 'gradlew', 'java', 'javac', 'kotlinc',
  // python
  'python', 'python3', 'py', 'pip', 'pip3', 'pytest', 'poetry', 'uv', 'uvx',
  'ruff', 'black', 'mypy', 'tox', 'flake8',
  // go / rust / dotnet
  'go', 'gofmt', 'golangci-lint', 'cargo', 'rustc', 'rustfmt', 'clippy-driver', 'dotnet',
  // ruby / php
  'ruby', 'rake', 'bundle', 'rspec', 'php', 'composer', 'phpunit',
  // mobile
  'dart', 'flutter', 'swift', 'pod',
  // build systems
  'make', 'cmake', 'ninja', 'bazel', 'just', 'task',
  // containers (subcommand-restricted below)
  'docker', 'docker-compose',
  // read-only shell helpers that are genuinely useful and side-effect free
  'echo', 'pwd', 'ls', 'dir', 'cat', 'type', 'where', 'which', 'whoami', 'hostname',
]);

/**
 * Never runnable, at any permission level, with any confirmation. These either
 * escape the sandbox, damage the host, or have nothing to do with coding.
 */
const HARD_BLOCKED = new Set([
  'sudo', 'doas', 'su', 'runas',
  'mkfs', 'fdisk', 'diskpart', 'format',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'passwd', 'useradd', 'usermod', 'chpasswd', 'net',
  'iptables', 'ufw', 'firewall-cmd', 'netsh',
  'reg', 'regedit', 'wmic', 'sc', 'bcdedit',
  'ssh', 'scp', 'sftp', 'telnet', 'nc', 'ncat', 'netcat',
  'curl', 'wget', 'invoke-webrequest', 'iwr', // no arbitrary egress from the exec tool
  'bash', 'sh', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd', 'cscript', 'wscript',
  'eval', 'exec', 'source',
  'crontab', 'schtasks', 'at',
  'chown', 'chmod', 'icacls', 'takeown', 'attrib',
]);

/**
 * Allowed, but each entry must clear its subcommand check. Keeps `docker` usable
 * for inspecting a compose stack without handing over `docker run -v /:/host`.
 */
const SUBCOMMAND_ALLOWLIST: Record<string, string[][]> = {
  docker: [
    ['compose', 'config'], ['compose', 'ps'], ['compose', 'logs'], ['compose', 'build'],
    ['compose', 'version'], ['ps'], ['images'], ['version'], ['info'],
  ],
  'docker-compose': [['config'], ['ps'], ['logs'], ['build'], ['version']],
};

/** Destructive — allowed only when the caller passes `confirm: true`. */
interface DestructiveRule {
  id: string;
  reason: string;
  safer?: string;
  match: (argv: string[]) => boolean;
}

const has = (argv: string[], ...flags: string[]) => argv.some((a) => flags.includes(a));
const startsWith = (argv: string[], ...seq: string[]) =>
  seq.every((s, i) => argv[i + 1] === s);

const DESTRUCTIVE_RULES: DestructiveRule[] = [
  {
    id: 'git.force_push',
    reason: 'Force-push rewrites published history.',
    safer: 'Push normally, or rebase locally and push a new branch.',
    match: (a) => a[0] === 'git' && a[1] === 'push' && has(a, '--force', '-f', '--force-with-lease'),
  },
  {
    id: 'git.delete_remote_branch',
    reason: 'Deletes a branch on the remote.',
    match: (a) => a[0] === 'git' && a[1] === 'push' && has(a, '--delete', '-d'),
  },
  {
    id: 'git.reset_hard',
    reason: 'Discards uncommitted work in the working tree.',
    safer: 'git stash, or git restore only the files you changed.',
    match: (a) => a[0] === 'git' && a[1] === 'reset' && has(a, '--hard'),
  },
  {
    id: 'git.clean',
    reason: 'Deletes untracked files, including ones the user may not have committed yet.',
    safer: 'git clean -n first to see what would be removed.',
    match: (a) => a[0] === 'git' && a[1] === 'clean' && a.some((x) => /^-[a-z]*[fdx]/.test(x)),
  },
  {
    id: 'git.history_rewrite',
    reason: 'Rewrites commit history.',
    match: (a) => a[0] === 'git' && ['filter-branch', 'filter-repo'].includes(a[1] ?? ''),
  },
  {
    id: 'git.branch_force_delete',
    reason: 'Deletes a branch that may hold unmerged commits.',
    match: (a) => a[0] === 'git' && a[1] === 'branch' && has(a, '-D'),
  },
  {
    id: 'fs.recursive_delete',
    reason: 'Recursive filesystem delete.',
    safer: 'delete_path with a specific file, or a narrower glob.',
    match: (a) =>
      (['rm', 'rmdir', 'del', 'rd', 'remove-item'].includes(a[0] ?? '') &&
        a.some((x) => /^-[a-z]*[rf]/i.test(x) || /^\/[sq]$/i.test(x) || /^-recurse$/i.test(x))),
  },
  {
    id: 'docker.prune',
    reason: 'Removes images/volumes/containers system-wide, outside this project.',
    match: (a) => ['docker', 'docker-compose'].includes(a[0] ?? '') && a.includes('prune'),
  },
  {
    id: 'docker.volume_rm',
    reason: 'Deletes container volumes — usually the project database.',
    match: (a) => a[0] === 'docker' && (startsWith(a, 'volume', 'rm') || startsWith(a, 'compose', 'down')),
  },
  {
    id: 'pkg.publish',
    reason: 'Publishes a package to a public registry — an outward-facing, hard-to-undo action.',
    match: (a) =>
      (['npm', 'pnpm', 'yarn', 'bun'].includes(a[0] ?? '') && a[1] === 'publish') ||
      (a[0] === 'cargo' && a[1] === 'publish') ||
      (a[0] === 'mvn' && a.includes('deploy')) ||
      (a[0] === 'dotnet' && a[1] === 'nuget' && a[2] === 'push'),
  },
  {
    id: 'db.drop',
    reason: 'SQL DROP/TRUNCATE detected in the command arguments.',
    match: (a) => a.some((x) => /\b(drop\s+(database|table|schema)|truncate\s+table)\b/i.test(x)),
  },
];

export interface ParsedCommand {
  argv: string[];
  /** Base executable name, lowercased, extension stripped. */
  bin: string;
  /** Non-empty when the command needs `confirm: true`. */
  destructive?: { id: string; reason: string; safer?: string };
}

/** Single characters that only mean something to a shell. */
const SHELL_METACHARS = /[;&|<>`\n\r]/;
/** Multi-character substitutions — checked with lookahead, not per character. */
const SHELL_SEQUENCES: Array<[string, string]> = [
  ['$(', 'command substitution'],
  ['${', 'parameter expansion'],
];

/**
 * Split a command line into argv. Handles single and double quotes; a backslash
 * is always literal so Windows paths survive intact (use the other quote style
 * when you need a literal quote).
 *
 * Throws if a shell metacharacter appears outside quotes — those only make sense
 * with a shell, and we deliberately never use one.
 */
export function tokenize(input: string, allowShellChars = false): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if (!allowShellChars) {
      const sequence = SHELL_SEQUENCES.find(([seq]) => input.startsWith(seq, i));
      if (sequence || SHELL_METACHARS.test(ch)) {
        throw new BridgeError(
          'COMMAND_BLOCKED',
          sequence
            ? `Shell ${sequence[1]} "${sequence[0]}" is not allowed — commands run without a shell.`
            : `Shell metacharacter "${ch}" is not allowed — commands run without a shell.`,
          {
            hint:
              'Run the steps as separate run_command calls. Pipes, redirects and && are unavailable ' +
              'by design so untrusted repository content cannot chain a second command.',
          },
        );
      }
    }
    current += ch;
    started = true;
  }

  if (quote) throw new BridgeError('INVALID_ARGUMENT', 'Unterminated quote in command.');
  if (started || current) tokens.push(current);
  return tokens;
}

/** `./gradlew` → `gradlew`, `C:\Python\python.exe` → `python`. */
export function baseName(token: string): string {
  const base = path.basename(token.replace(/\\/g, '/'));
  return base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').toLowerCase();
}

export interface CommandPolicy {
  extraAllowed: string[];
  denied: string[];
  allowShell: boolean;
}

/**
 * Validate a command line and report whether it is destructive.
 * Throws BridgeError for anything outright disallowed.
 */
export function parseCommand(input: string, policy: CommandPolicy): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed) throw new BridgeError('INVALID_ARGUMENT', 'command is empty');

  const argv = tokenize(trimmed, policy.allowShell);
  if (argv.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'command is empty');

  const bin = baseName(argv[0]!);

  if (policy.denied.includes(bin)) {
    throw new BridgeError('COMMAND_BLOCKED', `"${bin}" is blocked by the bridge configuration.`);
  }
  if (HARD_BLOCKED.has(bin)) {
    throw new BridgeError(
      'COMMAND_BLOCKED',
      `"${bin}" is permanently blocked — it can escape the workspace or affect the host.`,
      { hint: 'If a project build genuinely needs it, the operator must run it manually.' },
    );
  }

  const allowed = DEFAULT_ALLOWED.has(bin) || policy.extraAllowed.includes(bin);
  if (!allowed) {
    throw new BridgeError(
      'COMMAND_BLOCKED',
      `"${bin}" is not in the allowed command list.`,
      {
        hint:
          `Allowed: ${[...DEFAULT_ALLOWED].sort().join(', ')}\n` +
          `The operator can extend this with REPO_BRIDGE_ALLOW_COMMANDS=${bin}`,
      },
    );
  }

  const subAllow = SUBCOMMAND_ALLOWLIST[bin];
  if (subAllow) {
    const rest = argv.slice(1).filter((a) => !a.startsWith('-'));
    const ok = subAllow.some((seq) => seq.every((s, i) => rest[i] === s));
    if (!ok) {
      throw new BridgeError(
        'COMMAND_BLOCKED',
        `"${bin} ${rest.slice(0, 2).join(' ')}" is not an allowed subcommand.`,
        { hint: `Allowed: ${subAllow.map((s) => `${bin} ${s.join(' ')}`).join(', ')}` },
      );
    }
  }

  const normalised = [bin, ...argv.slice(1)];
  const rule = DESTRUCTIVE_RULES.find((r) => r.match(normalised));

  return {
    argv,
    bin,
    ...(rule ? { destructive: { id: rule.id, reason: rule.reason, ...(rule.safer ? { safer: rule.safer } : {}) } } : {}),
  };
}

/** The allowlist, for `bridge_status`. */
export function allowedCommands(policy: CommandPolicy): string[] {
  return [...new Set([...DEFAULT_ALLOWED, ...policy.extraAllowed])]
    .filter((c) => !policy.denied.includes(c))
    .sort();
}

/** Branch-name matching that understands the `release/*` form used in config. */
export function matchesBranchPattern(branch: string, pattern: string): boolean {
  if (!pattern.includes('*')) return branch === pattern;
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return re.test(branch);
}

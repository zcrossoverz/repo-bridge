/**
 * Git tools.
 *
 * Two guardrails run through all of them:
 *   - protected branches (main/master/develop/release/*) reject commits and
 *     pushes, so the default path is always "work on a feature branch"
 *   - operations that can lose the user's uncommitted work require confirm=true
 */
import { loadConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { audit } from '../logger.js';
import {
  assertGitRepo,
  assertNotProtected,
  authConfig,
  currentBranch,
  defaultBranch,
  getStatus,
  git,
  isProtectedBranch,
  listBranches,
  log as gitLog,
  originUrl,
} from '../git/git.js';
import { registry, type Workspace } from '../workspace/registry.js';
import { block, bullets, join, kv, type Args, type ToolDef } from './types.js';

const workspaceParam = {
  workspace: { type: 'string', description: 'Workspace alias. Defaults to the active workspace.' },
};

async function repo(args: Args): Promise<Workspace> {
  const w = registry().require(args.optStr('workspace'));
  await assertGitRepo(w.root);
  return w;
}

export const gitTools: ToolDef[] = [
  {
    name: 'git_status',
    description:
      'Current branch, upstream tracking, ahead/behind counts, and every staged / unstaged / untracked file. Check this before committing, and to notice user changes you did not make.',
    capability: 'read',
    inputSchema: { type: 'object', properties: { ...workspaceParam } },
    handler: async (args) => {
      const w = await repo(args);
      const status = await getStatus(w.root);
      return block('GIT STATUS', [
        ...kv({
          branch: `${status.branch}${isProtectedBranch(status.branch) ? ' [PROTECTED]' : ''}`,
          upstream: status.upstream,
          ahead: status.ahead || undefined,
          behind: status.behind || undefined,
          state: status.clean ? 'clean' : 'dirty',
        }),
        ...(status.conflicted.length ? ['CONFLICTED:', ...bullets(status.conflicted).map((b) => '  ' + b)] : []),
        ...(status.staged.length ? ['staged:', ...bullets(status.staged.map((f) => `${f.staged} ${f.path}${f.originalPath ? ` (was ${f.originalPath})` : ''}`)).map((b) => '  ' + b)] : []),
        ...(status.unstaged.length ? ['unstaged:', ...bullets(status.unstaged.map((f) => `${f.worktree} ${f.path}`)).map((b) => '  ' + b)] : []),
        ...(status.untracked.length ? ['untracked:', ...bullets(status.untracked).map((b) => '  ' + b)] : []),
      ]);
    },
  },

  {
    name: 'git_diff',
    description:
      'Show changes as a unified diff. against="worktree" (default, unstaged changes), "staged", "head" (staged + unstaged), or a branch/commit name to compare the current branch against it (uses the merge base). Use stat_only=true first on a large change to see which files moved before pulling in the full diff.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        against: { type: 'string', description: '"worktree" | "staged" | "head" | branch or commit ref. Default "head".' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Limit the diff to these paths.' },
        stat_only: { type: 'boolean', description: 'Only per-file change counts. Default false.' },
        context_lines: { type: 'number', description: 'Context lines around each hunk. Default 3.' },
      },
    },
    handler: async (args) => {
      const w = await repo(args);
      const against = args.str('against', 'head');
      const paths = args.strArray('paths');
      const statOnly = args.bool('stat_only', false);
      const context = Math.max(0, Math.min(args.num('context_lines', 3), 20));

      const diffArgs = ['diff', `-U${context}`, '--no-color'];
      if (statOnly) diffArgs.push('--stat');

      if (against === 'worktree') {
        /* default: unstaged changes */
      } else if (against === 'staged') {
        diffArgs.push('--cached');
      } else if (against === 'head') {
        diffArgs.push('HEAD');
      } else {
        diffArgs.push(`${against}...HEAD`);
      }
      if (paths.length) diffArgs.push('--', ...paths);

      const res = await git(w.root, diffArgs, { allowFail: true });
      if (!res.ok && res.stderr.trim()) {
        throw new BridgeError('GIT_ERROR', res.stderr.trim().split('\n')[0] ?? 'diff failed', {
          hint: against.length > 0 && !['worktree', 'staged', 'head'].includes(against)
            ? `Is "${against}" a valid ref? Try git_branch to list branches.`
            : undefined,
        });
      }

      const body = res.stdout.trim();
      const untracked = against === 'head' || against === 'worktree' ? (await getStatus(w.root)).untracked : [];
      return join(
        `diff (${against}${statOnly ? ', stat only' : ''})`,
        body || '(no changes)',
        untracked.length ? block('UNTRACKED (not in the diff)', bullets(untracked, 20)) : '',
        res.truncated ? 'Diff truncated — use stat_only=true or limit `paths`.' : '',
      );
    },
  },

  {
    name: 'git_log',
    description: 'Recent commits, newest first. Useful for matching the project\'s commit-message conventions before committing.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        limit: { type: 'number', description: 'Number of commits. Default 15.' },
        range: { type: 'string', description: 'Optional ref or range, e.g. "develop..HEAD".' },
      },
    },
    handler: async (args) => {
      const w = await repo(args);
      const commits = await gitLog(w.root, args.num('limit', 15), args.optStr('range'));
      if (!commits.length) return 'No commits.';
      return commits.map((c) => `${c.shortHash}  ${c.date.slice(0, 10)}  ${c.author.padEnd(18).slice(0, 18)}  ${c.subject}`).join('\n');
    },
  },

  {
    name: 'git_branch',
    description:
      'List branches, or create / switch to one. Creating a feature branch is the normal first step before making changes, since commits to protected branches are refused.',
    capability: 'git_local',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        name: { type: 'string', description: 'Branch to create or switch to. Omit to list branches.' },
        create: { type: 'boolean', description: 'Create the branch. Default false (switch to an existing one).' },
        from: { type: 'string', description: 'Base ref for a new branch. Default: the current HEAD.' },
      },
    },
    handler: async (args) => {
      const w = await repo(args);
      const name = args.optStr('name');

      if (!name) {
        const branches = await listBranches(w.root);
        const base = await defaultBranch(w.root);
        return join(
          block('BRANCHES', [
            ...kv({ current: branches.current, default: base ?? undefined }),
            'local:',
            ...bullets(branches.local.map((b) => `${b === branches.current ? '* ' : '  '}${b}${isProtectedBranch(b) ? ' [protected]' : ''}`), 40).map((x) => '  ' + x),
            ...(branches.remote.length ? ['remote:', ...bullets(branches.remote, 40).map((x) => '  ' + x)] : []),
          ]),
        );
      }

      const create = args.bool('create', false);
      const from = args.optStr('from');

      const status = await getStatus(w.root);
      if (!status.clean && !create) {
        // Switching with a dirty tree can silently carry changes across branches.
        throw new BridgeError('GIT_ERROR', 'Working tree has uncommitted changes; refusing to switch branches.', {
          hint: 'Commit the changes first, or create a new branch from here (create=true) which keeps them.',
        });
      }

      const argv = create ? ['checkout', '-b', name, ...(from ? [from] : [])] : ['checkout', name];
      const res = await git(w.root, argv, { allowFail: true });
      if (!res.ok) {
        throw new BridgeError('GIT_ERROR', (res.stderr || res.stdout).trim().split('\n')[0] ?? 'checkout failed', {
          hint: create ? 'Does the branch already exist? Switch to it with create=false.' : 'Does the branch exist? List branches by omitting `name`.',
        });
      }

      registry().recordGit(w.id, create ? 'branch_create' : 'checkout', name);
      audit({ action: 'git_branch', workspace: w.alias, target: name, outcome: 'ok', detail: { create } });
      return `${create ? 'created and switched to' : 'switched to'} branch "${name}"${from ? ` (from ${from})` : ''}`;
    },
  },

  {
    name: 'git_commit',
    description:
      'Stage and commit changes. By default every modified and untracked file is staged; pass `paths` to commit a subset. Refuses to commit on a protected branch — create a feature branch first. Write the message in the style of the repository\'s recent commits (check git_log).',
    capability: 'git_local',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        message: { type: 'string', description: 'Commit message. First line is the subject; add a body after a blank line.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Only stage and commit these paths. Default: all changes.' },
      },
      required: ['message'],
    },
    handler: async (args) => {
      const cfg = loadConfig();
      const w = await repo(args);
      const branch = await currentBranch(w.root);
      assertNotProtected(branch, 'commit');

      const message = args.str('message');
      const paths = args.strArray('paths');

      const before = await getStatus(w.root);
      if (before.clean) return 'Nothing to commit — the working tree is clean.';
      if (before.conflicted.length) {
        throw new BridgeError('GIT_ERROR', `Unresolved merge conflicts in: ${before.conflicted.join(', ')}`, {
          hint: 'Resolve the conflicts with edit_file first, then commit.',
        });
      }

      await git(w.root, paths.length ? ['add', '--', ...paths] : ['add', '-A']);

      const staged = await getStatus(w.root);
      if (staged.staged.length === 0) {
        return 'Nothing staged — the requested paths have no changes.';
      }

      const fullMessage = cfg.git.commitTrailer ? `${message}\n\n${cfg.git.commitTrailer}` : message;
      const res = await git(w.root, [
        '-c', `user.name=${cfg.git.authorName}`,
        '-c', `user.email=${cfg.git.authorEmail}`,
        'commit', '-m', fullMessage,
      ], { allowFail: true });

      if (!res.ok) {
        throw new BridgeError('GIT_ERROR', (res.stderr || res.stdout).trim().split('\n').slice(0, 5).join('\n'), {
          hint: 'A commit hook may have rejected the change. Fix the reported problem and commit again.',
        });
      }

      const head = (await gitLog(w.root, 1))[0];
      registry().recordGit(w.id, 'commit', `${head?.shortHash ?? ''} ${message.split('\n')[0]}`);
      audit({ action: 'git_commit', workspace: w.alias, target: branch, outcome: 'ok', detail: { files: staged.staged.length } });

      return join(
        `committed ${staged.staged.length} file(s) on ${branch} as ${head?.shortHash ?? '(unknown)'}`,
        block('FILES', bullets(staged.staged.map((f) => `${f.staged} ${f.path}`), 40)),
      );
    },
  },

  {
    name: 'git_push',
    description:
      'Push the current (or named) branch to the remote, setting upstream on first push. Refuses to push a protected branch. Uses the bridge\'s configured GitHub/GitLab token; the token is never written into the repository.',
    capability: 'git_remote',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        branch: { type: 'string', description: 'Branch to push. Default: the current branch.' },
        remote: { type: 'string', description: 'Remote name. Default "origin".' },
        force: { type: 'boolean', description: 'Force-push (rewrites remote history). Requires confirm=true as well.' },
        confirm: { type: 'boolean', description: 'Required when force is set.' },
      },
    },
    handler: async (args) => {
      const w = await repo(args);
      const branch = args.optStr('branch') ?? (await currentBranch(w.root));
      const remoteName = args.str('remote', 'origin');
      const force = args.bool('force', false);

      assertNotProtected(branch, 'push');
      if (force && !args.bool('confirm', false)) {
        throw new BridgeError('DESTRUCTIVE_BLOCKED', 'Force-push rewrites remote history and needs confirm=true.', {
          hint: 'Prefer pushing a new branch. If the remote must be rewritten, tell the user first.',
        });
      }

      const url = await originUrl(w.root);
      if (!url) {
        throw new BridgeError('GIT_ERROR', 'This repository has no remote configured.', {
          hint: 'Add a remote manually, or use repo_open_remote to work on a cloned repository.',
        });
      }

      const argv = ['push', '--set-upstream', remoteName, branch];
      if (force) argv.splice(1, 0, '--force-with-lease');

      const res = await git(w.root, argv, { allowFail: true, config: authConfig(url), timeoutMs: 300_000 });
      if (!res.ok) {
        const stderr = res.stderr.trim();
        audit({ action: 'git_push', workspace: w.alias, target: branch, outcome: 'error' });
        throw new BridgeError('GIT_ERROR', `Push failed: ${stderr.split('\n').slice(0, 6).join('\n')}`, {
          hint: /authentication|denied|403|401/i.test(stderr)
            ? 'The configured token lacks push access to this repository (GitHub needs "repo"/Contents: write; GitLab needs "api" or "write_repository").'
            : /non-fast-forward|rejected/i.test(stderr)
              ? 'The remote has commits you do not. Run git_sync (mode="pull") and re-run the tests before pushing again.'
              : undefined,
        });
      }

      registry().recordGit(w.id, 'push', `${remoteName}/${branch}`);
      audit({ action: 'git_push', workspace: w.alias, target: `${remoteName}/${branch}`, outcome: 'ok' });
      return join(`pushed ${branch} → ${remoteName}`, (res.stderr || res.stdout).trim());
    },
  },

  {
    name: 'git_sync',
    description: 'Fetch from the remote, or pull (rebasing by default) to bring the current branch up to date. Fetch is safe; pull can fail on conflicts, which are reported back to you.',
    capability: 'git_remote',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        mode: { type: 'string', enum: ['fetch', 'pull'], description: 'Default "fetch".' },
        rebase: { type: 'boolean', description: 'Pull with rebase instead of merge. Default true.' },
        remote: { type: 'string', description: 'Remote name. Default "origin".' },
      },
    },
    handler: async (args) => {
      const w = await repo(args);
      const mode = args.str('mode', 'fetch');
      const remoteName = args.str('remote', 'origin');
      const url = await originUrl(w.root);
      const credentials = url ? authConfig(url) : [];

      if (mode === 'fetch') {
        const res = await git(w.root, ['fetch', '--prune', remoteName], { allowFail: true, config: credentials, timeoutMs: 300_000 });
        const status = await getStatus(w.root);
        return join(
          res.ok ? `fetched from ${remoteName}` : `fetch failed: ${res.stderr.trim().split('\n')[0]}`,
          ...kv({ branch: status.branch, ahead: status.ahead, behind: status.behind }),
        );
      }

      if (mode !== 'pull') throw new BridgeError('INVALID_ARGUMENT', 'mode must be "fetch" or "pull".');

      const status = await getStatus(w.root);
      if (!status.clean) {
        throw new BridgeError('GIT_ERROR', 'Working tree is dirty; refusing to pull.', {
          hint: 'Commit your changes first — a pull with local modifications can conflict or silently mix work.',
        });
      }

      const res = await git(w.root, ['pull', args.bool('rebase', true) ? '--rebase' : '--no-rebase', remoteName], {
        allowFail: true,
        config: credentials,
        timeoutMs: 300_000,
      });
      registry().recordGit(w.id, 'pull', remoteName);
      if (!res.ok) {
        throw new BridgeError('GIT_ERROR', `Pull failed: ${(res.stderr || res.stdout).trim().split('\n').slice(0, 8).join('\n')}`, {
          hint: 'If this is a rebase conflict, resolve the files with edit_file, then run `git rebase --continue` via run_command.',
        });
      }
      return join(`pulled ${remoteName}`, (res.stdout || res.stderr).trim());
    },
  },

  {
    name: 'git_restore',
    description:
      'Discard changes to specific files, or unstage them. This destroys uncommitted work, so it requires confirm=true and specific paths — it will never discard everything at once.',
    capability: 'git_local',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        paths: { type: 'array', items: { type: 'string' }, description: 'Files to restore. Required.' },
        staged: { type: 'boolean', description: 'Unstage instead of discarding worktree changes. Default false.' },
        confirm: { type: 'boolean', description: 'Must be true — this discards uncommitted work.' },
      },
      required: ['paths', 'confirm'],
    },
    handler: async (args) => {
      const w = await repo(args);
      const paths = args.strArray('paths');
      if (paths.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'paths must list the files to restore.');
      if (!args.bool('confirm', false)) {
        throw new BridgeError('DESTRUCTIVE_BLOCKED', 'git_restore discards uncommitted work and needs confirm=true.');
      }

      // Warn when discarding a file this session never touched: it is the user's work.
      const touched = registry().changeLog(w.id).files;
      const foreign = paths.filter((p) => !(p in touched));

      const staged = args.bool('staged', false);
      const res = await git(w.root, staged ? ['restore', '--staged', '--', ...paths] : ['restore', '--', ...paths], { allowFail: true });
      if (!res.ok) {
        throw new BridgeError('GIT_ERROR', (res.stderr || res.stdout).trim().split('\n')[0] ?? 'restore failed');
      }

      registry().recordGit(w.id, staged ? 'unstage' : 'restore', paths.join(', '));
      audit({ action: 'git_restore', workspace: w.alias, target: paths.join(','), outcome: 'ok', detail: { staged } });
      return join(
        `${staged ? 'unstaged' : 'discarded changes in'} ${paths.length} file(s)`,
        foreign.length ? `NOTE: ${foreign.join(', ')} were not modified by this session — those were the user's own changes.` : '',
      );
    },
  },
];

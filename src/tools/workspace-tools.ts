/**
 * Workspace lifecycle tools — the entry point of every session.
 */
import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { audit } from '../logger.js';
import { parseRepoSpec } from '../forge/remote.js';
import { authConfig, currentBranch, git, defaultBranch } from '../git/git.js';
import { buildBrief } from '../workspace/brief.js';
import { registry } from '../workspace/registry.js';
import { block, bullets, join, kv, type ToolDef } from './types.js';

function idleDays(lastUsedAt: string): number {
  const ms = Date.now() - new Date(lastUsedAt).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
}

export const workspaceTools: ToolDef[] = [
  {
    name: 'workspace_list',
    description:
      'List repositories the bridge can open and which one is currently active. Call this first when you do not know what is available.',
    capability: 'read',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const reg = registry();
      const cfg = loadConfig();
      const roots = reg.configuredRoots();
      const open = reg.list();
      const active = reg.active();

      return join(
        block('CONFIGURED ROOTS (openable paths)', [
          ...bullets(roots.map((r) => `${r.alias} → ${r.path}${r.exists ? '' : ' [MISSING ON DISK]'}`)),
          roots.length === 0
            ? 'none — the operator must set REPO_BRIDGE_WORKSPACES to allow local repositories'
            : '',
        ]),
        block('OPEN WORKSPACES', [
          ...bullets(
            open.map((w) => {
              const idle = idleDays(w.lastUsedAt);
              // Managed clones accumulate silently; surface the stale ones so
              // they can be closed instead of quietly filling the disk.
              const stale = w.kind === 'managed' && idle >= 14 ? `  [idle ${idle}d — consider workspace_close]` : '';
              return (
                `${w.alias}${active?.id === w.id ? ' [ACTIVE]' : ''} — ${w.kind} — ${w.root}` +
                (w.remote ? ` (${w.remote.owner}/${w.remote.repo})` : '') +
                (w.task ? ` task=${w.task}` : '') +
                stale
              );
            }),
          ),
          open.length === 0 ? 'none' : '',
          'Each client keeps its own active workspace; [ACTIVE] is yours.',
        ]),
        block('REMOTE MODE', [
          ...kv({
            managed_workspace_root: cfg.managedRoot,
            github_token: cfg.forge.githubToken ? 'configured' : 'not configured',
            gitlab_token: cfg.forge.gitlabToken ? 'configured' : 'not configured',
          }),
          'Use repo_open_remote to clone a repository into an isolated managed workspace.',
        ]),
      );
    },
  },

  {
    name: 'workspace_open',
    description:
      'Open a local repository and return a full project brief: languages, build system, detected build/test/lint commands, module layout, git state, and the repo\'s AGENTS.md / CLAUDE.md instructions. Accepts an alias from workspace_list or an absolute path inside a configured root. Makes the workspace active for subsequent tool calls.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Alias (e.g. "quantix") or absolute path (e.g. "D:\\projects\\quantix").',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const target = args.str('path');
      const ws = registry().openLocal(target);
      audit({ action: 'workspace_open', workspace: ws.alias, target: ws.root, outcome: 'ok' });
      return buildBrief(ws, { includeInstructions: true });
    },
  },

  {
    name: 'workspace_info',
    description:
      'Current state of a workspace without re-reading the repository: branch, working-tree changes, recent commits, detected commands, and everything this bridge session has already changed. Use this to resume work ("continue on quantix").',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace alias. Defaults to the active workspace.' },
      },
    },
    handler: async (args) => {
      const ws = registry().require(args.optStr('workspace'));
      return buildBrief(ws, { includeInstructions: false });
    },
  },

  {
    name: 'repo_open_remote',
    description:
      'Clone (or refresh) a remote Git repository into an isolated managed workspace and check out a branch. Use for work on a repository that is not already on this machine. Returns the same project brief as workspace_open. Each task gets its own workspace so parallel tasks cannot interfere.',
    capability: 'read',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        repository: {
          type: 'string',
          description: 'github:owner/repo, gitlab:group/repo, https://host/owner/repo.git, or git@host:owner/repo.git',
        },
        branch: { type: 'string', description: 'Branch to check out. Default: the repository default branch.' },
        task: {
          type: 'string',
          description: 'Short task label (e.g. "drawdown-alerts"). Keeps concurrent tasks on the same repo isolated, and lets you reattach later.',
        },
        depth: { type: 'number', description: 'Shallow clone depth. Omit for a full clone (needed for diffs against the base branch).' },
      },
      required: ['repository'],
    },
    handler: async (args) => {
      const reg = registry();
      const spec = args.str('repository');
      const remote = parseRepoSpec(spec);
      const task = args.optStr('task');
      const wantedBranch = args.optStr('branch');
      const depth = args.optNum('depth');
      const started = Date.now();

      // Reattach to an existing managed workspace for the same repo+task.
      const existing = reg
        .list()
        .find(
          (w) =>
            w.kind === 'managed' &&
            w.remote?.host === remote.host &&
            w.remote.owner === remote.owner &&
            w.remote.repo === remote.repo &&
            (w.task ?? '') === (task ?? ''),
        );

      const credentials = authConfig(remote.cloneUrl);

      let ws;
      if (existing && fs.existsSync(existing.root)) {
        await git(existing.root, ['fetch', '--all', '--prune'], { allowFail: true, config: credentials });
        ws = reg.setActive(existing.alias);
        audit({ action: 'repo_reattach', workspace: ws.alias, target: `${remote.owner}/${remote.repo}`, outcome: 'ok' });
      } else {
        const dest = reg.managedPathFor(remote.repo, task);

        const cloneArgs = ['clone', '--no-single-branch'];
        if (depth) cloneArgs.push('--depth', String(Math.max(1, depth)));
        // The *clean* URL is what lands in .git/config; credentials are supplied
        // through url.<auth>.insteadOf for this invocation only.
        cloneArgs.push(remote.cloneUrl, dest);

        try {
          await git(process.cwd(), cloneArgs, { timeoutMs: 600_000, config: credentials });
        } catch (e) {
          audit({ action: 'repo_clone', target: `${remote.owner}/${remote.repo}`, outcome: 'error' });
          throw new BridgeError('GIT_ERROR', `Clone failed: ${(e as Error).message}`, {
            hint:
              credentials.length
                ? 'The configured token may lack read access to this repository.'
                : 'No token is configured for this host — private repositories need GITHUB_TOKEN or GITLAB_TOKEN in the bridge environment.',
          });
        }

        ws = reg.registerManaged(dest, remote, task);
        audit({
          action: 'repo_clone',
          workspace: ws.alias,
          target: `${remote.owner}/${remote.repo}`,
          outcome: 'ok',
          durationMs: Date.now() - started,
        });
      }

      const target = wantedBranch ?? (await defaultBranch(ws.root)) ?? undefined;
      if (target && (await currentBranch(ws.root)) !== target) {
        const checkout = await git(ws.root, ['checkout', target], { allowFail: true });
        if (!checkout.ok) {
          throw new BridgeError('GIT_ERROR', `Could not check out "${target}": ${checkout.stderr.trim().split('\n')[0]}`, {
            hint: 'Check the branch name, or omit `branch` to use the repository default.',
          });
        }
      }
      if (ws.remote) ws.remote.baseBranch = target ?? ws.remote.baseBranch;

      return buildBrief(ws, { includeInstructions: true });
    },
  },

  {
    name: 'workspace_close',
    description:
      'Stop tracking a workspace. For managed (cloned) workspaces you can also delete the directory to reclaim disk. Never deletes a local workspace\'s files.',
    capability: 'read',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace alias.' },
        delete_files: { type: 'boolean', description: 'Managed workspaces only: also remove the cloned directory. Default false.' },
      },
      required: ['workspace'],
    },
    handler: async (args) => {
      const alias = args.str('workspace');
      const deleteFiles = args.bool('delete_files', false);
      const result = registry().close(alias, deleteFiles);
      audit({ action: 'workspace_close', workspace: alias, outcome: 'ok', detail: { deleted: result.deleted } });
      return `Closed workspace "${result.alias}".${result.deleted ? ' Directory deleted.' : ''}`;
    },
  },
];

/**
 * Introspection tools.
 *
 * bridge_status lets the model discover its own limits instead of discovering
 * them by hitting an error mid-task; report_changes produces the end-of-task
 * summary a reviewer actually needs (what changed, what was verified, what is
 * still open) from recorded facts rather than from the model's recollection.
 */
import { loadConfig, describeLevel } from '../config.js';
import { describeAuthMode } from '../auth/index.js';
import { allowedCommands } from '../security/commands.js';
import { capabilityMatrix } from '../security/permissions.js';
import { forgeConfigured } from '../forge/forge.js';
import { currentBranch, getStatus, isGitRepo, log as gitLog, git } from '../git/git.js';
import { registry } from '../workspace/registry.js';
import { block, bullets, join, kv, type ToolDef } from './types.js';

export const statusTools: ToolDef[] = [
  {
    name: 'bridge_status',
    description:
      'What this bridge is allowed to do: permission level, which capabilities are enabled, which executables may run, timeouts and output limits, protected branches, and whether GitHub/GitLab tokens are configured. Check this when a tool is refused, or before planning work that needs to push.',
    capability: 'read',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const cfg = loadConfig();
      const reg = registry();
      const active = reg.active();
      const caps = capabilityMatrix(cfg.permission);

      return join(
        block('PERMISSION', [
          `level: ${cfg.permission}`,
          describeLevel(cfg.permission),
          ...Object.entries(caps).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`),
        ]),
        block('ACTIVE WORKSPACE', [
          ...(active
            ? kv({ alias: active.alias, root: active.root, kind: active.kind, task: active.task })
            : ['none — call workspace_open or repo_open_remote']),
        ]),
        block('EXECUTION', [
          ...kv({
            shell: cfg.exec.allowShell ? 'enabled (operator override)' : 'disabled — commands run as argv, no pipes/&&/redirects',
            timeout: `${Math.round(cfg.exec.timeoutMs / 1000)}s`,
            max_output: `${Math.round(cfg.exec.maxOutputBytes / 1024)} KB per stream (error lines preserved when truncated)`,
            denied: cfg.exec.deniedCommands,
          }),
          `allowed executables: ${allowedCommands({
            extraAllowed: cfg.exec.extraAllowedCommands,
            denied: cfg.exec.deniedCommands,
            allowShell: cfg.exec.allowShell,
          }).join(' ')}`,
        ]),
        block('TRANSPORT & AUTH', [
          ...kv({
            mode: cfg.mode,
            authentication: cfg.mode === 'stdio' ? 'stdio — inherited from the host process' : describeAuthMode(),
          }),
          'Authentication decides who may connect. It does NOT affect the permission level above.',
        ]),
        block('GIT & FORGE', [
          ...kv({
            protected_branches: cfg.git.protectedBranches,
            commit_author: `${cfg.git.authorName} <${cfg.git.authorEmail}>`,
            github_token: forgeConfigured('github') ? 'configured' : 'not configured',
            gitlab_token: forgeConfigured('gitlab') ? 'configured' : 'not configured',
          }),
        ]),
        block('SAFETY', [
          'Credential files (.env, *.pem, ~/.ssh, cloud config) are never returned by read/search tools.',
          'Paths are confined to the active workspace; symlinks leaving it are not followed.',
          'Destructive commands (force push, reset --hard, recursive delete, publish, prune) require confirm=true.',
          'Secrets are redacted from command output and logs.',
        ]),
      );
    },
  },

  {
    name: 'report_changes',
    description:
      'Summarise everything done in this workspace: files changed (with per-file line counts from git), commands run and whether they passed, git operations, current branch and commit state. Use this to write an accurate final report instead of relying on memory — and to see what is still uncommitted.',
    capability: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace alias. Defaults to the active workspace.' },
        against: { type: 'string', description: 'Compare against this ref for the file summary (e.g. "develop"). Default: HEAD (uncommitted changes only).' },
      },
    },
    handler: async (args) => {
      const reg = registry();
      const w = reg.require(args.optStr('workspace'));
      const changeLog = reg.changeLog(w.id);
      const against = args.optStr('against');

      let gitSection = '';
      if (isGitRepo(w.root)) {
        const status = await getStatus(w.root);
        const branch = await currentBranch(w.root);
        const stat = await git(w.root, ['diff', '--stat', against ? `${against}...HEAD` : 'HEAD'], { allowFail: true });
        const commits = against ? await gitLog(w.root, 20, `${against}..HEAD`) : [];

        gitSection = join(
          block('GIT', [
            ...kv({
              branch,
              upstream: status.upstream,
              ahead: status.ahead || undefined,
              working_tree: status.clean ? 'clean (everything committed)' : 'has uncommitted changes',
            }),
          ]),
          stat.stdout.trim() ? block(`CHANGED FILES (vs ${against ?? 'HEAD'})`, stat.stdout.trim().split('\n')) : '',
          commits.length ? block('COMMITS ON THIS BRANCH', bullets(commits.map((c) => `${c.shortHash} ${c.subject}`), 20)) : '',
          !status.clean
            ? block('STILL UNCOMMITTED', bullets([
                ...status.staged.map((f) => `staged   ${f.path}`),
                ...status.unstaged.map((f) => `modified ${f.path}`),
                ...status.untracked.map((p) => `new      ${p}`),
              ], 40))
            : '',
        );
      }

      const commands = changeLog.commands;
      const verification = commands.filter((c) => /test|build|lint|verify|check/i.test(c.command));

      return join(
        block('SESSION', kv({
          workspace: w.alias,
          root: w.root,
          task: w.task,
          started: changeLog.startedAt,
          files_touched_by_bridge: Object.keys(changeLog.files).length,
        })),
        Object.keys(changeLog.files).length
          ? block('FILES TOUCHED BY THIS SESSION', bullets(Object.entries(changeLog.files).map(([p, c]) => `${c.action.padEnd(8)} ${p}${c.count > 1 ? ` (${c.count} edits)` : ''}`), 60))
          : '',
        gitSection,
        verification.length
          ? block('VERIFICATION RUN', bullets(verification.map((c) => `${c.exitCode === 0 ? 'PASS' : `FAIL(${c.exitCode})`}  ${c.command}  [${c.durationMs}ms]`), 20))
          : block('VERIFICATION RUN', ['none — no build/test command was executed in this session']),
        commands.length
          ? block('ALL COMMANDS', bullets(commands.slice(-20).map((c) => `${c.exitCode === 0 ? 'ok  ' : `exit ${c.exitCode}`} ${c.command}`), 20))
          : '',
        changeLog.git.length ? block('GIT OPERATIONS', bullets(changeLog.git.map((g) => `${g.op}: ${g.detail}`), 20)) : '',
      );
    },
  },
];

/**
 * The project brief.
 *
 * One call should tell a coding agent everything it needs before touching code:
 * what the project is, how to build and test it, what the repo owner's standing
 * instructions are, where the working tree stands, and what the bridge already
 * changed in this task. Getting this right is what removes ten rounds of
 * exploratory file reads at the start of every session.
 */
import { detectProject } from './detect.js';
import { discoverInstructions, INSTRUCTION_TRUST_NOTE } from './instructions.js';
import { registry, type Workspace } from './registry.js';
import { block, bullets, join, kv } from '../tools/types.js';
import { currentBranch, getStatus, isGitRepo, log as gitLog, remotes, defaultBranch, isProtectedBranch } from '../git/git.js';
import { loadConfig } from '../config.js';
import { capabilityMatrix } from '../security/permissions.js';

export interface BriefOptions {
  /** Full instruction documents (workspace_open) vs. a listing (workspace_info). */
  includeInstructions?: boolean;
  commitLimit?: number;
}

export async function buildBrief(ws: Workspace, opts: BriefOptions = {}): Promise<string> {
  const cfg = loadConfig();
  const reg = registry();
  const profile = detectProject(ws.root);

  const header = block('WORKSPACE', [
    ...kv({
      alias: ws.alias,
      root: ws.root,
      kind: ws.kind,
      task: ws.task,
      remote: ws.remote ? `${ws.remote.provider}:${ws.remote.owner}/${ws.remote.repo}` : undefined,
      permission: cfg.permission,
    }),
    `capabilities: ${Object.entries(capabilityMatrix(cfg.permission))
      .map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`)
      .join(' ')}`,
  ]);

  const project = block('PROJECT', [
    ...kv({
      languages: profile.languages,
      build_systems: profile.buildSystems,
      package_manager: profile.packageManager,
      frameworks: profile.frameworks,
      test_frameworks: profile.testFrameworks,
      top_level_dirs: profile.layout,
      markers: profile.markers,
    }),
    ...(profile.modules.length
      ? [`modules (${profile.modules.length}): ${profile.modules.slice(0, 25).map((m) => m.path).join(', ')}`]
      : []),
    ...profile.notes.map((n) => `note: ${n}`),
  ]);

  const commands = block('COMMANDS (detected)', [
    ...kv({
      build: profile.build[0]?.command,
      test: profile.test[0]?.command,
      lint: profile.lint[0]?.command,
      typecheck: profile.typecheck[0]?.command,
      install: profile.install[0]?.command,
    }),
    profile.test.length > 1 ? `alternate test commands: ${profile.test.slice(1).map((c) => c.command).join(' | ')}` : '',
    'run_build / run_tests / run_lint use these automatically; pass a command to override.',
  ]);

  let gitSection = block('GIT', ['not a git repository']);
  if (isGitRepo(ws.root)) {
    try {
      const [status, branch, commits, rem, base] = await Promise.all([
        getStatus(ws.root),
        currentBranch(ws.root),
        gitLog(ws.root, opts.commitLimit ?? 8),
        remotes(ws.root),
        defaultBranch(ws.root),
      ]);
      const changed = [
        ...status.staged.map((f) => `${f.staged}  ${f.path} (staged)`),
        ...status.unstaged.map((f) => `${f.worktree}  ${f.path}`),
        ...status.untracked.map((p) => `?  ${p} (untracked)`),
      ];
      gitSection = block('GIT', [
        ...kv({
          branch: `${branch}${isProtectedBranch(branch) ? ' [PROTECTED — commit on a feature branch instead]' : ''}`,
          upstream: status.upstream,
          ahead: status.ahead || undefined,
          behind: status.behind || undefined,
          default_branch: base ?? undefined,
          remotes: rem.map((r) => `${r.name}=${r.url}`),
          working_tree: status.clean ? 'clean' : `${changed.length} changed file(s)`,
        }),
        ...(status.conflicted.length ? [`CONFLICTS: ${status.conflicted.join(', ')}`] : []),
        ...(changed.length ? ['changes:', ...bullets(changed, 30).map((b) => '  ' + b)] : []),
        'recent commits:',
        ...bullets(commits.map((c) => `${c.shortHash} ${c.subject} — ${c.author}`), 10).map((b) => '  ' + b),
      ]);
    } catch (e) {
      gitSection = block('GIT', [`unavailable: ${(e as Error).message}`]);
    }
  }

  // What this bridge session already did — the resume anchor.
  const changeLog = reg.changeLog(ws.id);
  const files = Object.entries(changeLog.files);
  const lastCommands = changeLog.commands.slice(-5);
  const session =
    files.length || lastCommands.length || changeLog.git.length
      ? block('THIS TASK SO FAR', [
          ...kv({ started: changeLog.startedAt, files_touched: files.length }),
          ...(files.length
            ? ['files:', ...bullets(files.map(([p, c]) => `${c.action} ${p}`), 25).map((b) => '  ' + b)]
            : []),
          ...(lastCommands.length
            ? [
                'recent commands:',
                ...bullets(
                  lastCommands.map((c) => `${c.exitCode === 0 ? 'ok  ' : `exit ${c.exitCode} `} ${c.command} (${c.durationMs}ms)`),
                  5,
                ).map((b) => '  ' + b),
              ]
            : []),
          ...(changeLog.git.length
            ? ['git operations:', ...bullets(changeLog.git.slice(-5).map((g) => `${g.op}: ${g.detail}`), 5).map((b) => '  ' + b)]
            : []),
        ])
      : '';

  let instructions = '';
  const docs = discoverInstructions(ws.root);
  if (docs.length) {
    if (opts.includeInstructions) {
      const bodies = docs
        .map((d) => `--- ${d.path} (${d.kind}) ---\n${d.content}`)
        .join('\n\n');
      instructions = `PROJECT INSTRUCTIONS\n  ${INSTRUCTION_TRUST_NOTE}\n\n${bodies}`;
    } else {
      instructions = block('PROJECT INSTRUCTIONS', [
        ...bullets(docs.map((d) => `${d.path} (${d.kind})`)),
        'read_file these before making significant changes.',
      ]);
    }
  }

  return join(header, project, commands, gitSection, session, instructions);
}

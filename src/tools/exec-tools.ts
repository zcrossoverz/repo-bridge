/**
 * Command execution tools.
 *
 * run_build / run_tests / run_lint exist as separate tools from run_command on
 * purpose: they resolve the right command from the detected project type, so the
 * model does not have to guess whether this repo uses `mvn test` or `./gradlew
 * test` or `pnpm vitest run`. That guess is where autonomous loops usually break.
 */
import path from 'node:path';
import { loadConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { audit } from '../logger.js';
import { formatExecResult, spawnArgv, type ExecResult } from '../exec/runner.js';
import { parseCommand } from '../security/commands.js';
import { resolvePath } from '../security/paths.js';
import { detectProject, type CommandSuggestion } from '../workspace/detect.js';
import { registry, type Workspace } from '../workspace/registry.js';
import { join, type ToolDef } from './types.js';

const workspaceParam = {
  workspace: { type: 'string', description: 'Workspace alias. Defaults to the active workspace.' },
};

function commandPolicy() {
  const cfg = loadConfig();
  return {
    extraAllowed: cfg.exec.extraAllowedCommands,
    denied: cfg.exec.deniedCommands,
    allowShell: cfg.exec.allowShell,
  };
}

async function execute(
  w: Workspace,
  commandLine: string,
  opts: { cwd?: string; timeoutSeconds?: number; confirm?: boolean; label: string },
): Promise<ExecResult> {
  const cfg = loadConfig();
  const parsed = parseCommand(commandLine, commandPolicy());

  if (parsed.destructive && !opts.confirm) {
    audit({ action: opts.label, workspace: w.alias, command: commandLine, outcome: 'blocked' });
    throw new BridgeError('DESTRUCTIVE_BLOCKED', `Blocked destructive command: ${parsed.destructive.reason}`, {
      hint:
        (parsed.destructive.safer ? `Safer alternative: ${parsed.destructive.safer}\n` : '') +
        'If this is genuinely intended, tell the user what it will do and re-run with confirm=true.',
      details: { rule: parsed.destructive.id },
    });
  }

  const cwd = opts.cwd ? resolvePath(w.root, opts.cwd, { mustExist: true }).abs : w.root;
  const timeoutMs = opts.timeoutSeconds
    ? Math.min(Math.max(1, opts.timeoutSeconds) * 1000, cfg.exec.timeoutMs)
    : cfg.exec.timeoutMs;

  const result = await spawnArgv(parsed.argv, {
    cwd,
    timeoutMs,
    maxOutputBytes: cfg.exec.maxOutputBytes,
  });

  registry().recordCommand(w.id, {
    command: result.command,
    cwd: path.relative(w.root, cwd).split(path.sep).join('/') || '.',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    at: new Date().toISOString(),
  });
  audit({
    action: opts.label,
    workspace: w.alias,
    command: result.command,
    outcome: result.ok ? 'ok' : 'error',
    durationMs: result.durationMs,
    detail: { exitCode: result.exitCode, timedOut: result.timedOut },
  });

  return result;
}

/** Lines that name a failing test or a compile error — pulled to the top of the report. */
const FAILURE_LINE =
  /(FAILED|FAIL\s|✗|×|\[ERROR\]|error:|error TS\d+|AssertionError|Tests run:.*Failures: [1-9]|Tests:.*failed|assertion failed|BUILD FAILURE|panic:|FAILURES!)/i;

function failureSummary(result: ExecResult, cap = 25): string {
  if (result.ok) return '';
  const lines = `${result.stdout}\n${result.stderr}`.split('\n');
  const hits = lines
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && FAILURE_LINE.test(l))
    .slice(0, cap);
  if (hits.length === 0) return '';
  return `FAILURE LINES (extracted)\n${hits.map((h) => '  ' + h).join('\n')}`;
}

function pickCommand(w: Workspace, kind: 'build' | 'test' | 'lint' | 'typecheck' | 'install'): CommandSuggestion {
  const profile = detectProject(w.root);
  const candidate = profile[kind][0];
  if (!candidate) {
    throw new BridgeError('INVALID_ARGUMENT', `No ${kind} command could be detected for this project.`, {
      hint:
        `Detected: languages=${profile.languages.join(',') || 'none'} build systems=${profile.buildSystems.join(',') || 'none'}.\n` +
        `Pass an explicit command, e.g. run_${kind === 'typecheck' ? 'command' : kind} with command="...".`,
    });
  }
  return candidate;
}

function presetTool(
  name: 'run_build' | 'run_tests' | 'run_lint',
  kind: 'build' | 'test' | 'lint',
  description: string,
): ToolDef {
  return {
    name,
    description,
    capability: 'exec',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        command: { type: 'string', description: `Override the detected ${kind} command.` },
        target: {
          type: 'string',
          description:
            kind === 'test'
              ? 'Optional test selector appended to the command (e.g. "-Dtest=PortfolioRiskServiceTest", "src/foo.test.ts").'
              : 'Optional extra arguments appended to the command.',
        },
        path: { type: 'string', description: 'Subdirectory (module) to run in. Defaults to the detected location.' },
        timeout_seconds: { type: 'number', description: 'Per-run timeout. Defaults to the bridge configuration.' },
      },
    },
    handler: async (args) => {
      const w = registry().require(args.optStr('workspace'));
      const explicit = args.optStr('command');
      const preset = explicit ? null : pickCommand(w, kind);
      const target = args.optStr('target');
      const commandLine = `${explicit ?? preset!.command}${target ? ' ' + target : ''}`;
      const cwd = args.optStr('path') ?? preset?.cwd ?? '.';

      const result = await execute(w, commandLine, {
        cwd,
        ...(args.optNum('timeout_seconds') !== undefined ? { timeoutSeconds: args.num('timeout_seconds', 0) } : {}),
        label: name,
      });

      return join(
        explicit ? '' : `resolved from: ${preset!.source}`,
        formatExecResult(result),
        failureSummary(result),
        !result.ok && kind === 'test'
          ? 'Next: read the failure lines above, use search_code/read_file to find the responsible code, apply edit_file, then run_tests again.'
          : '',
      );
    },
  };
}

export const execTools: ToolDef[] = [
  {
    name: 'run_command',
    description:
      'Run a development command in the workspace (build tools, package managers, test runners, git, language toolchains). Commands run WITHOUT a shell: pipes, redirects, && and ; are rejected — issue separate calls instead. Only allowlisted executables are permitted; destructive commands require confirm=true. Prefer run_build / run_tests / run_lint, which pick the right command for this project automatically.',
    capability: 'exec',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceParam,
        command: { type: 'string', description: 'Command line, e.g. "npm ci" or "mvn -B -Dtest=FooTest test".' },
        path: { type: 'string', description: 'Working directory relative to the workspace root. Default: the root.' },
        timeout_seconds: { type: 'number', description: 'Timeout for this command.' },
        confirm: {
          type: 'boolean',
          description: 'Required for commands the bridge classifies as destructive (force push, reset --hard, recursive delete, publish, prune).',
        },
      },
      required: ['command'],
    },
    handler: async (args) => {
      const w = registry().require(args.optStr('workspace'));
      const result = await execute(w, args.str('command'), {
        ...(args.optStr('path') !== undefined ? { cwd: args.str('path') } : {}),
        ...(args.optNum('timeout_seconds') !== undefined ? { timeoutSeconds: args.num('timeout_seconds', 0) } : {}),
        confirm: args.bool('confirm', false),
        label: 'run_command',
      });
      return join(formatExecResult(result), failureSummary(result));
    },
  },

  presetTool(
    'run_build',
    'build',
    'Build the project using the build command detected from the repository (Maven, Gradle, npm/pnpm/yarn script, cargo, go, dotnet, make…). Returns exit code and output with error lines preserved even when the log is long.',
  ),
  presetTool(
    'run_tests',
    'test',
    'Run the project test suite using the command detected from the repository. Failing output is summarised with the failure lines pulled out, so you can go straight from "tests failed" to the responsible code. This is the tool to use in an implement → test → fix loop.',
  ),
  presetTool(
    'run_lint',
    'lint',
    'Run the project linter / static checks using the command detected from the repository (eslint, ruff, clippy, go vet, spotless…).',
  ),
];

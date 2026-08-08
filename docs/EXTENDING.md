# Extending the bridge

## Architecture

```
src/
  index.ts              entry point, transport selection, signal handling
  config.ts             environment → Config. The only source of permissions.
  errors.ts             BridgeError taxonomy
  logger.ts             structured stderr/file logs + append-only audit trail

  auth/
    index.ts            the single gate every MCP request passes through
    oauth-server.ts     metadata, registration, authorize, token, revoke
    oauth-store.ts      clients, codes, hashed tokens, consent tickets

  security/
    paths.ts            workspace sandbox, real-path containment
    secrets.ts          credential-file denylist + output redaction
    permissions.ts      capability → required level
    commands.ts         tokeniser, executable allowlist, destructive rules

  workspace/
    registry.ts         open workspaces, active selection, change log (persisted)
    detect.ts           project type, build system, command resolution
    instructions.ts     AGENTS.md / CLAUDE.md discovery
    brief.ts            the project brief

  fs/
    ops.ts              read, write, anchor edits, move, delete
    search.ts           search_code / find_files (ripgrep + JS fallback)
    glob.ts             glob → RegExp
    gitignore.ts        gitignore matching

  exec/runner.ts        argv spawn, timeout, process-tree kill, smart truncation
  git/git.ts            git wrapper, porcelain v2 parsing, credential injection
  forge/                repository reference parsing, GitHub/GitLab REST

  tools/                MCP tool definitions, grouped by domain
    types.ts            ToolDef, Args accessor, text formatting helpers
    index.ts            registry, dispatch, permission filtering, instructions

  server/               MCP server, stdio and HTTP transports
```

Dependencies point downward: `tools/` uses everything, `security/` and `exec/` depend on nothing but `config` and `errors`. Keep it that way — the security layer must stay trivially auditable.

## Adding a tool

### 1. Write the definition

Tools live in `src/tools/<domain>-tools.ts` and export a `ToolDef[]`.

```ts
{
  name: 'run_migrations',
  description:
    'Apply pending database migrations using the project migration tool. Reports which migrations ran and any that failed.',
  capability: 'exec',
  sideEffecting: true,
  inputSchema: {
    type: 'object',
    properties: {
      workspace: { type: 'string', description: 'Workspace alias. Defaults to the active workspace.' },
      target:    { type: 'string', description: 'Migrate up to this version instead of the latest.' },
    },
  },
  handler: async (args) => {
    const w = registry().require(args.optStr('workspace'));
    const result = await spawnArgv(['npm', 'run', 'migrate'], {
      cwd: w.root,
      timeoutMs: loadConfig().exec.timeoutMs,
      maxOutputBytes: loadConfig().exec.maxOutputBytes,
    });
    return formatExecResult(result);
  },
}
```

### 2. Register it

Add the array to `ALL_TOOLS` in `src/tools/index.ts`. Permission filtering, dispatch, error translation, and audit logging are applied automatically.

### 3. Rules that are not optional

- **Never touch a model-supplied path without `resolvePath`.** It is the sandbox.
- **Never build a command string from model input and pass it to a shell.** Use `spawnArgv` with an argv array, or `parseCommand` if the model supplies the command line.
- **Pick the honest capability.** `read` for inspection, `write` for file changes, `exec` for running things, `git_remote` / `forge` for anything that leaves the machine.
- **Throw `BridgeError` with a hint.** The hint is the model's next action; "invalid argument" wastes a turn, "include more surrounding context to make the anchor unique" does not.
- **Record side effects** via `registry().recordFile/recordCommand/recordGit` so `report_changes` stays truthful.
- **Return text, not JSON.** Use the `block` / `kv` / `bullets` / `join` helpers from `tools/types.ts`.

### 4. Write the description for the model

The description is the only guidance the model gets about *when* to use the tool. Say what it does, when to prefer it over the alternative, and what it refuses. Compare:

> Runs tests.

> Run the project test suite using the command detected from the repository. Failing output is summarised with the failure lines pulled out, so you can go straight from "tests failed" to the responsible code. This is the tool to use in an implement → test → fix loop.

The second one changes behaviour.

## Adding project-type detection

`src/workspace/detect.ts` maps marker files to languages, build systems, and commands. To support a new stack, add a detector that pushes onto the profile:

```ts
if (exists(root, 'mix.exs')) {
  p.languages.push('elixir');
  p.buildSystems.push('mix');
  p.markers.push('mix.exs');
  p.build.push({ command: 'mix compile', cwd: '.', source: 'mix.exs' });
  p.test.push({ command: 'mix test', cwd: '.', source: 'mix.exs' });
}
```

Then allow the executable in `DEFAULT_ALLOWED` (`src/security/commands.ts`). Detection alone will not let it run — that separation is intentional.

## Adding a permission capability

1. Add it to `Capability` in `src/security/permissions.ts`.
2. Map it to a level in `REQUIRED`.
3. Add it to `capabilityMatrix` so `bridge_status` reports it.

## Where new integrations belong

Docker management, database inspection, CI/CD queries, Kubernetes logs, issue trackers: a new directory beside `forge/`, exposed through its own `tools/<domain>-tools.ts`. Do not thread them into the core — `security/`, `exec/` and `fs/` should not grow a dependency on an optional integration.

Anything that reaches the network needs its own capability and a token from configuration, never from a tool argument.

## Testing

```bash
npm run verify
```

- `src/test/*.test.ts` — unit tests on the compiled output (`node --test`). Security behaviour belongs here; every boundary should have a test that proves it refuses.
- `scripts/e2e.mjs` — drives a real repository through the MCP protocol. Add a step when you add a workflow.
- `scripts/http-check.mjs` — transport, auth, and permission filtering.

When you add a tool that can refuse, add the refusal to the e2e security section. The tests that matter most are the ones asserting something does *not* happen.

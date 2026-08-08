# repo-bridge

**Turn ChatGPT Web into a real coding agent on your own repositories — no OpenAI API key, no per-token API bill.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/zcrossoverz/repo-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/zcrossoverz/repo-bridge/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-2025--06--18-8A2BE2.svg)](https://modelcontextprotocol.io)
[![OAuth 2.1](https://img.shields.io/badge/auth-OAuth%202.1%20%2B%20PKCE-orange.svg)](docs/SECURITY.md)
[![Checks](https://img.shields.io/badge/checks-217%20passing-success.svg)](#verification)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org)

repo-bridge is an [MCP](https://modelcontextprotocol.io) server that gives ChatGPT — or Claude Code, Cursor, or any MCP client — real access to your codebase: read and search files, edit them, run builds and tests, drive git, push branches, open pull requests.

```
ChatGPT Web ──MCP/OAuth──► repo-bridge ──► filesystem · shell · git · GitHub/GitLab
```

**The bridge never calls an LLM API.** Reasoning stays in your ChatGPT session; the bridge is the execution layer. There is no `OPENAI_API_KEY`, no Codex/API metering, and no per-token charge added by this server — you use the ChatGPT plan you already have.

### What you need

| | Requirement |
|---|---|
| **ChatGPT plan** | **Plus or Pro.** Custom MCP connectors live behind Developer mode, which gives full MCP support — read *and* write tools. Business / Enterprise / Edu is in beta. **The free tier cannot add custom connectors,** so repo-bridge does not work there. |
| **Model** | Whatever your session runs. On paid plans that is GPT-5.6 Sol — OpenAI's strongest coding model, 272K context, with selectable Medium / High / Extra High reasoning. |
| **Cost** | The subscription you already pay for. No `OPENAI_API_KEY`, no Codex/API metering, no per-token charge from this bridge. Your plan's own rate limits still apply. |

repo-bridge is model-agnostic and contains no model logic of its own — when the model lineup changes, nothing here does.

> ChatGPT asks you to confirm write actions by default. Reading and searching flow freely; edits, commands and git operations surface a confirmation first — a second pair of eyes on top of the bridge's own permission level.

---

## What it feels like

> **You:** Open quantix, implement portfolio drawdown alerts following the existing risk-engine architecture, run the relevant tests and fix whatever fails. Then commit on a feature branch and open a PR to develop.

repo-bridge lets the model actually do it: inspect the project, search for the code that matters, edit it, run the test suite, read the failures, fix them, re-run until green, show you the diff, commit, push, and open the pull request.

No pasting code. No copying error messages back into chat. No "here's what you should write" — it writes it, in your repo, and proves it works.

---

## Why this exists

| | Copy-paste from ChatGPT | Cloud coding agents | **repo-bridge** |
|---|---|---|---|
| Reads your real repo | ✗ | ✓ | ✓ |
| Runs your build & tests | ✗ | ✓ | ✓ |
| Fixes its own failures | ✗ | ✓ | ✓ |
| Extra per-token API bill | ✗ | ✓ | **✗** |
| Code leaves your machine | — | ✓ | **✗** |
| You control what it can touch | — | ✗ | **✓** |

Your code stays on your machine (or your own VPS). The bridge only ever sees the arguments of the tool calls the model makes — never your conversation.

---

## Features

- **One-call project brief.** `workspace_open` returns languages, build system, the actual build/test/lint commands *for that repo*, module layout, git state, and your `AGENTS.md` / `CLAUDE.md` — so a session doesn't open with a dozen exploratory reads.
- **Autonomous test-fix loop.** `run_tests` resolves the right command (Maven, Gradle, npm/pnpm/yarn, pytest, cargo, go, dotnet, make…) and extracts the failure lines, so the model goes straight from "tests failed" to the responsible code.
- **Token-efficient editing.** Anchor-based `edit_file` replaces exact text instead of resending whole files — and fails loudly when the model's picture of a file is stale, instead of silently overwriting your work.
- **Local *and* remote Git.** Work on a repo already on disk, or clone a GitHub/GitLab repository into an isolated managed workspace per task.
- **Real git workflow.** Branch, diff, commit, push, and open pull requests / merge requests.
- **Session continuity.** "Continue working on quantix" resumes with branch, working-tree state, and everything the bridge changed — days later, in a new chat.
- **Language agnostic.** Java/Spring, Node/TypeScript, React/Next.js, Python, Go, Rust, .NET, Ruby, PHP, Flutter, Android, Docker — detected from the repository, nothing hardcoded.
- **Security you can explain.** Workspace sandbox, no shell, executable allowlist, credential files unreadable, protected branches, OAuth 2.1, full audit log.

---

## Quick start

Requires Node.js 22+ and git. [ripgrep](https://github.com/BurntSushi/ripgrep) is optional and speeds up search on large repos.

```bash
git clone https://github.com/zcrossoverz/repo-bridge.git && cd repo-bridge && npm install && npm run build
```

### With ChatGPT Web

```bash
cp .env.example .env
```

Generate the authorization passphrase, put it in `.env` as `REPO_BRIDGE_TOKEN`, set `REPO_BRIDGE_AUTH=oauth`, and list the repos you want reachable in `REPO_BRIDGE_WORKSPACES`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
npm run http
```

```bash
cloudflared tunnel --url http://127.0.0.1:8848
```

In ChatGPT: **Settings → Connectors → Advanced → Developer mode**, create a connector at `https://your-tunnel/mcp`, choose **OAuth**. Nothing to fill in — ChatGPT discovers the metadata, registers itself, and opens a browser page where you paste the passphrase once.

Full walkthrough: **[docs/CHATGPT.md](docs/CHATGPT.md)**

### With Claude Code, Cursor, or MCP Inspector

```bash
REPO_BRIDGE_WORKSPACES="demo=/path/to/project" node dist/index.js --stdio
```

---

## Authentication

`REPO_BRIDGE_AUTH` decides *who may connect*; `REPO_BRIDGE_PERMISSION` decides *what they may do*. They are independent — completing an OAuth flow never raises the permission level.

| Mode | Use for | How |
|---|---|---|
| **`oauth`** | **ChatGPT Web, production** | OAuth 2.1 + dynamic client registration + PKCE S256, per the MCP authorization spec |
| `path-token` | Dev tunnels, curl, MCP Inspector | Shared secret as a bearer header or `/mcp/<token>` |
| `none` | Loopback only | Refused on a public interface unless explicitly overridden |

ChatGPT's connector UI has **no field for a custom `Authorization` header** — OAuth is the supported path, and repo-bridge is its own authorization server so there is no third-party service to set up.

---

## Permission levels

The level is fixed at process start. Tools above it aren't even advertised to the model, so it can't try what it isn't allowed to do.

| Level | Grants |
|---|---|
| `read_only` | search, read files, inspect git |
| `edit` | + create, modify, move, delete files |
| `develop` *(default)* | + build, test, lint, approved commands, local git (branch, commit) |
| `full` | + push, pull/merge request creation |

---

## Tools

30 tools at `full` permission.

**Workspace** — `workspace_list` · `workspace_open` · `workspace_info` · `repo_open_remote` · `workspace_close`
**Files** — `list_dir` · `read_file` · `search_code` · `find_files` · `write_file` · `edit_file` · `move_path` · `delete_path` · `create_dir` · `file_info`
**Execution** — `run_command` · `run_build` · `run_tests` · `run_lint`
**Git** — `git_status` · `git_diff` · `git_log` · `git_branch` · `git_commit` · `git_push` · `git_sync` · `git_restore`
**Forge** — `create_pull_request`
**Introspection** — `bridge_status` · `report_changes`

Full reference: **[docs/TOOLS.md](docs/TOOLS.md)**

---

## Security

The bridge assumes the model will sometimes be wrong, and that repository content may be hostile. Full model: **[docs/SECURITY.md](docs/SECURITY.md)**

- **Authentication before anything else.** OAuth access tokens are opaque, stored only as hashes, audience-bound to this server's URL, expiring and revocable; refresh tokens rotate on use; consent forms are HMAC-signed against CSRF.
- **Workspace sandbox.** Confined to the configured roots. Traversal, absolute escapes and symlinks leading outside are rejected — checked against the resolved real path, not the string.
- **Credential files are unreadable.** `.env`, `*.pem`, SSH keys, cloud credentials, browser profiles — excluded from read *and* search. Commands still inherit real environment variables, so builds work without the model ever seeing the values.
- **No shell.** Commands are tokenised and spawned as argv. `;`, `&&`, `|`, backticks and `$( )` are rejected — so text arriving from a README, a dependency, or a build log cannot chain a second process. This is the main structural defence against prompt injection.
- **Executable allowlist.** Development toolchains only. Shells, `sudo`, `curl`/`wget`, `ssh`, registry and firewall tools are permanently blocked.
- **Destructive operations need `confirm=true`.** Force push, `reset --hard`, `git clean -fdx`, recursive delete, `npm publish`, `docker prune`.
- **Protected branches.** Commits and pushes to `main`/`master`/`develop`/`release/*` are refused; the agent uses a feature branch.
- **Audit trail.** Every tool call, file change, command and git operation is appended to `audit.log`, with secrets redacted.

---

## Verification

```bash
npm run verify
```

**217 checks, all passing** — on Linux and Windows, Node 22 and 24:

| Suite | Checks | What it proves |
|---|---|---|
| Unit | 94 | Sandbox escapes, command policy, secret redaction, patching, gitignore/glob, OAuth store semantics, per-caller workspace isolation |
| End-to-end | 51 | A real git repo driven **through the MCP protocol**: inspect → search → read → create a failing test → run (red) → fix → run (green) → build → diff → branch → commit → push to a real remote → report |
| HTTP + auth | 72 | Both auth modes, plus a full OAuth 2.1 flow: 401 challenge → metadata discovery → dynamic registration → consent → PKCE exchange → MCP over bearer → refresh → revoke — and two authorized clients keeping separate workspaces |

The suites assert the **refusals** too: reading `.env`, path traversal, command chaining, blocked binaries, committing to a protected branch, replayed authorization codes, wrong PKCE verifiers, foreign token audiences, unregistered redirect URIs.

Independently verified with the official MCP Inspector.

### Known limitations

- The OAuth flow is verified against the specification with a real HTTP client, not against ChatGPT's servers — confirming that end to end needs a public host and a ChatGPT account.
- The bridge is its own authorization server with a single shared passphrase. Fits a self-hosted single-operator tool; it is not multi-tenant.
- Each authenticated client keeps its own active workspace, but **several chats inside one ChatGPT connector share it** — MCP carries no conversation identity. Pass `workspace` explicitly, or give each task its own managed workspace, when running parallel work in one connector.
- Live pull-request creation isn't covered by automated tests (needs a real token and repository); the code path is exercised to the API boundary.
- `run_command` has no interactive stdin — use non-interactive flags.

---

## Deployment

| Shape | Notes |
|---|---|
| **Local machine** | Bridge next to your repos, exposed through a tunnel. Simplest; stops when the machine sleeps. |
| **VPS** | Bridge, repos and toolchain on a server — coding continues with your laptop closed. |
| **Docker** | `docker compose up -d --build`. Extend the image with your language toolchains. |

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for systemd/NSSM services, nginx and Caddy configs, and TLS.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/CHATGPT.md](docs/CHATGPT.md) | Connecting ChatGPT Web, OAuth, tunnels |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local, VPS, Docker, TLS, running as a service |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, boundaries, prompt injection, secrets |
| [docs/TOOLS.md](docs/TOOLS.md) | Every tool, its parameters, when to use it |
| [docs/EXTENDING.md](docs/EXTENDING.md) | Adding tools, architecture walkthrough |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms, causes, fixes |

---

## Architecture

```
src/
  index.ts            entry point; transport selection
  config.ts           environment configuration (the only source of permissions)
  context.ts          per-request caller identity, so clients stay isolated
  logger.ts           structured logs + append-only audit trail
  auth/               OAuth 2.1 server, token store, the single request gate
  security/           sandbox, secrets, capabilities, command policy
  workspace/          registry, project detection, instructions, project brief
  fs/                 file ops, search, glob, gitignore
  exec/               process runner (no shell, timeouts, smart truncation)
  git/                git wrapper, status parsing, credential injection
  forge/              repository refs, GitHub/GitLab REST
  tools/              MCP tool definitions grouped by domain
  server/             MCP server, stdio and HTTP transports
```

**One runtime dependency:** `@modelcontextprotocol/sdk`. Glob and gitignore matching are implemented in-tree — a process with filesystem and execution access should carry as little third-party code as practical.

---

## Contributing

Issues and pull requests welcome. Run `npm run verify` before opening one; if you add a tool that can refuse something, add the refusal to the end-to-end security checks — the tests that matter most are the ones asserting something *does not* happen.

## License

[MIT](LICENSE)

---

<sub>**Keywords:** MCP server · Model Context Protocol · ChatGPT MCP connector · ChatGPT coding agent · GPT-5.6 · GPT-5.6 Sol · GPT-5.6 Luna · AI coding assistant · autonomous coding agent · Claude Code alternative · Codex alternative · Cursor alternative · self-hosted AI developer tools · OAuth 2.1 MCP authorization · MCP dynamic client registration · PKCE · agentic coding · AI pair programming · code generation · automated testing · git automation · GitHub pull request automation · developer tools · TypeScript · Node.js · no API key required</sub>

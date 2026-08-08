# Troubleshooting

Start here: `bridge_status` reports the permission level, the active workspace, allowed executables, timeouts, and whether forge tokens are configured. Most confusion resolves in one call.

Then the audit log — `<data dir>/audit.log`, default `~/.repo-bridge/audit.log`:

```bash
grep '"outcome":"blocked"' ~/.repo-bridge/audit.log | tail -20
```

---

## Startup

**`HTTP mode needs an authentication mode`**
Set `REPO_BRIDGE_AUTH` to `oauth` (ChatGPT Web), `path-token` (development), or `none` (loopback only).

**`REPO_BRIDGE_AUTH=oauth requires REPO_BRIDGE_TOKEN`**
In OAuth mode the token is the passphrase you type on the consent screen. Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Minimum 24 characters.

**`Refusing to expose an unauthenticated MCP server on 0.0.0.0`**
`auth=none` is only allowed on loopback. Switch to `oauth`, bind to `127.0.0.1`, or — knowing it exposes file writes and command execution — set `REPO_BRIDGE_ALLOW_INSECURE=true`.

**`no workspace roots configured` (warning)**
`REPO_BRIDGE_WORKSPACES` is empty, so only `repo_open_remote` will work. Set `alias=path` entries separated by `;`.

**The server starts but stdio clients see nothing**
Something wrote to stdout, which corrupts the protocol stream. All bridge logging goes to stderr; if you added code, use `log.*`, never `console.log`.

---

## Connecting

**ChatGPT reports it cannot reach the server**
Check in order: `curl https://your-host/health` from outside your network; the URL ends in `/mcp`; the tunnel is running; `REPO_BRIDGE_AUTH=oauth`.

**ChatGPT's connector UI has no field for my token**
Correct — it does not have one. That is why OAuth exists. Set `REPO_BRIDGE_AUTH=oauth` and choose OAuth in the connector; you will be sent to a browser page to approve once.

**I cannot find Developer mode / cannot create a connector**
Custom MCP connectors require a **Plus or Pro** plan (Business / Enterprise / Edu is in beta). The free tier cannot add them. There is no workaround on the bridge side — use stdio with a local client instead.

**ChatGPT does not start the OAuth flow / "could not discover authorization"**
The bridge must be reachable over **HTTPS** and must advertise the same origin the client used. Check discovery by hand:

```bash
curl -s https://your-host/.well-known/oauth-protected-resource
```

The `resource` field must be exactly `https://your-host/mcp`. If it shows `http://` or an internal hostname, your proxy is not forwarding `X-Forwarded-Proto`/`X-Forwarded-Host` — set `REPO_BRIDGE_PUBLIC_URL=https://your-host` explicitly.

**The consent page rejects my passphrase**
It is the value of `REPO_BRIDGE_TOKEN` on the bridge host — not a GitHub token, not the tunnel URL. After 10 wrong attempts an IP is locked out for 15 minutes.

**`Authorization request expired`**
The consent page is valid for 10 minutes and for one authorization request. Start the connection again from ChatGPT.

**It worked yesterday, now everything is 401**
Your tunnel hostname changed. Tokens are bound to the resource URL they were issued for, so a new URL invalidates them by design. Use a named tunnel with a stable hostname and set `REPO_BRIDGE_PUBLIC_URL`, then re-authorize once.

**`invalid_token` after about an hour**
Access tokens are short-lived and the client is expected to refresh. If a client does not refresh, remove and re-add the connector. `REPO_BRIDGE_OAUTH_ACCESS_TTL` tunes the lifetime.

**401 Unauthorized in path-token mode**
Token mismatch. Compare `REPO_BRIDGE_TOKEN` with what the client sends — a trailing newline from a copy-paste is the usual cause. If the client cannot set headers, use `https://host/mcp/<token>`.

**How do I revoke access?**
Delete `oauth.json` from the data directory and restart: all clients and tokens are dropped and must re-authorize. To lock everything out instead, change `REPO_BRIDGE_TOKEN`.

**405 Method Not Allowed on GET /mcp**
Expected. The endpoint is stateless and only answers POST; clients that open an SSE stream first fall back automatically.

**Tools are missing from the list**
Permission filtering. `git_push` and `create_pull_request` require `full`; `run_*` require `develop`. `bridge_status` shows the current level.

**Requests time out during builds**
Your proxy's read timeout is shorter than the command. Raise `proxy_read_timeout` (nginx) or the equivalent, and keep `REPO_BRIDGE_EXEC_TIMEOUT_MS` below it.

---

## Workspaces

**`"…" is not inside any configured workspace root`**
Only paths under `REPO_BRIDGE_WORKSPACES` can be opened. Add the root and restart — this cannot be changed at runtime, by design.

**`No workspace is open`**
Call `workspace_open` (local) or `repo_open_remote` (Git URL) first. `workspace_list` shows what is available.

**Clone fails with authentication errors**
Private repositories need `GITHUB_TOKEN` (scope `repo`, or fine-grained Contents + Pull requests: write) or `GITLAB_TOKEN` (scope `api`) in the bridge environment — not in the repository.

**Managed workspaces are filling the disk**
`workspace_close` with `delete_files=true`, or clear `REPO_BRIDGE_MANAGED_ROOT` while the bridge is stopped.

---

## Files

**`[SECRET_BLOCKED] Refusing to expose credential file`**
Working as intended: `.env`, keys, and cloud credentials are never returned. Commands still inherit the real environment, so builds work without the model seeing values. If a non-secret file is caught by the pattern, rename it or narrow `REPO_BRIDGE_SECRET_PATTERNS`.

**`[PATH_OUTSIDE_WORKSPACE]`**
The path escaped the workspace — traversal, an absolute path elsewhere, or a symlink leading out. Use paths relative to the workspace root.

**`[PATCH_FAILED] old_string not found`**
The file changed since it was read, or the anchor's whitespace differs. The error says which; re-read the region and copy the exact characters. Do not copy from `read_file` output that used `line_numbers=true`.

**`old_string appears N times`**
Include more surrounding context to make the anchor unique, or set `replace_all=true`.

---

## Commands

**`[COMMAND_BLOCKED] Shell metacharacter "&" is not allowed`**
Commands run without a shell. Split `a && b` into two calls. Pipes and redirects are unavailable by design — see [SECURITY.md](SECURITY.md).

**`"x" is not in the allowed command list`**
Add it: `REPO_BRIDGE_ALLOW_COMMANDS=x`. Shells, `sudo`, `curl` and similar are permanently blocked and cannot be re-enabled.

**`Executable not found: npm`**
`npm` is not on the PATH of the bridge process. Services often have a minimal PATH — set it explicitly in the unit file, or use absolute paths in `REPO_BRIDGE_ALLOW_COMMANDS`-listed wrappers. On Windows the bridge prefers `npm.cmd` over the extension-less script automatically.

**`[DESTRUCTIVE_BLOCKED]`**
Force push, `reset --hard`, recursive delete, publish, prune. Re-run with `confirm=true` if it really is intended — after telling the user what it will do.

**A command hangs until the timeout**
It is waiting for input. There is no interactive stdin; use non-interactive flags (`npm ci` rather than `npm install` prompts, `-B` for Maven, `--yes` where offered).

**Output is truncated**
Expected on long logs; head, tail, and error-matching lines are preserved. Raise `REPO_BRIDGE_MAX_OUTPUT_BYTES` if you need more, or run a narrower target.

---

## Git

**`[PROTECTED_BRANCH] Refusing to commit on protected branch "main"`**
Create a feature branch: `git_branch` with `create=true`. Adjust `REPO_BRIDGE_PROTECTED_BRANCHES` if your conventions differ.

**`Working tree has uncommitted changes; refusing to switch branches`**
Commit first, or create a new branch from here (which carries the changes across).

**Push rejected, non-fast-forward**
The remote moved. `git_sync` with `mode="pull"`, re-run the tests, push again.

**Push fails with 403**
The token lacks write access. GitHub fine-grained tokens need Contents: write; GitLab needs `api` or `write_repository`.

**`Pull requests are not supported for host "local"`**
The remote is a filesystem path, not GitHub or GitLab. The branch is pushed; open the request manually.

**`422` from GitHub when creating a PR**
Usually the head branch has no commits ahead of base, or a request already exists — the bridge returns the existing one instead of duplicating it.

---

## Performance

**Search is slow on a large monorepo**
Install [ripgrep](https://github.com/BurntSushi/ripgrep); the bridge uses it automatically and falls back to a JavaScript walker otherwise. Narrowing with `include` globs and `path` also helps.

**Sessions feel expensive in tokens**
Search before reading, read line ranges rather than whole files, prefer `edit_file` over `write_file`, and use `stat_only=true` on large diffs.

---

## Diagnosing anything else

```bash
REPO_BRIDGE_LOG_LEVEL=debug node dist/index.js --http
```

Reproduce a tool call directly against a running server:

In `path-token` mode you can call the endpoint directly:

```bash
curl -s http://127.0.0.1:8848/mcp -H "Authorization: Bearer $REPO_BRIDGE_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

In `oauth` mode, check the discovery documents instead — they are public:

```bash
curl -s http://127.0.0.1:8848/.well-known/oauth-authorization-server
```

Or verify with the official MCP Inspector:

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8848/mcp --transport http --method tools/list --header "Authorization: Bearer $REPO_BRIDGE_TOKEN"
```

Confirm the build itself is sound:

```bash
npm run verify
```

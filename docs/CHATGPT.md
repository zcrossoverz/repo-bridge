# Connecting ChatGPT Web

ChatGPT reaches the bridge over HTTPS and authenticates with **OAuth**. The repository stays on your machine (or your VPS); only MCP tool calls cross the network.

```
ChatGPT Web ──https──► tunnel / reverse proxy ──► repo-bridge ──► your repositories
```

> **Why OAuth and not a token?** ChatGPT's connector UI has no field for a custom `Authorization` header, so a shared bearer token cannot be configured there. OAuth is what the MCP authorization spec defines and what ChatGPT implements: it discovers the bridge's metadata, registers itself, and sends you to a browser page to approve once.

## 1. Configure the bridge

```bash
cp .env.example .env
```

Generate the passphrase you will type on the consent screen:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`.env`:

```bash
REPO_BRIDGE_MODE=http
REPO_BRIDGE_HOST=127.0.0.1
REPO_BRIDGE_PORT=8848
REPO_BRIDGE_AUTH=oauth
REPO_BRIDGE_TOKEN=<the generated value>
REPO_BRIDGE_PERMISSION=develop
REPO_BRIDGE_WORKSPACES=quantix=D:\projects\quantix
```

Start it:

```bash
npm run http
```

Check it locally before exposing anything:

```bash
curl http://127.0.0.1:8848/health
```

## 2. Expose it over HTTPS

ChatGPT needs a public HTTPS URL, and OAuth requires it: the spec mandates HTTPS for every authorization endpoint. Do **not** publish port 8848 directly.

### Cloudflare Tunnel (recommended)

```bash
cloudflared tunnel --url http://127.0.0.1:8848
```

It prints a `https://<random>.trycloudflare.com` URL. For daily use create a named tunnel so the hostname is stable — a quick tunnel changes on every restart, and every change means re-authorising the connector:

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create repo-bridge
```

```bash
cloudflared tunnel route dns repo-bridge bridge.example.com
```

```bash
cloudflared tunnel run --url http://127.0.0.1:8848 repo-bridge
```

With a stable hostname, pin it so OAuth metadata always advertises the right origin:

```bash
REPO_BRIDGE_PUBLIC_URL=https://bridge.example.com
```

Alternatives: `ngrok http 8848`, or your own reverse proxy — see [DEPLOYMENT.md](DEPLOYMENT.md).

## 3. Add the connector in ChatGPT

1. **Settings → Connectors → Advanced → Developer mode** (enable it).
2. **Create** a connector.
3. **MCP Server URL**: `https://bridge.example.com/mcp` — note the `/mcp` path.
4. **Authentication**: choose **OAuth**. There is nothing to fill in — no client ID, no secret, no header. ChatGPT discovers everything from the bridge and registers itself automatically.
5. Save. ChatGPT opens a **repo-bridge authorization page** in your browser showing which client is asking, where it redirects, and the permission level it will get.
6. Paste your `REPO_BRIDGE_TOKEN` into the passphrase field and click **Authorize**.
7. ChatGPT completes the exchange and lists the discovered tools.

**Developer mode is required**, and it needs a **Plus or Pro** plan (Business / Enterprise / Edu is in beta). The free tier cannot add custom connectors at all. Without Developer mode the connector experience only exposes search-and-fetch style tools, which is not enough to edit and build code.

ChatGPT asks for confirmation before running write actions by default. Reading and searching run freely; `edit_file`, `run_command` and the git tools will surface a prompt first. That is on top of the bridge's own permission level — both have to allow an action for it to happen.

### What happens under the hood

```
ChatGPT                          repo-bridge
   │  POST /mcp (no token)            │
   │◄─── 401 + WWW-Authenticate ──────┤   points at the metadata document
   │  GET /.well-known/oauth-protected-resource
   │◄─── resource + authorization server
   │  GET /.well-known/oauth-authorization-server
   │◄─── endpoints, PKCE S256, DCR
   │  POST /oauth/register            │   dynamic client registration
   │◄─── client_id                    │
   │  browser → GET /oauth/authorize  │   you approve with the passphrase
   │◄─── redirect with code           │
   │  POST /oauth/token + PKCE verifier
   │◄─── access + refresh token       │
   │  POST /mcp  Authorization: Bearer …
   │◄─── tools                        │
```

Access tokens last an hour and refresh silently; the refresh token rotates each time. You only see the consent page again if you revoke access or the bridge's state directory is wiped.

## 4. Use it

Start a chat with the connector enabled.

```
List my workspaces.
```

```
Open quantix and give me the project brief.
```

From there, describe outcomes rather than steps:

```
Implement portfolio-level risk alerts following the existing risk engine
architecture. Run the relevant tests and fix whatever fails. Don't push yet.
```

The model will search, read, edit, run the tests, read the failures, fix, and re-run. When you are happy:

```
Looks good. Commit it on a feature branch and open a PR to develop.
```

Committing and pushing need `REPO_BRIDGE_PERMISSION=full` and a `GITHUB_TOKEN` (or `GITLAB_TOKEN`) in the bridge environment.

**Authorizing does not grant permission.** OAuth decides *who may connect*; `REPO_BRIDGE_PERMISSION` decides *what they may do*. A successfully authorized connector at `develop` still cannot push — the tools are not even advertised to it.

## Working across sessions

Bridge state lives on disk, so a new chat can pick up where the last one stopped:

```
Continue working on quantix.
```

The model calls `workspace_info`, which reports the branch, working-tree state, recent commits, files this bridge changed, and the commands it ran — without re-reading the repository.

## Development fallback: path-token

For a quick throwaway tunnel, or for clients that *can* set headers (curl, MCP Inspector, Claude Code over HTTP), there is a simpler mode:

```bash
REPO_BRIDGE_AUTH=path-token
REPO_BRIDGE_TOKEN=<32+ char secret>
```

The token then goes either in a header or in the URL:

```
Authorization: Bearer <token>
https://xxx.trycloudflare.com/mcp/<token>
```

Some ChatGPT builds accept the second form with Authentication set to *None*, since the bridge still verifies the token itself.

**Treat this as development only.** The secret sits in the URL, which means it lands in proxy logs, browser history, and referrer headers; it never expires; and it cannot be revoked per client. A `trycloudflare` quick tunnel plus a path token is fine for ten minutes of testing and wrong for anything you leave running. Use OAuth for real work.

## Notes and limits

- The bridge is **stateless over HTTP**: every request is authenticated on its own, so reconnects — which ChatGPT does routinely — cost nothing.
- **Long commands.** A full Maven build can exceed a connector's patience even though the bridge waits up to `REPO_BRIDGE_EXEC_TIMEOUT_MS`. Ask for a targeted test (`run_tests` with a `target`) during the loop and a full build at the end.
- **One bridge, many chats.** Concurrent chats share the same active workspace. Pass `workspace` explicitly, or use `repo_open_remote` with a distinct `task` label to keep parallel work isolated.
- **The bridge does not read your ChatGPT conversation.** It only ever sees the arguments of the tool calls the model makes.
- **Changing the public hostname invalidates the connector.** OAuth tokens are bound to the resource URL they were issued for, so a new tunnel URL means re-authorising. That is the audience check doing its job.

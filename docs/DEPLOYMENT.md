# Deployment

Three shapes, in increasing order of independence from your desktop.

## A. Local machine

The bridge runs beside your repositories; a tunnel exposes it to ChatGPT.

```
ChatGPT Web ──► Cloudflare Tunnel ──► 127.0.0.1:8848 ──► your repositories
```

```bash
npm install && npm run build
```

```bash
cp .env.example .env      # set REPO_BRIDGE_AUTH, REPO_BRIDGE_TOKEN, REPO_BRIDGE_WORKSPACES
```

```bash
npm run http
```

```bash
cloudflared tunnel --url http://127.0.0.1:8848
```

Simplest to set up, and your code never leaves the machine. The catch: coding stops when the machine sleeps.

### Running it as a service

**Windows** — with [NSSM](https://nssm.cc/):

```powershell
nssm install repo-bridge "C:\Program Files\nodejs\node.exe" "E:\path\to\repo-bridge\dist\index.js --http"
nssm set repo-bridge AppDirectory "E:\path\to\repo-bridge"
nssm set repo-bridge AppEnvironmentExtra REPO_BRIDGE_TOKEN=... REPO_BRIDGE_WORKSPACES=quantix=D:\projects\quantix
nssm start repo-bridge
```

**macOS / Linux** — systemd user service at `~/.config/systemd/user/repo-bridge.service`:

```ini
[Unit]
Description=repo-bridge MCP server
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/repo-bridge
EnvironmentFile=%h/repo-bridge/.env
ExecStart=/usr/bin/node dist/index.js --http
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now repo-bridge
loginctl enable-linger $USER      # keep it running after logout
```

## B. Development VPS

The bridge, the repositories, and the build toolchain all live on a server, so work continues with your laptop closed.

```
ChatGPT Web ──► https://bridge.example.com ──► VPS ──► clones + build/test environment
```

Sensible for this shape:

- `REPO_BRIDGE_AUTH=oauth` and `REPO_BRIDGE_PUBLIC_URL=https://bridge.example.com` — a stable hostname means you authorize once instead of after every restart
- `REPO_BRIDGE_MODE=http`, `REPO_BRIDGE_HOST=127.0.0.1` — bind to loopback, let the proxy face the internet
- `GITHUB_TOKEN` / `GITLAB_TOKEN` set, so `repo_open_remote` can clone private repositories
- Run as a dedicated unprivileged user
- Install the toolchains your repositories need (JDK, Maven, Python, …); the bridge discovers them from PATH

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name bridge.example.com;

    ssl_certificate     /etc/letsencrypt/live/bridge.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.example.com/privkey.pem;

    # Everything: /mcp, /health, and — for OAuth — /.well-known/* and /oauth/*.
    # Proxying only /mcp breaks discovery, and the client never gets past 401.
    location / {
        proxy_pass http://127.0.0.1:8848;
        proxy_http_version 1.1;

        # OAuth metadata must advertise the public origin. Without these headers
        # the bridge advertises http://127.0.0.1:8848 and discovery fails.
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;

        # Builds and test suites take minutes. Without these the proxy gives up
        # long before the bridge does.
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
        proxy_buffering off;
    }
}
```

### Caddy

```
bridge.example.com {
    reverse_proxy 127.0.0.1:8848 {
        transport http {
            read_timeout 900s
        }
    }
}
```

Caddy gets certificates automatically and sets `X-Forwarded-Proto`/`X-Forwarded-Host` for you. Proxy the whole host, not just `/mcp` — OAuth discovery lives at `/.well-known/*` and the flow at `/oauth/*`.

Belt and braces, in `.env`:

```bash
REPO_BRIDGE_PUBLIC_URL=https://bridge.example.com
```

## C. Docker

```bash
cp .env.example .env      # set REPO_BRIDGE_TOKEN
docker compose up -d --build
curl http://127.0.0.1:8848/health
```

The compose file publishes only to loopback; put a tunnel or reverse proxy in front.

To work on repositories that live on the host, mount them and declare the alias:

```yaml
volumes:
  - /srv/projects:/repos
environment:
  REPO_BRIDGE_WORKSPACES: "quantix=/repos/quantix;api=/repos/api"
```

Paths in `REPO_BRIDGE_WORKSPACES` are **container** paths.

### Toolchains in the container

The base image ships git and ripgrep only. Extend it for your stack:

```dockerfile
FROM repo-bridge:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-21-jdk-headless maven \
 && rm -rf /var/lib/apt/lists/*
USER bridge
```

The bridge detects the build system from the repository, so anything on PATH and on the allowlist becomes usable immediately.

Container isolation is a real second layer here: even a sandbox escape lands inside a container with no privileges, `no-new-privileges`, and only the volumes you mounted.

### Persistence

Two volumes: `/data` (workspace registry, session change logs, `audit.log`, and `oauth.json` with registered clients and hashed tokens) and `/workspaces` (managed clones). Keep both if you want tasks — and an authorized ChatGPT connector — to survive a restart.

## Choosing a permission level

| Situation | Level |
|---|---|
| Trying it out, or reviewing an unfamiliar codebase | `read_only` |
| Drafting changes you will build and run yourself | `edit` |
| Everyday work — the agent builds and tests its own changes | `develop` |
| You want it to commit, push, and open pull requests | `full` |

`develop` is the default and the right starting point.

## Operating notes

- **Rotate the secret** by changing `REPO_BRIDGE_TOKEN` and restarting. In `path-token` mode every client is locked out immediately; in `oauth` mode existing tokens keep working (they are independent of the passphrase) but no new client can be authorized. To cut off issued OAuth tokens as well, delete `oauth.json` from the data directory.
- **Watch the audit log**: `tail -f ~/.repo-bridge/audit.log` (or `/data/audit.log` in Docker).
- **Managed clones accumulate.** `workspace_close` with `delete_files=true` reclaims disk; the directory is `REPO_BRIDGE_MANAGED_ROOT`.
- **Timeouts**: `REPO_BRIDGE_EXEC_TIMEOUT_MS` must be under your proxy's read timeout, or the proxy will cut a build the bridge would have finished.
- **Upgrades**: `git pull && npm install && npm run build && npm run verify`, then restart. State in the data directory is forward-compatible and re-created if absent.

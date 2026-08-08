# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-08-09

### Added

- **CLI surface.** `--help` and `--version` now work. Previously both silently started a stdio server and hung, which as a published `npx` package meant the first thing a new user tried appeared to be broken.
- **Operator commands for OAuth access.** `repo-bridge clients` lists authorised clients with their redirect URIs and live token counts; `repo-bridge revoke <client-id>` removes one and all its tokens. Revoking a single connector previously meant deleting the whole state file. These are CLI commands, not MCP tools, so a model cannot grant or withdraw its own credentials.
- **Release workflow** using npm Trusted Publishing (OIDC) with provenance attestations — no publish token exists to leak, and the tarball is verifiably built from the public commit.
- **Stale managed workspaces** are flagged in `workspace_list` with their idle time, so clones stop accumulating unnoticed.

### Fixed

- **Concurrent bridge processes lost each other's state.** Two processes sharing a data directory each held their own copy of `state.json` / `oauth.json`, so the second to write discarded the first's work — a registered workspace or an issued token would simply vanish. Mutations now run under a cross-process lock and start from what is on disk. Stale locks from a crashed process are broken rather than waited on. Proven by a test that spawns real concurrent processes and fails without the lock.
- **Atomic writes failed intermittently on Windows.** Replacing a file with `write temp + rename` fails with `EPERM` whenever anything holds a handle to the destination — another process, the user's editor, an antivirus scanner, the search indexer. The handle is released within milliseconds, so the rename is now retried with a short backoff. This affected `edit_file` and `write_file`, not just internal state: the file a coding agent edits is usually the one the user has open. Found by the new concurrency test, which surfaced it as a real failure rather than a rare mystery bug in the field.
- The version number is read from `package.json` instead of being duplicated as a constant, so `--version` and the MCP handshake cannot drift apart.

## [1.0.0] — 2026-08-08

First release.

### Added

**MCP tool surface** — 30 tools across five domains:
- Workspace: `workspace_list`, `workspace_open`, `workspace_info`, `repo_open_remote`, `workspace_close`
- Files: `list_dir`, `read_file`, `search_code`, `find_files`, `write_file`, `edit_file`, `move_path`, `delete_path`, `create_dir`, `file_info`
- Execution: `run_command`, `run_build`, `run_tests`, `run_lint`
- Git: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit`, `git_push`, `git_sync`, `git_restore`
- Forge and introspection: `create_pull_request`, `bridge_status`, `report_changes`

**Project understanding** — `workspace_open` returns a single brief with languages, build system, the build/test/lint commands resolved for that repository, module layout, git state, and the repo's `AGENTS.md` / `CLAUDE.md`. Detection covers Node, Java (Maven/Gradle), Python, Go, Rust, .NET, Ruby, PHP, Dart/Flutter, Make and Docker Compose.

**Remote Git mode** — clone a GitHub or GitLab repository into an isolated managed workspace per task, with reattachment when a later session continues the same work.

**Transports** — stdio for local MCP clients; stateless Streamable HTTP for remote clients.

**Authentication** — three modes selected by `REPO_BRIDGE_AUTH`:
- `oauth`: a full OAuth 2.1 authorization server implementing RFC 9728 protected resource metadata, RFC 8414 authorization server metadata, RFC 7591 dynamic client registration, RFC 8707 resource indicators and RFC 7009 revocation, with mandatory PKCE S256. This is the mode ChatGPT Web uses.
- `path-token`: shared secret in a bearer header or the URL path, for development tunnels and local tooling.
- `none`: loopback only, refused on a public interface without an explicit override.

**Security boundaries** — workspace sandbox checked against resolved real paths; credential files excluded from read and search; commands tokenised and spawned without a shell; executable allowlist; destructive operations gated behind `confirm=true`; protected branches; secret redaction in output and logs; append-only audit log.

**Permission levels** — `read_only`, `edit`, `develop`, `full`. Fixed at process start; tools above the level are not advertised.

**Verification** — 217 automated checks: unit tests, an end-to-end run driving a real repository through the MCP protocol, and an HTTP/auth suite covering both auth modes and a complete OAuth flow. CI runs them on Linux and Windows against Node 22 and 24, and builds the Docker image.

**Deployment** — Dockerfile and compose file, systemd and NSSM service examples, nginx and Caddy configurations.

### Fixed during pre-release verification

- The active workspace was global, so two clients sharing one bridge could redirect each other's edits into the wrong repository. It is now scoped to the authenticated caller.
- Search skipped every symlink, silently missing code in pnpm workspaces and monorepos. Links resolving inside the workspace are now followed, with cycle protection; links leaving it are still ignored.
- On Windows, executable resolution preferred the extension-less `npm` shell script over `npm.cmd`, which cannot be spawned.
- Shell metacharacter detection tested `$(` and `${` one character at a time and never matched them.
- Output truncation could spend its whole budget on the head of a log and drop the tail, losing the build summary.
- The consent page's `Content-Security-Policy` used `form-action 'self'`, which browsers also apply to the redirect *after* a form submission — blocking the final step of the OAuth flow.
- Log redaction masked any field whose name contained `auth` or `key`, hiding the diagnostics needed to debug authentication.

### Known limitations

- The OAuth flow is verified against the specification with a real HTTP client, not against ChatGPT's servers.
- The bridge is its own authorization server with one shared passphrase; it is not multi-tenant.
- Several chats inside one ChatGPT connector share a principal, and therefore an active workspace — MCP carries no conversation identity.
- Live pull-request creation is not covered by automated tests.
- `run_command` has no interactive stdin.

[1.0.1]: https://github.com/zcrossoverz/repo-bridge/releases/tag/v1.0.1
[1.0.0]: https://github.com/zcrossoverz/repo-bridge/releases/tag/v1.0.0

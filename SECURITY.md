# Security Policy

repo-bridge reads and writes files, executes commands, and drives git on a real machine. Its boundaries are the product. A way around one of them is a real vulnerability, not a feature request.

For the design those boundaries come from, see **[docs/SECURITY.md](docs/SECURITY.md)**.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting: **[Report a vulnerability](https://github.com/zcrossoverz/repo-bridge/security/advisories/new)** (Security tab → Report a vulnerability). It is private to you and the maintainers until a fix is published.

Please include:

- what boundary is crossed, and what an attacker gains
- the configuration it happens under — auth mode, permission level, OS, Node version
- a minimal reproduction: the tool calls or HTTP requests, in order
- the version or commit you tested

What to expect: acknowledgement within a few days, an assessment of severity and scope, a fix on a private branch, and a release with credit to you unless you prefer otherwise. This is a personal open-source project, not a funded program — there is no bounty, and timelines depend on the severity.

## In scope

Anything that defeats a boundary the project claims to hold:

- **Sandbox escape** — reading or writing outside the configured workspace roots, through path traversal, symlinks, race conditions, or any other route
- **Credential exposure** — getting `.env`, private keys, cloud credentials, or the bridge's own tokens into a tool result, a log, or an error message
- **Command policy bypass** — running an executable that is not allowlisted, chaining a second command despite the no-shell rule, or evading the destructive-operation confirmation
- **Authentication bypass** — reaching `/mcp` without a valid credential; forging, replaying, or extending OAuth codes or tokens; using a token issued for a different audience; CSRF on the consent screen
- **Privilege escalation** — performing an action above the configured `REPO_BRIDGE_PERMISSION` level
- **Protected-branch bypass** — committing or pushing to a branch the configuration protects
- **Injection through repository content** — a file, dependency, or build output that causes the bridge itself to take an action it should refuse

## Out of scope

These are documented behaviours, not vulnerabilities:

- Running with `REPO_BRIDGE_AUTH=none`, or with `REPO_BRIDGE_ALLOW_INSECURE=true` on a public interface. The bridge refuses this by default and warns loudly when overridden.
- Enabling `REPO_BRIDGE_ALLOW_SHELL=true`, which removes the no-shell guarantee by design.
- Adding a dangerous executable through `REPO_BRIDGE_ALLOW_COMMANDS`.
- What an authorised model does *within* its permission level — a bad edit committed to a feature branch is a code-review problem, not a security boundary failure.
- Anything requiring an attacker who already has the `REPO_BRIDGE_TOKEN`, shell access to the host, or write access to the repositories being served.
- Rate limits, availability, or resource exhaustion of your own bridge by your own client.
- Vulnerabilities in ChatGPT, GitHub, GitLab, or Node.js — report those to their maintainers.

## Supported versions

The latest release on `main` receives security fixes. There are no long-term support branches.

## Hardening checklist

If you run repo-bridge exposed to a network:

- `REPO_BRIDGE_AUTH=oauth`, never `none`
- Terminate TLS in front of it; never publish the port directly
- Start at `REPO_BRIDGE_PERMISSION=develop` and raise it only when you need pushes
- Keep `REPO_BRIDGE_WORKSPACES` to the repositories you actually want reachable
- Leave `REPO_BRIDGE_ALLOW_SHELL` off
- Watch `audit.log` — every tool call, file change, command and git operation is recorded there with secrets redacted

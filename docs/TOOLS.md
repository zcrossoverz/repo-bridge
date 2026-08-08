# Tool reference

30 tools at `full` permission. The **Needs** column is the permission level required; tools above the configured level are not advertised to the model at all.

Every tool accepts an optional `workspace` argument (an alias from `workspace_list`). Omit it to use the active workspace — the one most recently opened.

---

## Workspace

| Tool | Needs | Purpose |
|---|---|---|
| `workspace_list` | read_only | Configured roots, open workspaces, which is active, remote-mode readiness |
| `workspace_open` | read_only | Open a local repository and return the full project brief |
| `workspace_info` | read_only | Current state without re-reading the repository — the resume tool |
| `repo_open_remote` | read_only | Clone or refresh a remote repository into an isolated managed workspace |
| `workspace_close` | read_only | Stop tracking a workspace; optionally delete a managed clone |

### `workspace_open`
`path` *(required)* — alias or absolute path inside a configured root.

Returns one brief containing: workspace identity and permission level, detected languages / build systems / frameworks / test frameworks, module layout, the resolved build / test / lint / typecheck / install commands **for this repository**, git branch and working-tree state with recent commits, anything the bridge already changed in this task, and the full text of `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and the README excerpt.

This is deliberately one large call. It replaces the dozen exploratory reads a session would otherwise open with.

### `repo_open_remote`
`repository` *(required)* — `github:owner/repo`, `gitlab:group/sub/repo`, `https://host/owner/repo.git`, or `git@host:owner/repo.git`
`branch` — default: the repository default branch
`task` — short label; keeps concurrent tasks on the same repository isolated and lets a later session reattach
`depth` — shallow clone depth; omit for a full clone (needed to diff against a base branch)

Re-calling with the same `repository` + `task` reattaches to the existing workspace and fetches, rather than cloning again.

---

## Files

| Tool | Needs | Purpose |
|---|---|---|
| `list_dir` | read_only | List a directory, optionally recursive |
| `read_file` | read_only | Read a file or line range as exact text |
| `search_code` | read_only | Search file contents; the primary way to find code |
| `find_files` | read_only | Find files by glob |
| `write_file` | edit | Create, overwrite, or append |
| `edit_file` | edit | Targeted exact-text replacements |
| `move_path` | edit | Move or rename |
| `delete_path` | edit | Delete a file or directory tree |
| `create_dir` | edit | Create an empty directory |
| `file_info` | read_only | Existence, size, mtime without reading |

### `read_file`
`path` *(required)*, `start_line`, `end_line`, `line_numbers`

Returns exact content by default so it can be copied verbatim into an `edit_file` anchor. `line_numbers=true` is a navigation aid only — numbered text must never be pasted back into an edit. Files over 2 MB require a line range. Binary files are refused. Credential files are refused.

### `search_code`
`pattern` *(required)*, `regex`, `case_sensitive`, `include[]`, `exclude[]`, `path`, `context_lines`, `max_results`

Returns `file:line` locations with matching lines and optional context. Honours `.gitignore`; skips build output, `node_modules`, and credential files. Uses ripgrep when available, otherwise an equivalent JavaScript walker.

### `write_file`
`path` *(required)*, `content` *(required)*, `mode` — `create` (default, fails if the file exists), `overwrite`, `append`. Parent directories are created.

### `edit_file`
`path` *(required)*, `edits[]` *(required)* — each `{ old_string, new_string, replace_all? }`.

Each `old_string` must match exactly once unless `replace_all` is set. Edits apply in order and **atomically**: if any anchor fails, the file is left untouched and the error explains why — whitespace mismatch, a stale first line, or nothing found. Returns a compact diff preview.

This is the preferred way to change code. It keeps token cost proportional to the change, and it fails loudly when the model's picture of the file has drifted rather than silently overwriting.

---

## Execution

| Tool | Needs | Purpose |
|---|---|---|
| `run_command` | develop | Run an allowlisted development command |
| `run_build` | develop | Build using the command detected for this project |
| `run_tests` | develop | Test using the command detected for this project |
| `run_lint` | develop | Lint using the command detected for this project |

### `run_command`
`command` *(required)*, `path`, `timeout_seconds`, `confirm`

Commands run **without a shell**: `;`, `&&`, `|`, `<`, `>`, backticks and `$( )` are rejected. Only allowlisted executables run. Destructive commands need `confirm=true`.

Returns command, cwd, exit code, duration, stdout and stderr. Long output is truncated keeping head, tail, and error-matching lines.

### `run_build` / `run_tests` / `run_lint`
`command` (override), `target` (appended — e.g. `-Dtest=PortfolioRiskServiceTest`), `path` (module), `timeout_seconds`

These exist separately from `run_command` because guessing between `mvn test`, `./gradlew test`, `pnpm vitest run` and `pytest -q` is where autonomous loops usually break. The command is resolved from the repository, and the source of that decision is reported.

On failure, `run_tests` extracts the failure lines and states the next step, which is what keeps the fix loop moving.

---

## Git

| Tool | Needs | Purpose |
|---|---|---|
| `git_status` | read_only | Branch, tracking, staged / unstaged / untracked |
| `git_diff` | read_only | Unified diff |
| `git_log` | read_only | Recent commits |
| `git_branch` | develop | List, create, or switch branches |
| `git_commit` | develop | Stage and commit |
| `git_push` | full | Push a branch, setting upstream |
| `git_sync` | full | Fetch, or pull with rebase |
| `git_restore` | develop | Discard or unstage specific files |

### `git_diff`
`against` — `worktree`, `staged`, `head` (default), or a branch/commit (compared via merge base); `paths[]`, `stat_only`, `context_lines`

Untracked files are listed separately, since they never appear in a diff.

### `git_commit`
`message` *(required)*, `paths[]`

Stages everything by default. Refused on a protected branch, and refused with unresolved conflicts. Reports the short hash and the files committed.

### `git_push`
`branch` (default: current), `remote` (default `origin`), `force`, `confirm`

Refused on protected branches. Force requires `confirm=true` and uses `--force-with-lease`. Credentials are injected for the single invocation and never written to `.git/config`. Authentication and non-fast-forward failures come back with the specific fix.

### `git_restore`
`paths[]` *(required)*, `confirm` *(required)*, `staged`

Destroys uncommitted work, so it requires explicit paths and confirmation — it can never discard everything at once. If a named file was not modified by this session, the response says so: that was the user's own work.

---

## Forge

### `create_pull_request` — needs `full`
`title` *(required)*, `body` *(required)*, `base`, `head`, `draft`, `push` (default true)

Pushes the branch, then opens a GitHub pull request or GitLab merge request. Refuses if the working tree is dirty — a request should contain the whole change. If an open request already exists for the branch, its URL is returned rather than creating a duplicate. Reports the request URL and the commits included.

Requires `GITHUB_TOKEN` (scope `repo`, or fine-grained Contents + Pull requests: write) or `GITLAB_TOKEN` (scope `api`).

---

## Introspection

### `bridge_status` — always available
Permission level and capability matrix, active workspace, transport and authentication mode, execution limits and the allowed executable list, protected branches, forge token status, and a summary of the safety boundaries. The tool to call when something was refused.

Note the separation it reports: authentication decides *who may connect*, the permission level decides *what they may do*. Completing an OAuth flow never raises the level.

### `report_changes` — needs `read_only`
`workspace`, `against` (e.g. `develop`)

The end-of-task summary, assembled from recorded facts rather than recollection: files the session touched with the action taken, git file statistics, commits on the branch, what is still uncommitted, and every build/test/lint command with its exit code. If nothing was verified, it says so explicitly.

---

## Error codes

Errors are returned as text beginning with the code, followed by an actionable hint.

| Code | Meaning |
|---|---|
| `NO_WORKSPACE` / `WORKSPACE_NOT_FOUND` | Open a workspace first, or the alias is wrong |
| `PATH_OUTSIDE_WORKSPACE` | Path escaped the sandbox |
| `PATH_NOT_FOUND` | No such file |
| `SECRET_BLOCKED` | Credential file — never returned |
| `PERMISSION_DENIED` | Above the configured permission level |
| `COMMAND_BLOCKED` | Not allowlisted, or shell syntax used |
| `DESTRUCTIVE_BLOCKED` | Needs `confirm=true` |
| `PROTECTED_BRANCH` | Use a feature branch |
| `GIT_ERROR` / `FORGE_ERROR` | Git or GitHub/GitLab rejected the operation |
| `PATCH_FAILED` | Edit anchor did not match uniquely |
| `TIMEOUT` / `TOO_LARGE` / `INVALID_ARGUMENT` | Limits and argument validation |

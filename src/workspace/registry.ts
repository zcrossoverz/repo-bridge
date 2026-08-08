/**
 * Workspace registry — the bridge's memory.
 *
 * Holds which repositories are open, which one is active, and an append-only
 * change log per workspace so a conversation can be resumed days later
 * ("continue working on Quantix") without re-reading the repository.
 *
 * State is persisted as JSON under the data dir. It is small and human-readable
 * on purpose: an operator should be able to see what the bridge thinks it owns.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, type Config } from '../config.js';
import { BridgeError } from '../errors.js';
import { isInside, realpathTolerant } from '../security/paths.js';

export interface RemoteInfo {
  provider: 'github' | 'gitlab' | 'other';
  host: string;
  owner: string;
  repo: string;
  cloneUrl: string;
  baseBranch?: string;
}

export interface Workspace {
  id: string;
  alias: string;
  root: string;
  kind: 'local' | 'managed';
  remote?: RemoteInfo;
  /** Free-text task label so parallel managed workspaces stay distinguishable. */
  task?: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface FileChange {
  action: 'created' | 'modified' | 'deleted' | 'moved';
  count: number;
  lastAt: string;
}

export interface CommandRecord {
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  at: string;
}

export interface GitRecord {
  op: string;
  detail: string;
  at: string;
}

export interface ChangeLog {
  startedAt: string;
  files: Record<string, FileChange>;
  commands: CommandRecord[];
  git: GitRecord[];
  notes: string[];
}

interface PersistedState {
  version: 1;
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
}

const MAX_COMMAND_HISTORY = 100;
const MAX_GIT_HISTORY = 100;

export class WorkspaceRegistry {
  private readonly cfg: Config;
  private readonly stateFile: string;
  private readonly sessionDir: string;
  private state: PersistedState;
  private readonly logs = new Map<string, ChangeLog>();

  constructor(cfg: Config = loadConfig()) {
    this.cfg = cfg;
    this.stateFile = path.join(cfg.dataDir, 'state.json');
    this.sessionDir = path.join(cfg.dataDir, 'sessions');
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.state = this.load();
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private load(): PersistedState {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version === 1 && Array.isArray(parsed.workspaces)) {
        // Drop workspaces whose directory disappeared since last run.
        parsed.workspaces = parsed.workspaces.filter((w) => fs.existsSync(w.root));
        if (parsed.activeWorkspaceId && !parsed.workspaces.some((w) => w.id === parsed.activeWorkspaceId)) {
          parsed.activeWorkspaceId = null;
        }
        return parsed;
      }
    } catch {
      /* first run, or corrupt state — start clean */
    }
    return { version: 1, activeWorkspaceId: null, workspaces: [] };
  }

  private save(): void {
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  // ── configured roots ───────────────────────────────────────────────────────

  /** Roots the operator declared with REPO_BRIDGE_WORKSPACES, plus the managed root. */
  configuredRoots(): Array<{ alias: string; path: string; exists: boolean }> {
    return this.cfg.workspaceRoots.map((r) => ({
      alias: r.alias,
      path: r.path,
      exists: fs.existsSync(r.path),
    }));
  }

  /** A candidate path is openable only if it sits inside a declared root. */
  private assertAllowedRoot(target: string): void {
    const roots = [...this.cfg.workspaceRoots.map((r) => r.path), this.cfg.managedRoot];
    if (roots.length === 0) {
      throw new BridgeError('PERMISSION_DENIED', 'No workspace roots are configured.', {
        hint: 'Set REPO_BRIDGE_WORKSPACES="alias=C:\\path\\to\\project" and restart the bridge.',
      });
    }
    const real = realpathTolerant(target);
    if (!roots.some((r) => isInside(realpathTolerant(r), real))) {
      throw new BridgeError(
        'PATH_OUTSIDE_WORKSPACE',
        `"${target}" is not inside any configured workspace root.`,
        {
          hint:
            `Configured roots:\n${roots.map((r) => '  ' + r).join('\n')}\n` +
            'The operator must add the path to REPO_BRIDGE_WORKSPACES before it can be opened.',
        },
      );
    }
  }

  // ── workspace lifecycle ────────────────────────────────────────────────────

  list(): Workspace[] {
    return [...this.state.workspaces].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  get(idOrAlias: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.id === idOrAlias || w.alias === idOrAlias);
  }

  active(): Workspace | null {
    if (!this.state.activeWorkspaceId) return null;
    return this.state.workspaces.find((w) => w.id === this.state.activeWorkspaceId) ?? null;
  }

  /** Resolve the workspace a tool call should act on. */
  require(idOrAlias?: string): Workspace {
    if (idOrAlias) {
      const found = this.get(idOrAlias);
      if (!found) {
        throw new BridgeError('WORKSPACE_NOT_FOUND', `No open workspace named "${idOrAlias}".`, {
          hint: `Open workspaces: ${this.list().map((w) => w.alias).join(', ') || '(none)'}. Use workspace_open first.`,
        });
      }
      return found;
    }
    const act = this.active();
    if (!act) {
      throw new BridgeError('NO_WORKSPACE', 'No workspace is open.', {
        hint:
          'Call workspace_open with a local path or alias, or repo_open_remote with a Git URL. ' +
          `Configured roots: ${this.configuredRoots().map((r) => r.alias).join(', ') || '(none)'}`,
      });
    }
    return act;
  }

  /**
   * Register (or refresh) a local workspace. `target` may be an alias of a
   * configured root or any path inside one.
   */
  openLocal(target: string): Workspace {
    const byAlias = this.cfg.workspaceRoots.find((r) => r.alias === target);
    const candidate = byAlias ? byAlias.path : path.resolve(target);

    if (!fs.existsSync(candidate)) {
      throw new BridgeError('PATH_NOT_FOUND', `Directory does not exist: ${candidate}`, {
        hint: `Known aliases: ${this.cfg.workspaceRoots.map((r) => r.alias).join(', ') || '(none)'}`,
      });
    }
    if (!fs.statSync(candidate).isDirectory()) {
      throw new BridgeError('INVALID_ARGUMENT', `Not a directory: ${candidate}`);
    }
    this.assertAllowedRoot(candidate);

    const root = realpathTolerant(candidate);
    const existing = this.state.workspaces.find((w) => isInside(w.root, root) && isInside(root, w.root));
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      this.state.activeWorkspaceId = existing.id;
      this.save();
      return existing;
    }

    const ws: Workspace = {
      id: crypto.randomUUID(),
      alias: this.uniqueAlias(byAlias?.alias ?? path.basename(root)),
      root,
      kind: 'local',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    this.state.workspaces.push(ws);
    this.state.activeWorkspaceId = ws.id;
    this.save();
    return ws;
  }

  /** Register a managed (cloned) workspace after the clone has succeeded. */
  registerManaged(root: string, remote: RemoteInfo, task?: string): Workspace {
    this.assertAllowedRoot(root);
    const real = realpathTolerant(root);
    const existing = this.state.workspaces.find((w) => w.root === real);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      existing.remote = remote;
      if (task) existing.task = task;
      this.state.activeWorkspaceId = existing.id;
      this.save();
      return existing;
    }
    const ws: Workspace = {
      id: crypto.randomUUID(),
      alias: this.uniqueAlias(task ? `${remote.repo}-${slug(task)}` : remote.repo),
      root: real,
      kind: 'managed',
      remote,
      ...(task ? { task } : {}),
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    this.state.workspaces.push(ws);
    this.state.activeWorkspaceId = ws.id;
    this.save();
    return ws;
  }

  setActive(idOrAlias: string): Workspace {
    const ws = this.get(idOrAlias);
    if (!ws) throw new BridgeError('WORKSPACE_NOT_FOUND', `No workspace named "${idOrAlias}".`);
    ws.lastUsedAt = new Date().toISOString();
    this.state.activeWorkspaceId = ws.id;
    this.save();
    return ws;
  }

  /** Forget a workspace. Managed workspaces may additionally be deleted on disk. */
  close(idOrAlias: string, deleteFiles = false): { alias: string; deleted: boolean } {
    const ws = this.get(idOrAlias);
    if (!ws) throw new BridgeError('WORKSPACE_NOT_FOUND', `No workspace named "${idOrAlias}".`);

    let deleted = false;
    if (deleteFiles) {
      if (ws.kind !== 'managed') {
        throw new BridgeError('PERMISSION_DENIED', 'Only managed (cloned) workspaces can be deleted from disk.', {
          hint: 'Local workspaces belong to the user; close them without delete_files.',
        });
      }
      if (!isInside(this.cfg.managedRoot, ws.root)) {
        throw new BridgeError('PATH_OUTSIDE_WORKSPACE', 'Managed workspace is outside the managed root; refusing to delete.');
      }
      fs.rmSync(ws.root, { recursive: true, force: true });
      deleted = true;
    }

    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== ws.id);
    if (this.state.activeWorkspaceId === ws.id) this.state.activeWorkspaceId = null;
    this.save();
    this.logs.delete(ws.id);
    try {
      fs.rmSync(this.sessionFile(ws.id), { force: true });
    } catch {
      /* ignore */
    }
    return { alias: ws.alias, deleted };
  }

  private uniqueAlias(base: string): string {
    const clean = slug(base) || 'workspace';
    if (!this.state.workspaces.some((w) => w.alias === clean)) return clean;
    for (let i = 2; ; i++) {
      const candidate = `${clean}-${i}`;
      if (!this.state.workspaces.some((w) => w.alias === candidate)) return candidate;
    }
  }

  /** Allocate a fresh managed directory for a task. */
  managedPathFor(repo: string, task?: string): string {
    const base = slug(task ? `${repo}-${task}` : repo) || 'repo';
    let candidate = path.join(this.cfg.managedRoot, base);
    for (let i = 2; fs.existsSync(candidate) && fs.readdirSync(candidate).length > 0; i++) {
      candidate = path.join(this.cfg.managedRoot, `${base}-${i}`);
    }
    return candidate;
  }

  // ── change log ─────────────────────────────────────────────────────────────

  private sessionFile(id: string): string {
    return path.join(this.sessionDir, `${id}.json`);
  }

  changeLog(id: string): ChangeLog {
    let logEntry = this.logs.get(id);
    if (logEntry) return logEntry;
    try {
      logEntry = JSON.parse(fs.readFileSync(this.sessionFile(id), 'utf8')) as ChangeLog;
    } catch {
      logEntry = { startedAt: new Date().toISOString(), files: {}, commands: [], git: [], notes: [] };
    }
    this.logs.set(id, logEntry);
    return logEntry;
  }

  private persistLog(id: string): void {
    const entry = this.logs.get(id);
    if (!entry) return;
    try {
      fs.writeFileSync(this.sessionFile(id), JSON.stringify(entry, null, 2), 'utf8');
    } catch {
      /* logging must never break a tool call */
    }
  }

  recordFile(id: string, relPath: string, action: FileChange['action']): void {
    const entry = this.changeLog(id);
    const prev = entry.files[relPath];
    entry.files[relPath] = {
      // A file created then modified stays "created" — that is what the diff shows.
      action: prev?.action === 'created' && action === 'modified' ? 'created' : action,
      count: (prev?.count ?? 0) + 1,
      lastAt: new Date().toISOString(),
    };
    this.persistLog(id);
  }

  recordCommand(id: string, rec: CommandRecord): void {
    const entry = this.changeLog(id);
    entry.commands.push(rec);
    if (entry.commands.length > MAX_COMMAND_HISTORY) entry.commands.splice(0, entry.commands.length - MAX_COMMAND_HISTORY);
    this.persistLog(id);
  }

  recordGit(id: string, op: string, detail: string): void {
    const entry = this.changeLog(id);
    entry.git.push({ op, detail, at: new Date().toISOString() });
    if (entry.git.length > MAX_GIT_HISTORY) entry.git.splice(0, entry.git.length - MAX_GIT_HISTORY);
    this.persistLog(id);
  }

  recordNote(id: string, note: string): void {
    const entry = this.changeLog(id);
    entry.notes.push(note);
    this.persistLog(id);
  }
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

let singleton: WorkspaceRegistry | null = null;

export function registry(): WorkspaceRegistry {
  singleton ??= new WorkspaceRegistry();
  return singleton;
}

/** Test seam. */
export function resetRegistryForTests(): void {
  singleton = null;
}

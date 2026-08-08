/**
 * Workspace registry: per-caller isolation and state migration.
 *
 * The isolation tests exist because of a real defect: with a single global
 * "active workspace", two clients sharing one bridge could silently redirect
 * each other's edits into the wrong repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-ws-'));
process.env.REPO_BRIDGE_DATA_DIR = dataRoot;
process.env.REPO_BRIDGE_MODE = 'stdio';

const { WorkspaceRegistry } = await import('../workspace/registry.js');
const { runWithContext, currentPrincipal, STDIO_PRINCIPAL } = await import('../context.js');
const { loadConfig } = await import('../config.js');
const { BridgeError } = await import('../errors.js');

const CHATGPT = 'oauth:rbc_chatgpt';
const CLAUDE = 'local:stdio';

/** Two sibling repositories under one configured root. */
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-roots-')));
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });
  fs.writeFileSync(path.join(alpha, 'README.md'), '# alpha\n');
  fs.writeFileSync(path.join(beta, 'README.md'), '# beta\n');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-data-'));
  const cfg = {
    ...loadConfig(),
    dataDir,
    managedRoot: path.join(dataDir, 'workspaces'),
    workspaceRoots: [{ alias: 'root', path: root }],
  };
  fs.mkdirSync(cfg.managedRoot, { recursive: true });
  return { cfg, alpha, beta, dataDir };
}

// ── per-caller isolation ─────────────────────────────────────────────────────

test('two callers keep separate active workspaces', () => {
  const { cfg, alpha, beta } = fixture();
  const reg = new WorkspaceRegistry(cfg);

  reg.openLocal(alpha, CHATGPT);
  reg.openLocal(beta, CLAUDE);

  assert.equal(reg.require(undefined, CHATGPT).root, alpha, 'ChatGPT must still see alpha');
  assert.equal(reg.require(undefined, CLAUDE).root, beta, 'the stdio client must see beta');
});

test('one caller opening a workspace does not move another caller', () => {
  const { cfg, alpha, beta } = fixture();
  const reg = new WorkspaceRegistry(cfg);

  reg.openLocal(alpha, CHATGPT);
  assert.equal(reg.require(undefined, CHATGPT).root, alpha);

  // The exact interleaving that used to corrupt the first caller's context.
  reg.openLocal(beta, CLAUDE);

  assert.equal(reg.require(undefined, CHATGPT).root, alpha, 'edits would have gone to the wrong repo');
});

test('a caller with no workspace open gets a clear error, not another caller\'s workspace', () => {
  const { cfg, alpha } = fixture();
  const reg = new WorkspaceRegistry(cfg);

  reg.openLocal(alpha, CHATGPT);

  assert.throws(
    () => reg.require(undefined, 'oauth:rbc_someone_else'),
    (e: InstanceType<typeof BridgeError>) => e.code === 'NO_WORKSPACE',
  );
});

test('an explicit workspace argument works for any caller', () => {
  const { cfg, alpha, beta } = fixture();
  const reg = new WorkspaceRegistry(cfg);

  const a = reg.openLocal(alpha, CHATGPT);
  reg.openLocal(beta, CLAUDE);

  assert.equal(reg.require(a.alias, CLAUDE).root, alpha, 'naming a workspace overrides the caller default');
});

test('closing a workspace clears it for every caller that had it selected', () => {
  const { cfg, alpha } = fixture();
  const reg = new WorkspaceRegistry(cfg);

  const ws = reg.openLocal(alpha, CHATGPT);
  reg.openLocal(alpha, CLAUDE);

  reg.close(ws.alias);

  for (const principal of [CHATGPT, CLAUDE]) {
    assert.throws(() => reg.require(undefined, principal), (e: InstanceType<typeof BridgeError>) => e.code === 'NO_WORKSPACE', principal);
  }
});

test('the active selection survives a restart, per caller', () => {
  const { cfg, alpha, beta } = fixture();
  const first = new WorkspaceRegistry(cfg);
  first.openLocal(alpha, CHATGPT);
  first.openLocal(beta, CLAUDE);

  const second = new WorkspaceRegistry(cfg);
  assert.equal(second.require(undefined, CHATGPT).root, alpha);
  assert.equal(second.require(undefined, CLAUDE).root, beta);
});

// ── the ambient context ──────────────────────────────────────────────────────

test('the principal defaults to stdio and follows the request context', () => {
  assert.equal(currentPrincipal(), STDIO_PRINCIPAL);
  runWithContext({ principal: CHATGPT }, () => {
    assert.equal(currentPrincipal(), CHATGPT);
  });
  assert.equal(currentPrincipal(), STDIO_PRINCIPAL, 'context must not leak out of the request');
});

test('the registry picks up the ambient principal without being told', () => {
  const { cfg, alpha, beta } = fixture();
  const reg = new WorkspaceRegistry(cfg);

  runWithContext({ principal: CHATGPT }, () => reg.openLocal(alpha));
  runWithContext({ principal: 'oauth:rbc_other' }, () => reg.openLocal(beta));

  runWithContext({ principal: CHATGPT }, () => {
    assert.equal(reg.require().root, alpha);
  });
  runWithContext({ principal: 'oauth:rbc_other' }, () => {
    assert.equal(reg.require().root, beta);
  });
});

test('context survives across awaits', async () => {
  await runWithContext({ principal: CHATGPT }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(currentPrincipal(), CHATGPT);
  });
});

// ── sandbox still holds ──────────────────────────────────────────────────────

test('a path outside every configured root is refused whoever asks', () => {
  const { cfg } = fixture();
  const reg = new WorkspaceRegistry(cfg);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-outside-'));

  assert.throws(
    () => reg.openLocal(outside, CHATGPT),
    (e: InstanceType<typeof BridgeError>) => e.code === 'PATH_OUTSIDE_WORKSPACE',
  );
});

// ── state migration ──────────────────────────────────────────────────────────

test('a v1 state file keeps its workspaces after the upgrade', () => {
  const { cfg, alpha } = fixture();
  const legacy = {
    version: 1,
    activeWorkspaceId: 'some-old-id',
    workspaces: [
      {
        id: 'some-old-id',
        alias: 'alpha',
        root: alpha,
        kind: 'local',
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      },
    ],
  };
  fs.writeFileSync(path.join(cfg.dataDir, 'state.json'), JSON.stringify(legacy), 'utf8');

  const reg = new WorkspaceRegistry(cfg);
  assert.equal(reg.list().length, 1, 'registered workspaces must survive the migration');
  assert.equal(reg.get('alpha')?.root, alpha);
  // The global active selection is intentionally dropped — it is per-caller now.
  assert.throws(() => reg.require(undefined, CHATGPT), (e: InstanceType<typeof BridgeError>) => e.code === 'NO_WORKSPACE');
});

test('a workspace whose directory vanished is dropped on load', () => {
  const { cfg } = fixture();
  const gone = path.join(cfg.workspaceRoots[0]!.path, 'deleted-later');
  fs.mkdirSync(gone, { recursive: true });

  const first = new WorkspaceRegistry(cfg);
  first.openLocal(gone, CHATGPT);
  fs.rmSync(gone, { recursive: true, force: true });

  const second = new WorkspaceRegistry(cfg);
  assert.equal(second.list().some((w) => w.root === gone), false);
});

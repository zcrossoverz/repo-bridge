/**
 * Cross-process state integrity.
 *
 * Two bridge processes can share one data directory. Before locking, each kept
 * its own copy of the state file and the last writer silently discarded the
 * other's work — a workspace registered in one process, or a token issued in
 * one, would simply vanish. These tests spawn real processes, because that is
 * the only place the defect exists: a single process is already serialised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const { withFileLock } = await import('../fs/lock.js');

function tempDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-lock-')));
}

// ── the lock primitive ───────────────────────────────────────────────────────

test('withFileLock runs the callback and releases afterwards', () => {
  const dir = tempDir();
  const target = path.join(dir, 'state.json');

  const result = withFileLock(target, () => 'done');
  assert.equal(result, 'done');
  assert.equal(fs.existsSync(`${target}.lock`), false, 'the lock must not be left behind');
});

test('withFileLock releases the lock when the callback throws', () => {
  const dir = tempDir();
  const target = path.join(dir, 'state.json');

  assert.throws(() =>
    withFileLock(target, () => {
      throw new Error('boom');
    }),
  );
  assert.equal(fs.existsSync(`${target}.lock`), false, 'a throw must not wedge the lock');
});

test('a stale lock from a crashed process is broken rather than waited on', () => {
  const dir = tempDir();
  const target = path.join(dir, 'state.json');
  const lockDir = `${target}.lock`;

  // A lock left by a process that was killed: present, but long past the stale window.
  fs.mkdirSync(lockDir);
  const ancient = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, ancient, ancient);

  const started = Date.now();
  const result = withFileLock(target, () => 'recovered');
  const elapsed = Date.now() - started;
  assert.equal(result, 'recovered');
  // The acquire timeout is 10s; anything comfortably under it proves the stale
  // lock was broken rather than waited out, with room for a slow CI runner.
  assert.ok(elapsed < 8_000, `must not block for the full acquire timeout (took ${elapsed}ms)`);
});

// ── real concurrent processes ────────────────────────────────────────────────

/**
 * Each child registers its own workspaces through the real registry. With no
 * lock, the writes interleave and most of them are lost.
 */
function writerScript(dataDir: string, rootDir: string, principal: string, count: number): string {
  return `
    process.env.REPO_BRIDGE_DATA_DIR = ${JSON.stringify(dataDir)};
    process.env.REPO_BRIDGE_MODE = 'stdio';
    process.env.REPO_BRIDGE_WORKSPACES = ${JSON.stringify(`root=${rootDir}`)};
    const { WorkspaceRegistry } = await import(${JSON.stringify(pathToUrl(path.join(distDir, 'workspace', 'registry.js')))});
    const fs = await import('node:fs');
    const path = await import('node:path');
    const reg = new WorkspaceRegistry();
    for (let i = 0; i < ${count}; i++) {
      const dir = path.join(${JSON.stringify(rootDir)}, ${JSON.stringify(principal)} + '-' + i);
      fs.mkdirSync(dir, { recursive: true });
      reg.openLocal(dir, ${JSON.stringify(principal)});
    }
  `;
}

function pathToUrl(p: string): string {
  return new URL(`file:///${p.split(path.sep).join('/')}`).href;
}

/** Start a writer without waiting — the point is that they overlap. */
function startWriter(dataDir: string, rootDir: string, principal: string, count: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', writerScript(dataDir, rootDir, principal, count)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(code) : reject(new Error(`writer ${principal} exited ${code}: ${stderr}`))));
  });
}

test('concurrent processes do not lose each other\'s workspaces', async () => {
  const dataDir = tempDir();
  const rootDir = tempDir();
  const perProcess = 6;

  // Started together and awaited together: without a lock these interleave and
  // most registrations are lost.
  await Promise.all(['alpha', 'beta', 'gamma'].map((principal) => startWriter(dataDir, rootDir, principal, perProcess)));

  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as {
    workspaces: Array<{ root: string }>;
  };

  assert.equal(
    state.workspaces.length,
    3 * perProcess,
    `expected every workspace to survive, got ${state.workspaces.length}`,
  );
  // Aliases are derived from directory names and must not have collided.
  assert.equal(new Set(state.workspaces.map((w) => w.root)).size, 3 * perProcess);
});

test('no lock files are left behind after concurrent writers finish', async () => {
  const dataDir = tempDir();
  const rootDir = tempDir();

  await Promise.all(['one', 'two'].map((principal) => startWriter(dataDir, rootDir, principal, 3)));

  const leftovers = fs.readdirSync(dataDir).filter((f) => f.endsWith('.lock') || f.includes('.tmp'));
  assert.deepEqual(leftovers, [], `stray files: ${leftovers.join(', ')}`);
});

/**
 * Cross-process file lock.
 *
 * Two bridge processes can legitimately share one data directory — a stdio
 * instance for a local editor and an HTTP instance for ChatGPT, say. Each keeps
 * its own in-memory copy of the state file, so without a lock the second one to
 * write silently discards whatever the first recorded.
 *
 * `mkdir` is the primitive: it is atomic on every platform we support and needs
 * no extra dependency. A lock older than the stale timeout is assumed to belong
 * to a crashed process and is broken, so a hard kill cannot wedge the bridge
 * permanently.
 */
import fs from 'node:fs';
import path from 'node:path';

const STALE_AFTER_MS = 15_000;
const RETRY_INTERVAL_MS = 25;
const ACQUIRE_TIMEOUT_MS = 10_000;

/** Synchronous sleep — these code paths are sync, and the waits are milliseconds. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function breakIfStale(lockDir: string): void {
  try {
    const age = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (age > STALE_AFTER_MS) fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* it vanished on its own — fine */
  }
}

/**
 * Run `fn` while holding an exclusive lock on `target`.
 *
 * If the lock cannot be taken within the timeout the callback runs anyway: the
 * bridge staying usable matters more than a write that is theoretically ordered,
 * and the alternative — failing a tool call because another process is slow — is
 * worse for the person waiting on it.
 */
export function withFileLock<T>(target: string, fn: () => T): T {
  const lockDir = `${target}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  let held = false;
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      breakIfStale(lockDir);
      sleepSync(RETRY_INTERVAL_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* best effort; a leftover lock goes stale and is broken later */
      }
    }
  }
}

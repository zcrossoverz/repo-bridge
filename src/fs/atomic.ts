/**
 * Atomic file replacement that survives Windows.
 *
 * `write temp + rename` is the standard way to replace a file without ever
 * exposing a half-written one. On POSIX the rename always succeeds. On Windows
 * it fails with EPERM/EBUSY whenever *anything* holds a handle to the
 * destination — another process reading it, an editor, an antivirus scanner, the
 * search indexer. The handle is usually released within milliseconds, so the fix
 * is to retry briefly rather than to abandon atomicity.
 *
 * This is not theoretical: it showed up as a concurrent-write test failure, and
 * the same path backs every file the bridge edits.
 */
import fs from 'node:fs';
import path from 'node:path';

const RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 120, 160, 200];
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AtomicWriteOptions {
  /** POSIX mode for the written file, e.g. 0o600 for credential state. */
  mode?: number;
}

export function atomicWriteFileSync(target: string, data: string, opts: AtomicWriteOptions = {}): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  // The temp name carries the pid so two processes never collide on it.
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data, opts.mode !== undefined ? { encoding: 'utf8', mode: opts.mode } : { encoding: 'utf8' });

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code)) break;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      sleepSync(delay);
    }
  }

  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* leave it; a stray temp file is better than masking the real error */
  }
  throw lastError;
}

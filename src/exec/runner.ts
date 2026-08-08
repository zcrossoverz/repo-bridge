/**
 * Process execution.
 *
 * Invariants:
 *   - never spawned through a shell (see security/commands.ts for why)
 *   - always bounded by a timeout, and killed as a process *tree* on expiry
 *   - output is byte-capped with error-preserving truncation, because a failing
 *     Maven build can emit megabytes and the useful part is 20 lines in the middle
 *   - stdout/stderr are redacted before they leave this module
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { redact } from '../security/secrets.js';

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Extra env on top of the host environment. */
  env?: Record<string, string>;
  /** Fed to the process stdin, then closed. */
  input?: string;
}

export interface ExecResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** True when exitCode === 0 and the process was not killed. */
  ok: boolean;
}

const isWin = process.platform === 'win32';

/** Locate an executable the same way a shell would, without invoking one. */
export function which(bin: string, cwd: string): string | null {
  // On Windows the executable extensions must be tried FIRST: `npm` and `npm.cmd`
  // both exist next to each other, but the extension-less one is a POSIX shell
  // script that CreateProcess cannot run.
  const order = isWin
    ? [...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '']
    : [''];

  const tryFile = (candidate: string): string | null => {
    for (const ext of order) {
      const withExt = candidate + ext;
      try {
        const stat = fs.statSync(withExt);
        if (stat.isFile()) return withExt;
      } catch {
        /* keep looking */
      }
    }
    return null;
  };

  // Explicit path (./gradlew, ../tools/foo, C:\bin\x.exe) → resolve against cwd.
  if (bin.includes('/') || bin.includes('\\')) {
    return tryFile(path.resolve(cwd, bin));
  }

  // Project-local wrappers live in the repo root, not on PATH.
  if (/^(mvnw|gradlew)$/i.test(bin)) {
    const local = tryFile(path.join(cwd, bin));
    if (local) return local;
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const hit = tryFile(path.join(dir, bin));
    if (hit) return hit;
  }
  return null;
}

/**
 * Quote an argv for cmd.exe. Only used for .cmd/.bat targets, which cannot be
 * spawned directly on Windows. Args are quoted verbatim; because tokenize()
 * already rejected unquoted shell metacharacters, nothing here can start a
 * second command.
 */
function winCmdLine(argv: string[]): string {
  return argv
    .map((a) => {
      if (a !== '' && !/[\s"&|<>^()%!,;=]/.test(a)) return a;
      const escaped = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
      return `"${escaped}"`;
    })
    .join(' ');
}

function killTree(pid: number, child: { kill: (sig?: NodeJS.Signals) => boolean }): void {
  if (isWin) {
    // Node's kill() only signals the direct child; npm/gradle wrappers spawn
    // grandchildren that would survive and keep holding file locks.
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).unref();
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Lines worth keeping when output has to be cut down. */
const ERROR_LINE = /\b(error|errors|fail|failed|failure|failing|exception|traceback|assert|cannot|unresolved|undefined|denied|missing|BUILD FAILURE|npm ERR!|Tests run:|✗|×|FAIL\b)/i;

const MAX_KEPT_LINE_CHARS = 2000;

/**
 * Keep the head, the tail, and every error-looking line in between.
 *
 * Each section gets its own byte budget rather than a fixed line count: a build
 * log with very long lines would otherwise spend the whole allowance on the head
 * and drop the tail — which is where "BUILD FAILED" and the summary live.
 */
export function smartTruncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };

  const lines = text.split(/\r?\n/).map((l) => (l.length > MAX_KEPT_LINE_CHARS ? l.slice(0, MAX_KEPT_LINE_CHARS) + ' …[line clipped]' : l));
  const size = (s: string) => Buffer.byteLength(s, 'utf8') + 1;

  const headBudget = Math.floor(maxBytes * 0.25);
  const tailBudget = Math.floor(maxBytes * 0.35);

  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + size(line) > headBudget) break;
    head.push(line);
    used += size(line);
  }

  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const line = lines[i]!;
    if (used + size(line) > tailBudget) break;
    tail.unshift(line);
    used += size(line);
  }

  const middle = lines.slice(head.length, lines.length - tail.length);
  const midBudget = maxBytes - headBudget - tailBudget - 200;

  const kept: string[] = [];
  used = 0;
  for (let i = 0; i < middle.length && used < midBudget; i++) {
    const line = middle[i]!;
    if (!ERROR_LINE.test(line)) continue;
    // One line of context on each side so stack frames stay readable.
    const chunk = [middle[i - 1], line, middle[i + 1]].filter((l): l is string => typeof l === 'string');
    const chunkSize = chunk.reduce((n, l) => n + size(l), 0);
    if (used + chunkSize > midBudget) break;
    kept.push(...chunk);
    used += chunkSize;
    i += 1;
  }

  const marker = kept.length
    ? `\n… [${middle.length - kept.length} lines omitted; error-matching lines kept below] …\n${kept.join('\n')}\n… [end of extract] …\n`
    : `\n… [${middle.length} lines omitted] …\n`;

  return { text: head.join('\n') + marker + tail.join('\n'), truncated: true };
}

/** Spawn an already-validated argv. Nothing here consults the allowlist. */
export function spawnArgv(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const [bin, ...rest] = argv;
  if (!bin) throw new BridgeError('INVALID_ARGUMENT', 'empty command');

  const resolved = which(bin, opts.cwd);
  if (!resolved) {
    throw new BridgeError('COMMAND_BLOCKED', `Executable not found: ${bin}`, {
      hint: `"${bin}" is not on PATH of the bridge host and is not a wrapper script in ${opts.cwd}.`,
    });
  }

  const useCmdWrapper = isWin && /\.(cmd|bat)$/i.test(resolved);
  const comspec = process.env.ComSpec ?? 'cmd.exe';

  const spawnBin = useCmdWrapper ? comspec : resolved;
  const spawnArgs = useCmdWrapper
    ? ['/d', '/s', '/c', `"${winCmdLine([resolved, ...rest])}"`]
    : rest;

  const started = Date.now();
  const display = argv.join(' ');

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(spawnBin, spawnArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, CI: process.env.CI ?? 'true' },
      windowsHide: true,
      windowsVerbatimArguments: useCmdWrapper,
      // POSIX: own process group so the whole tree can be killed on timeout.
      detached: !isWin,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // Collect up to 4x the cap, then stop buffering — enough for smartTruncate to
    // find error lines without letting a runaway process exhaust memory.
    const hardCap = opts.maxOutputBytes * 4;
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (c: Buffer) => {
      if (stdoutBytes < hardCap) {
        stdoutChunks.push(c);
        stdoutBytes += c.length;
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderrBytes < hardCap) {
        stderrChunks.push(c);
        stderrBytes += c.length;
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid, child);
    }, opts.timeoutMs);

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const rawOut = redact(Buffer.concat(stdoutChunks).toString('utf8'));
      const rawErr = redact(Buffer.concat(stderrChunks).toString('utf8'));
      const outT = smartTruncate(rawOut, opts.maxOutputBytes);
      const errT = smartTruncate(rawErr, Math.floor(opts.maxOutputBytes / 2));

      resolve({
        command: display,
        cwd: opts.cwd,
        exitCode,
        signal,
        durationMs: Date.now() - started,
        stdout: outT.text,
        stderr: errT.text,
        timedOut,
        truncated: outT.truncated || errT.truncated || stdoutBytes >= hardCap || stderrBytes >= hardCap,
        ok: !timedOut && exitCode === 0,
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BridgeError('COMMAND_BLOCKED', `Failed to start "${bin}": ${err.message}`));
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Format an ExecResult as the compact text block the model reads. */
export function formatExecResult(r: ExecResult): string {
  const status = r.timedOut
    ? `TIMED OUT after ${r.durationMs}ms`
    : r.ok
      ? `exit 0 (${r.durationMs}ms)`
      : `exit ${r.exitCode ?? 'null'}${r.signal ? ` signal ${r.signal}` : ''} (${r.durationMs}ms)`;

  const parts = [`$ ${r.command}`, `cwd: ${r.cwd}`, `status: ${status}`];
  if (r.truncated) parts.push('note: output truncated — error lines preserved');
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(no output)');
  return parts.join('\n');
}

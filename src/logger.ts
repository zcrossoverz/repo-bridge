/**
 * Structured logging.
 *
 * Everything goes to stderr — stdout belongs to the stdio MCP transport and a
 * stray console.log there corrupts the protocol stream.
 *
 * Two channels:
 *   log.*    — operational diagnostics
 *   audit()  — an append-only record of every side effect (tool called, file
 *              modified, command run, git operation) for after-the-fact review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactValue } from './security/secrets.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minWeight = LEVEL_WEIGHT.info;
let fileStream: fs.WriteStream | null = null;
let auditStream: fs.WriteStream | null = null;

export function configureLogger(opts: { level: Level; file?: string; dataDir: string }): void {
  minWeight = LEVEL_WEIGHT[opts.level] ?? LEVEL_WEIGHT.info;

  if (opts.file) {
    fs.mkdirSync(path.dirname(path.resolve(opts.file)), { recursive: true });
    fileStream = fs.createWriteStream(path.resolve(opts.file), { flags: 'a' });
  }

  const auditPath = path.join(opts.dataDir, 'audit.log');
  fs.mkdirSync(opts.dataDir, { recursive: true });
  auditStream = fs.createWriteStream(auditPath, { flags: 'a' });
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < minWeight) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? redactValue(fields) : {}),
  };
  const line = JSON.stringify(record);
  process.stderr.write(line + '\n');
  fileStream?.write(line + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

export interface AuditEntry {
  action: string;
  workspace?: string;
  target?: string;
  command?: string;
  outcome: 'ok' | 'error' | 'blocked';
  durationMs?: number;
  detail?: Record<string, unknown>;
}

export function audit(entry: AuditEntry): void {
  const record = { ts: new Date().toISOString(), ...redactValue(entry) };
  const line = JSON.stringify(record);
  auditStream?.write(line + '\n');
  emit(entry.outcome === 'ok' ? 'info' : 'warn', `audit:${entry.action}`, {
    workspace: entry.workspace,
    target: entry.target,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
  });
}

export function closeLogger(): void {
  fileStream?.end();
  auditStream?.end();
}

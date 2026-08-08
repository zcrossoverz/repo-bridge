/**
 * Tool contract + argument access.
 *
 * Tools return plain text, not JSON blobs: the consumer is a language model, and
 * a compact labelled block costs fewer tokens and reads more reliably than
 * pretty-printed JSON. Structured detail is included where it matters (paths,
 * line numbers, exit codes) and omitted where it does not.
 */
import { BridgeError } from '../errors.js';
import type { Capability } from '../security/permissions.js';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Permission gate applied before the handler runs. */
  capability: Capability;
  /** Set for tools whose effects are hard to undo; used for audit emphasis. */
  sideEffecting?: boolean;
  handler: (args: Args) => Promise<string>;
}

export class Args {
  constructor(
    private readonly raw: Record<string, unknown>,
    private readonly tool: string,
  ) {}

  private fail(field: string, expected: string): never {
    throw new BridgeError('INVALID_ARGUMENT', `${this.tool}: "${field}" must be ${expected}.`);
  }

  has(field: string): boolean {
    return this.raw[field] !== undefined && this.raw[field] !== null;
  }

  str(field: string, fallback?: string): string {
    const v = this.raw[field];
    if (v === undefined || v === null || v === '') {
      if (fallback !== undefined) return fallback;
      this.fail(field, 'a non-empty string');
    }
    if (typeof v !== 'string') this.fail(field, 'a string');
    return v;
  }

  optStr(field: string): string | undefined {
    const v = this.raw[field];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') this.fail(field, 'a string');
    return v;
  }

  num(field: string, fallback: number): number {
    const v = this.raw[field];
    if (v === undefined || v === null || v === '') return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) this.fail(field, 'a number');
    return n;
  }

  optNum(field: string): number | undefined {
    const v = this.raw[field];
    if (v === undefined || v === null || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) this.fail(field, 'a number');
    return n;
  }

  bool(field: string, fallback = false): boolean {
    const v = this.raw[field];
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (['true', 'yes', '1'].includes(v.toLowerCase())) return true;
      if (['false', 'no', '0'].includes(v.toLowerCase())) return false;
    }
    this.fail(field, 'a boolean');
  }

  /** Accepts an array, or a single string (some clients flatten one-element arrays). */
  strArray(field: string, fallback: string[] = []): string[] {
    const v = this.raw[field];
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'string') return [v];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) this.fail(field, 'an array of strings');
    return v as string[];
  }

  objArray(field: string): Array<Record<string, unknown>> {
    const v = this.raw[field];
    if (!Array.isArray(v) || v.length === 0) this.fail(field, 'a non-empty array of objects');
    for (const item of v) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) this.fail(field, 'an array of objects');
    }
    return v as Array<Record<string, unknown>>;
  }
}

// ── text formatting helpers ──────────────────────────────────────────────────

export function block(title: string, lines: Array<string | undefined | false>): string {
  const body = lines.filter((l): l is string => typeof l === 'string' && l.length > 0);
  return body.length ? `${title}\n${body.map((l) => '  ' + l).join('\n')}` : '';
}

export function kv(pairs: Record<string, unknown>): string[] {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
}

export function join(...sections: Array<string | undefined | false>): string {
  return sections.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).join('\n\n');
}

export function bullets(items: string[], cap = 50): string[] {
  const shown = items.slice(0, cap);
  const out = shown.map((i) => `- ${i}`);
  if (items.length > cap) out.push(`- … ${items.length - cap} more`);
  return out;
}

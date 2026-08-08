/**
 * Repository search.
 *
 * Context efficiency is the whole point: the model should be able to find the
 * three files that matter in a 5,000-file repo without any of them entering the
 * conversation whole. Results are line-level with optional surrounding context
 * and hard caps on both matches and per-line length.
 *
 * ripgrep is used when it is on PATH (large repos), with a dependency-free JS
 * walker as the always-available fallback. Both honour .gitignore.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { ALWAYS_SKIP_DIRS, resolvePath } from '../security/paths.js';
import { isSecretPath, isSecretTemplate } from '../security/secrets.js';
import { makeMatcher } from './glob.js';
import { GitIgnore } from './gitignore.js';
import { isBinary } from './ops.js';
import { spawnArgv, which } from '../exec/runner.js';

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchOptions {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** Restrict to these globs, e.g. ["**\/*.ts", "src/**"]. */
  include?: string[];
  exclude?: string[];
  /** Subdirectory to search under, relative to the workspace root. */
  subPath?: string;
  maxResults?: number;
  contextLines?: number;
}

export interface SearchResponse {
  engine: 'ripgrep' | 'javascript';
  matches: SearchMatch[];
  filesWithMatches: number;
  filesScanned: number;
  truncated: boolean;
  elapsedMs: number;
}

const MAX_LINE_LENGTH = 400;
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.svgz',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  '.jar', '.war', '.ear', '.class', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.ogg', '.webm',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pyc', '.pyo', '.o', '.a', '.lib', '.pdb', '.node', '.wasm',
  '.db', '.sqlite', '.sqlite3', '.lock',
]);

function clip(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + ' …[line truncated]' : line;
}

/** Load .gitignore + .git/info/exclude from the workspace root. */
function loadIgnore(root: string): GitIgnore {
  const ig = new GitIgnore();
  for (const rel of ['.gitignore', path.join('.git', 'info', 'exclude')]) {
    try {
      ig.add(fs.readFileSync(path.join(root, rel), 'utf8'));
    } catch {
      /* absent */
    }
  }
  return ig.addDirectories(ALWAYS_SKIP_DIRS);
}

function buildRegex(opts: SearchOptions): RegExp {
  const flags = opts.caseSensitive ? 'g' : 'gi';
  if (!opts.regex) {
    return new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
  try {
    return new RegExp(opts.pattern, flags);
  } catch (e) {
    throw new BridgeError('INVALID_ARGUMENT', `Invalid regular expression: ${(e as Error).message}`, {
      hint: 'Set regex=false to search for the pattern literally.',
    });
  }
}

/** Depth-first file walk honouring .gitignore, skip-dirs and secret paths. */
export function* walkFiles(root: string, subPath: string, ig: GitIgnore): Generator<{ abs: string; rel: string }> {
  const stack: string[] = [path.join(root, subPath)];
  while (stack.length) {
    const dir = stack.pop()!;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const abs = path.join(dir, item.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) continue;
      if (item.isSymbolicLink()) continue; // never follow: could leave the workspace
      if (item.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(item.name)) continue;
        if (ig.ignores(rel + '/')) continue;
        stack.push(abs);
        continue;
      }
      if (!item.isFile()) continue;
      if (ig.ignores(rel)) continue;
      if (isSecretPath(rel) && !isSecretTemplate(rel)) continue;
      if (BINARY_EXT.has(path.extname(item.name).toLowerCase())) continue;
      yield { abs, rel };
    }
  }
}

function searchWithJs(root: string, subPath: string, opts: SearchOptions): SearchResponse {
  const started = Date.now();
  const re = buildRegex(opts);
  const includeMatch = makeMatcher(opts.include ?? []);
  const excludeMatch = opts.exclude?.length ? makeMatcher(opts.exclude) : null;
  const maxResults = Math.max(1, Math.min(opts.maxResults ?? 100, 1000));
  const context = Math.max(0, Math.min(opts.contextLines ?? 0, 10));
  const ig = loadIgnore(root);

  const matches: SearchMatch[] = [];
  const filesWithMatches = new Set<string>();
  let filesScanned = 0;
  let truncated = false;

  for (const { abs, rel } of walkFiles(root, subPath, ig)) {
    if (!includeMatch(rel)) continue;
    if (excludeMatch?.(rel)) continue;

    let buf: Buffer;
    try {
      const st = fs.statSync(abs);
      if (st.size > 5 * 1024 * 1024) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;

    filesScanned++;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m) continue;

      filesWithMatches.add(rel);
      matches.push({
        path: rel,
        line: i + 1,
        column: m.index + 1,
        text: clip(line),
        ...(context
          ? {
              before: lines.slice(Math.max(0, i - context), i).map(clip),
              after: lines.slice(i + 1, i + 1 + context).map(clip),
            }
          : {}),
      });

      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return {
    engine: 'javascript',
    matches,
    filesWithMatches: filesWithMatches.size,
    filesScanned,
    truncated,
    elapsedMs: Date.now() - started,
  };
}

interface RgEvent {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start: number }>;
    stats?: { searches?: number };
  };
}

async function searchWithRipgrep(root: string, subPath: string, opts: SearchOptions): Promise<SearchResponse | null> {
  const started = Date.now();
  const maxResults = Math.max(1, Math.min(opts.maxResults ?? 100, 1000));
  const context = Math.max(0, Math.min(opts.contextLines ?? 0, 10));

  const args = ['--json', '--line-number', '--max-filesize', '5M', `--max-count=${maxResults}`];
  if (!opts.regex) args.push('--fixed-strings');
  if (!opts.caseSensitive) args.push('--ignore-case');
  if (context) args.push(`--context=${context}`);
  for (const g of opts.include ?? []) args.push('--glob', g);
  for (const g of opts.exclude ?? []) args.push('--glob', `!${g}`);
  for (const d of ALWAYS_SKIP_DIRS) args.push('--glob', `!${d}/`);
  args.push('--regexp', opts.pattern, '--', subPath || '.');

  let result;
  try {
    result = await spawnArgv(['rg', ...args], {
      cwd: root,
      timeoutMs: 60_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
  } catch {
    return null; // fall back to the JS walker
  }
  // rg exits 1 for "no matches" and 2 for a real error.
  if (result.exitCode !== 0 && result.exitCode !== 1) return null;

  const matches: SearchMatch[] = [];
  const filesWithMatches = new Set<string>();
  let filesScanned = 0;
  const pendingContext: Record<number, string> = {};

  for (const rawLine of result.stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    let evt: RgEvent;
    try {
      evt = JSON.parse(rawLine) as RgEvent;
    } catch {
      continue;
    }
    if (evt.type === 'begin') filesScanned++;
    if (evt.type === 'context' && evt.data?.line_number) {
      pendingContext[evt.data.line_number] = clip((evt.data.lines?.text ?? '').replace(/\r?\n$/, ''));
    }
    if (evt.type !== 'match' || !evt.data) continue;

    const rel = (evt.data.path?.text ?? '').split(path.sep).join('/');
    if (isSecretPath(rel) && !isSecretTemplate(rel)) continue;
    const lineNo = evt.data.line_number ?? 0;
    filesWithMatches.add(rel);
    matches.push({
      path: rel,
      line: lineNo,
      column: (evt.data.submatches?.[0]?.start ?? 0) + 1,
      text: clip((evt.data.lines?.text ?? '').replace(/\r?\n$/, '')),
      ...(context
        ? {
            before: Array.from({ length: context }, (_, k) => pendingContext[lineNo - context + k]).filter((s): s is string => !!s),
            after: [],
          }
        : {}),
    });
    if (matches.length >= maxResults) break;
  }

  return {
    engine: 'ripgrep',
    matches,
    filesWithMatches: filesWithMatches.size,
    filesScanned,
    truncated: matches.length >= maxResults,
    elapsedMs: Date.now() - started,
  };
}

export async function searchCode(root: string, opts: SearchOptions): Promise<SearchResponse> {
  if (!opts.pattern?.trim()) throw new BridgeError('INVALID_ARGUMENT', 'pattern must not be empty');
  const sub = opts.subPath ? resolvePath(root, opts.subPath, { mustExist: true }).rel : '';
  const subDir = sub === '.' ? '' : sub;

  if (which('rg', root)) {
    const viaRg = await searchWithRipgrep(root, subDir, opts);
    if (viaRg) return viaRg;
  }
  return searchWithJs(root, subDir, opts);
}

export function findFiles(
  root: string,
  patterns: string[],
  opts: { subPath?: string; maxResults?: number } = {},
): { files: string[]; truncated: boolean } {
  const sub = opts.subPath ? resolvePath(root, opts.subPath, { mustExist: true }).rel : '';
  const subDir = sub === '.' ? '' : sub;
  const match = makeMatcher(patterns);
  const max = Math.max(1, Math.min(opts.maxResults ?? 200, 2000));
  const ig = loadIgnore(root);

  const files: string[] = [];
  for (const { rel } of walkFiles(root, subDir, ig)) {
    if (!match(rel)) continue;
    files.push(rel);
    if (files.length >= max) return { files, truncated: true };
  }
  return { files: files.sort(), truncated: false };
}

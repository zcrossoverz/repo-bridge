/**
 * File operations.
 *
 * Editing is anchor-based: the model supplies the exact text to replace rather
 * than a whole-file rewrite. That keeps context cost proportional to the size of
 * the change, and it fails loudly when the model's mental model of the file has
 * drifted — which is exactly when a blind overwrite would destroy work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { ALWAYS_SKIP_DIRS, resolvePath } from '../security/paths.js';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size?: number;
  modified?: string;
}

export function listDir(
  root: string,
  relPath: string,
  opts: { depth?: number; includeHidden?: boolean; limit?: number } = {},
): { entries: DirEntry[]; truncated: boolean } {
  const { abs } = resolvePath(root, relPath || '.', { mustExist: true, allowSecrets: true });
  if (!fs.statSync(abs).isDirectory()) {
    throw new BridgeError('INVALID_ARGUMENT', `Not a directory: ${relPath}`);
  }

  const depth = Math.max(1, Math.min(opts.depth ?? 1, 6));
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 3000));
  const entries: DirEntry[] = [];
  let truncated = false;

  const walk = (dir: string, level: number): void => {
    if (level > depth || truncated) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const item of items) {
      if (!opts.includeHidden && item.name.startsWith('.') && item.name !== '.github') continue;
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const childAbs = path.join(dir, item.name);
      const rel = path.relative(root, childAbs).split(path.sep).join('/');
      const type: DirEntry['type'] = item.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'dir' : 'file';

      let size: number | undefined;
      let modified: string | undefined;
      if (type === 'file') {
        try {
          const st = fs.statSync(childAbs);
          size = st.size;
          modified = st.mtime.toISOString();
        } catch {
          /* vanished mid-walk */
        }
      }
      entries.push({ name: item.name, path: rel, type, ...(size !== undefined ? { size } : {}), ...(modified ? { modified } : {}) });

      if (type === 'dir' && !ALWAYS_SKIP_DIRS.has(item.name)) walk(childAbs, level + 1);
    }
  };

  walk(abs, 1);
  return { entries, truncated };
}

export interface ReadResult {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  bytes: number;
  truncated: boolean;
}

export function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return true;
  // Heuristic: a high share of non-printable bytes means it is not source code.
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.15;
}

export function readFile(
  root: string,
  relPath: string,
  opts: { startLine?: number; endLine?: number; maxLines?: number } = {},
): ReadResult {
  const { abs, rel } = resolvePath(root, relPath, { mustExist: true });
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    throw new BridgeError('INVALID_ARGUMENT', `${rel} is a directory — use list_dir.`);
  }
  if (stat.size > MAX_READ_BYTES && !opts.startLine) {
    throw new BridgeError('TOO_LARGE', `${rel} is ${(stat.size / 1024 / 1024).toFixed(1)} MB.`, {
      hint: 'Read a line range instead (start_line / end_line), or use search_code to find the relevant part.',
    });
  }

  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) {
    throw new BridgeError('INVALID_ARGUMENT', `${rel} looks like a binary file (${stat.size} bytes).`, {
      hint: 'Binary files are not readable as text.',
    });
  }

  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const total = lines.length;

  const start = Math.max(1, opts.startLine ?? 1);
  const maxLines = Math.max(1, Math.min(opts.maxLines ?? 4000, 20_000));
  const end = Math.min(total, opts.endLine ?? start + maxLines - 1);

  const slice = lines.slice(start - 1, end);
  const content = slice.join('\n');

  return {
    path: rel,
    content,
    totalLines: total,
    startLine: start,
    endLine: end,
    bytes: stat.size,
    truncated: start > 1 || end < total,
  };
}

/** Prefix each line with its 1-based number — navigation aid, never for patching. */
export function withLineNumbers(content: string, startLine: number): string {
  const width = String(startLine + content.split('\n').length - 1).length;
  return content
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

function atomicWrite(abs: string, content: string): void {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.repo-bridge-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export type WriteMode = 'create' | 'overwrite' | 'append';

export interface WriteResult {
  path: string;
  action: 'created' | 'modified';
  bytes: number;
  lines: number;
}

export function writeFile(root: string, relPath: string, content: string, mode: WriteMode = 'create'): WriteResult {
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    throw new BridgeError('TOO_LARGE', 'Refusing to write more than 8 MB in a single call.');
  }
  const { abs, rel } = resolvePath(root, relPath);
  const existed = fs.existsSync(abs);

  if (existed && fs.statSync(abs).isDirectory()) {
    throw new BridgeError('INVALID_ARGUMENT', `${rel} is a directory.`);
  }
  if (existed && mode === 'create') {
    throw new BridgeError('INVALID_ARGUMENT', `${rel} already exists.`, {
      hint: 'Use edit_file for a targeted change, or write_file with mode="overwrite" to replace the whole file.',
    });
  }

  const final = mode === 'append' && existed ? fs.readFileSync(abs, 'utf8') + content : content;
  atomicWrite(abs, final);

  return {
    path: rel,
    action: existed ? 'modified' : 'created',
    bytes: Buffer.byteLength(final, 'utf8'),
    lines: final.split('\n').length,
  };
}

export interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface EditResult {
  path: string;
  editsApplied: number;
  replacements: number;
  linesBefore: number;
  linesAfter: number;
  preview: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * When an anchor does not match, the cause is almost always whitespace or a
 * stale line. Say which, instead of "not found".
 */
function diagnoseMissingAnchor(content: string, anchor: string): string {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (squash(content).includes(squash(anchor))) {
    return 'The text exists but with different whitespace/indentation. Re-read the file and copy the exact characters.';
  }
  const firstLine = anchor.split('\n').find((l) => l.trim().length > 3)?.trim();
  if (firstLine && content.includes(firstLine)) {
    return `The first line ("${firstLine.slice(0, 60)}") is present but the following lines differ. Re-read that region.`;
  }
  return 'No part of the anchor was found. Re-read the file — it may have changed since you last read it.';
}

export function editFile(root: string, relPath: string, edits: EditSpec[]): EditResult {
  if (edits.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'edits must not be empty');

  const { abs, rel } = resolvePath(root, relPath, { mustExist: true });
  const original = fs.readFileSync(abs, 'utf8');
  let content = original;
  let replacements = 0;

  for (const [i, edit] of edits.entries()) {
    if (edit.oldString === edit.newString) {
      throw new BridgeError('INVALID_ARGUMENT', `Edit ${i + 1}: old_string and new_string are identical.`);
    }
    if (!edit.oldString) {
      throw new BridgeError('INVALID_ARGUMENT', `Edit ${i + 1}: old_string must not be empty. Use write_file to create a file.`);
    }

    const occurrences = countOccurrences(content, edit.oldString);
    if (occurrences === 0) {
      throw new BridgeError('PATCH_FAILED', `Edit ${i + 1}: old_string not found in ${rel}.`, {
        hint: diagnoseMissingAnchor(content, edit.oldString),
      });
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new BridgeError('PATCH_FAILED', `Edit ${i + 1}: old_string appears ${occurrences} times in ${rel}.`, {
        hint: 'Include more surrounding context to make it unique, or set replace_all=true if every occurrence should change.',
      });
    }

    content = edit.replaceAll
      ? content.split(edit.oldString).join(edit.newString)
      : content.replace(edit.oldString, edit.newString);
    replacements += edit.replaceAll ? occurrences : 1;
  }

  atomicWrite(abs, content);

  return {
    path: rel,
    editsApplied: edits.length,
    replacements,
    linesBefore: original.split('\n').length,
    linesAfter: content.split('\n').length,
    preview: previewChange(original, content),
  };
}

/** Compact "first divergence" preview so the model can confirm the edit landed. */
function previewChange(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA + 1).slice(0, 12);
  const added = b.slice(start, endB + 1).slice(0, 12);
  const lines = [`@@ around line ${start + 1} @@`];
  for (const l of removed) lines.push(`- ${l}`);
  for (const l of added) lines.push(`+ ${l}`);
  return lines.join('\n');
}

export function movePath(root: string, from: string, to: string, overwrite = false): { from: string; to: string } {
  const src = resolvePath(root, from, { mustExist: true });
  const dst = resolvePath(root, to);

  if (fs.existsSync(dst.abs) && !overwrite) {
    throw new BridgeError('INVALID_ARGUMENT', `Destination already exists: ${dst.rel}`, {
      hint: 'Pass overwrite=true if replacing it is intended.',
    });
  }
  fs.mkdirSync(path.dirname(dst.abs), { recursive: true });
  fs.renameSync(src.abs, dst.abs);
  return { from: src.rel, to: dst.rel };
}

export function deletePath(root: string, relPath: string, recursive = false): { path: string; kind: 'file' | 'dir'; entries: number } {
  const { abs, rel } = resolvePath(root, relPath, { mustExist: true });
  if (rel === '.' || abs === root) {
    throw new BridgeError('DESTRUCTIVE_BLOCKED', 'Refusing to delete the workspace root.');
  }

  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    const entries = countEntries(abs);
    if (!recursive) {
      throw new BridgeError('INVALID_ARGUMENT', `${rel} is a directory (${entries} entries).`, {
        hint: 'Pass recursive=true to delete a directory tree.',
      });
    }
    fs.rmSync(abs, { recursive: true, force: true });
    return { path: rel, kind: 'dir', entries };
  }
  fs.rmSync(abs, { force: true });
  return { path: rel, kind: 'file', entries: 1 };
}

/** Bounded count — used to describe a delete before doing it. */
export function countEntries(dir: string, cap = 5000): number {
  let count = 0;
  const stack = [dir];
  while (stack.length && count < cap) {
    const current = stack.pop()!;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      count++;
      if (count >= cap) break;
      if (item.isDirectory()) stack.push(path.join(current, item.name));
    }
  }
  return count;
}

export function createDir(root: string, relPath: string): { path: string; created: boolean } {
  const { abs, rel } = resolvePath(root, relPath);
  const existed = fs.existsSync(abs);
  fs.mkdirSync(abs, { recursive: true });
  return { path: rel, created: !existed };
}

export function statPath(root: string, relPath: string): DirEntry & { exists: boolean } {
  const { abs, rel } = resolvePath(root, relPath, { allowSecrets: true });
  if (!fs.existsSync(abs)) {
    return { name: path.basename(rel), path: rel, type: 'file', exists: false };
  }
  const st = fs.statSync(abs);
  return {
    name: path.basename(rel),
    path: rel,
    type: st.isDirectory() ? 'dir' : 'file',
    size: st.size,
    modified: st.mtime.toISOString(),
    exists: true,
  };
}

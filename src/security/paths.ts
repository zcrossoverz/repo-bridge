/**
 * Workspace sandbox.
 *
 * Every path the model supplies passes through `resolvePath` before any fs call.
 * Three escapes are closed:
 *   - lexical traversal ("../../etc/passwd")           → normalise then containment-check
 *   - absolute paths outside the root                  → containment-check
 *   - symlinks pointing outside the root               → realpath the deepest existing ancestor
 *
 * The containment check runs against the *realpath* of the workspace root, so a
 * workspace that is itself reached through a symlink still works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { isSecretPath, isSecretTemplate } from './secrets.js';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function norm(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(norm(path.resolve(parent)), norm(path.resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** realpath if it exists, otherwise the nearest existing ancestor's realpath + remainder. */
export function realpathTolerant(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];

  // Walk up until something exists. Bounded by the number of path segments.
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw e;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // hit the filesystem root
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

export interface ResolveOptions {
  /** Reading a credential file is refused unless the caller opts out. */
  allowSecrets?: boolean;
  /** Writes into `.git/` internals are refused; git tools set this. */
  allowGitInternals?: boolean;
  /** Fail if the path does not exist. */
  mustExist?: boolean;
}

export interface ResolvedPath {
  /** Absolute host path, symlinks resolved. */
  abs: string;
  /** POSIX-style path relative to the workspace root — what the model sees. */
  rel: string;
}

/**
 * @param root       absolute workspace root (already trusted)
 * @param userPath   whatever the model sent: relative, absolute, `.`, with either separator
 */
export function resolvePath(root: string, userPath: string, opts: ResolveOptions = {}): ResolvedPath {
  if (typeof userPath !== 'string') {
    throw new BridgeError('INVALID_ARGUMENT', 'path must be a string');
  }
  // Reject NUL bytes outright — they truncate paths in some syscalls.
  if (userPath.includes('\0')) {
    throw new BridgeError('INVALID_ARGUMENT', 'path contains a NUL byte');
  }

  const cleaned = userPath.trim().replace(/^["']|["']$/g, '');
  const realRoot = realpathTolerant(root);

  const candidate = path.isAbsolute(cleaned) || /^[a-zA-Z]:[\\/]/.test(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(realRoot, cleaned);

  // Lexical check first (cheap, catches the common case before touching disk).
  if (!isInside(realRoot, candidate)) {
    throw new BridgeError(
      'PATH_OUTSIDE_WORKSPACE',
      `Path escapes the workspace: ${userPath}`,
      { hint: `Paths must stay inside the active workspace. Use a path relative to the workspace root.` },
    );
  }

  // Then the symlink-aware check.
  const real = realpathTolerant(candidate);
  if (!isInside(realRoot, real)) {
    throw new BridgeError(
      'PATH_OUTSIDE_WORKSPACE',
      `Path resolves outside the workspace through a symlink: ${userPath}`,
      { hint: 'Symlinks leaving the workspace are not followed.' },
    );
  }

  const rel = path.relative(realRoot, real).split(path.sep).join('/') || '.';

  if (!opts.allowGitInternals && (rel === '.git' || rel.startsWith('.git/'))) {
    throw new BridgeError(
      'PERMISSION_DENIED',
      'Direct access to .git internals is not allowed.',
      { hint: 'Use the git_* tools instead of reading or writing .git/ by hand.' },
    );
  }

  if (!opts.allowSecrets && isSecretPath(rel) && !isSecretTemplate(rel)) {
    throw new BridgeError(
      'SECRET_BLOCKED',
      `Refusing to expose credential file: ${rel}`,
      {
        hint:
          'Credential files are never sent to the model. If the project needs these values, ' +
          'set them in the bridge host environment — commands inherit them without revealing them.',
      },
    );
  }

  if (opts.mustExist && !fs.existsSync(real)) {
    throw new BridgeError('PATH_NOT_FOUND', `No such file or directory: ${rel}`);
  }

  return { abs: real, rel };
}

/** Directory names never worth walking into during search/tree operations. */
export const ALWAYS_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'target',
  '.gradle',
  '.mvn/wrapper',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.idea',
  '.vscode',
  '.terraform',
  'vendor',
  'coverage',
  '.turbo',
  '.cache',
  'bin',
  'obj',
  'Pods',
  '.dart_tool',
]);

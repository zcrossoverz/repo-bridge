/**
 * File operations, search, glob and gitignore behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deletePath, editFile, listDir, movePath, readFile, writeFile } from '../fs/ops.js';
import { findFiles, searchCode } from '../fs/search.js';
import { globToRegExp, makeMatcher } from '../fs/glob.js';
import { GitIgnore } from '../fs/gitignore.js';
import { smartTruncate } from '../exec/runner.js';
import { parseStatus } from '../git/git.js';
import { parseRepoSpec } from '../forge/remote.js';
import { BridgeError } from '../errors.js';

function fixture(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-fs-')));
  fs.mkdirSync(path.join(root, 'src', 'service'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'service', 'RiskService.ts'),
    ['export class RiskService {', '  calculate(): number {', '    return 42;', '  }', '}', ''].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'import { RiskService } from "./service/RiskService";\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'RiskService.ts'), 'should never be searched\n');
  fs.writeFileSync(path.join(root, 'build', 'out.js'), 'RiskService compiled\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n*.log\n');
  fs.writeFileSync(path.join(root, 'debug.log'), 'RiskService noise\n');
  return root;
}

// ── read / write ─────────────────────────────────────────────────────────────

test('readFile returns exact content and line metadata', () => {
  const root = fixture();
  const res = readFile(root, 'src/service/RiskService.ts');
  assert.equal(res.totalLines, 6);
  assert.ok(res.content.startsWith('export class RiskService {'));
  assert.equal(res.truncated, false);
});

test('readFile supports line ranges', () => {
  const root = fixture();
  const res = readFile(root, 'src/service/RiskService.ts', { startLine: 2, endLine: 3 });
  assert.equal(res.content, '  calculate(): number {\n    return 42;');
  assert.equal(res.truncated, true);
});

test('writeFile create refuses to clobber an existing file', () => {
  const root = fixture();
  assert.throws(
    () => writeFile(root, 'src/index.ts', 'nope', 'create'),
    (e: BridgeError) => e.code === 'INVALID_ARGUMENT',
  );
  const res = writeFile(root, 'src/new/Deep.ts', 'export const a = 1;\n', 'create');
  assert.equal(res.action, 'created');
  assert.ok(fs.existsSync(path.join(root, 'src', 'new', 'Deep.ts')));
});

test('writeFile append adds to the end', () => {
  const root = fixture();
  writeFile(root, 'src/index.ts', 'export const extra = 1;\n', 'append');
  assert.match(fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8'), /extra/);
});

// ── editing ──────────────────────────────────────────────────────────────────

test('editFile replaces a unique anchor', () => {
  const root = fixture();
  const res = editFile(root, 'src/service/RiskService.ts', [{ oldString: 'return 42;', newString: 'return 43;' }]);
  assert.equal(res.replacements, 1);
  assert.match(fs.readFileSync(path.join(root, 'src', 'service', 'RiskService.ts'), 'utf8'), /return 43;/);
  assert.match(res.preview, /^@@ around line 3/m);
});

test('editFile refuses an ambiguous anchor and leaves the file untouched', () => {
  const root = fixture();
  const file = path.join(root, 'dup.ts');
  fs.writeFileSync(file, 'const a = 1;\nconst a = 1;\n');
  assert.throws(
    () => editFile(root, 'dup.ts', [{ oldString: 'const a = 1;', newString: 'const a = 2;' }]),
    (e: BridgeError) => e.code === 'PATCH_FAILED' && /appears 2 times/.test(e.message),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 1;\nconst a = 1;\n');
});

test('editFile replace_all changes every occurrence', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'dup.ts'), 'const a = 1;\nconst a = 1;\n');
  const res = editFile(root, 'dup.ts', [{ oldString: 'const a = 1;', newString: 'const a = 2;', replaceAll: true }]);
  assert.equal(res.replacements, 2);
});

test('editFile explains a whitespace mismatch instead of just failing', () => {
  const root = fixture();
  try {
    editFile(root, 'src/service/RiskService.ts', [{ oldString: 'calculate():   number {', newString: 'calculate(): string {' }]);
    assert.fail('expected PATCH_FAILED');
  } catch (e) {
    const err = e as BridgeError;
    assert.equal(err.code, 'PATCH_FAILED');
    assert.match(err.hint ?? '', /whitespace/i);
  }
});

test('editFile applies multiple edits atomically', () => {
  const root = fixture();
  assert.throws(() =>
    editFile(root, 'src/service/RiskService.ts', [
      { oldString: 'return 42;', newString: 'return 44;' },
      { oldString: 'does not exist anywhere', newString: 'x' },
    ]),
  );
  // The first edit must not have been persisted.
  assert.match(fs.readFileSync(path.join(root, 'src', 'service', 'RiskService.ts'), 'utf8'), /return 42;/);
});

// ── move / delete / list ─────────────────────────────────────────────────────

test('movePath renames within the workspace', () => {
  const root = fixture();
  const res = movePath(root, 'src/index.ts', 'src/main.ts');
  assert.equal(res.to, 'src/main.ts');
  assert.ok(fs.existsSync(path.join(root, 'src', 'main.ts')));
});

test('deletePath needs recursive for directories and refuses the root', () => {
  const root = fixture();
  assert.throws(() => deletePath(root, 'src', false), (e: BridgeError) => e.code === 'INVALID_ARGUMENT');
  assert.throws(() => deletePath(root, '.', true), (e: BridgeError) => e.code === 'DESTRUCTIVE_BLOCKED');
  const res = deletePath(root, 'src/index.ts');
  assert.equal(res.kind, 'file');
});

test('listDir skips build output and node_modules', () => {
  const root = fixture();
  const { entries } = listDir(root, '.', { depth: 3 });
  const paths = entries.map((e) => e.path);
  assert.ok(paths.includes('src'));
  assert.equal(paths.some((p) => p.startsWith('node_modules/')), false);
});

// ── search ───────────────────────────────────────────────────────────────────

test('searchCode finds matches and respects .gitignore and skip dirs', async () => {
  const root = fixture();
  const res = await searchCode(root, { pattern: 'RiskService', maxResults: 50 });
  const files = new Set(res.matches.map((m) => m.path));
  assert.ok(files.has('src/service/RiskService.ts'));
  assert.ok(files.has('src/index.ts'));
  assert.equal([...files].some((f) => f.startsWith('node_modules/')), false, 'node_modules must be skipped');
  assert.equal([...files].some((f) => f.startsWith('build/')), false, '.gitignore must be honoured');
  assert.equal(files.has('debug.log'), false, '*.log must be honoured');
});

test('searchCode supports regex and include globs', async () => {
  const root = fixture();
  const res = await searchCode(root, { pattern: 'return \\d+', regex: true, include: ['**/*.ts'] });
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0]?.line, 3);
});

test('searchCode rejects an invalid regular expression clearly', async () => {
  const root = fixture();
  await assert.rejects(
    () => searchCode(root, { pattern: '([unclosed', regex: true }),
    (e: BridgeError) => e.code === 'INVALID_ARGUMENT',
  );
});

test('searchCode follows symlinks that stay inside the workspace', async (t) => {
  const root = fixture();
  const linked = path.join(root, 'packages-src');
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, 'Linked.ts'), 'export const RiskService = "linked";\n');

  try {
    // Junctions work on Windows without elevation; symlinks usually do not.
    fs.symlinkSync(linked, path.join(root, 'packages'), 'junction');
  } catch {
    t.skip('cannot create symlinks in this environment');
    return;
  }

  const res = await searchCode(root, { pattern: 'RiskService', maxResults: 50 });
  const files = new Set(res.matches.map((m) => m.path));
  assert.ok([...files].some((f) => f.startsWith('packages/')), 'a workspace-internal symlink must be searched');
});

test('searchCode does not follow a symlink out of the workspace', async (t) => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-outside-'));
  fs.writeFileSync(path.join(outside, 'Secret.ts'), 'export const RiskService = "leaked";\n');

  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  } catch {
    t.skip('cannot create symlinks in this environment');
    return;
  }

  const res = await searchCode(root, { pattern: 'RiskService', maxResults: 50 });
  assert.equal(
    res.matches.some((m) => m.text.includes('leaked')),
    false,
    'content outside the workspace must never appear in results',
  );
});

test('a symlink cycle does not hang the walk', async (t) => {
  const root = fixture();
  const inner = path.join(root, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'Cycle.ts'), 'export const RiskService = 1;\n');

  try {
    fs.symlinkSync(root, path.join(inner, 'loop'), 'junction');
  } catch {
    t.skip('cannot create symlinks in this environment');
    return;
  }

  const res = await searchCode(root, { pattern: 'RiskService', maxResults: 200 });
  assert.ok(res.matches.length > 0);
  assert.ok(res.elapsedMs < 20_000, 'the walk must terminate');
});

test('findFiles matches bare patterns anywhere in the tree', () => {
  const root = fixture();
  const { files } = findFiles(root, ['*.ts']);
  assert.ok(files.includes('src/service/RiskService.ts'));
  assert.equal(files.some((f) => f.startsWith('node_modules/')), false);
});

// ── glob + gitignore ─────────────────────────────────────────────────────────

test('globToRegExp implements the supported subset', () => {
  assert.equal(globToRegExp('src/**/*.ts', true).test('src/a/b/c.ts'), true);
  assert.equal(globToRegExp('src/**/*.ts', true).test('src/c.ts'), true);
  assert.equal(globToRegExp('*.ts', true).test('a/b.ts'), false);
  assert.equal(globToRegExp('**/{a,b}.ts', true).test('x/b.ts'), true);
  assert.equal(globToRegExp('file?.txt', true).test('file1.txt'), true);
});

test('makeMatcher treats a bare pattern as "anywhere"', () => {
  const m = makeMatcher(['*.java']);
  assert.equal(m('src/main/java/Foo.java'), true);
  assert.equal(m('Foo.kt'), false);
});

test('GitIgnore honours negation, anchoring and directory rules', () => {
  const ig = new GitIgnore().add(['build/', '*.log', '!keep.log', '/root-only.txt', 'docs/**/*.tmp'].join('\n'));
  assert.equal(ig.ignores('build/'), true);
  assert.equal(ig.ignores('build/out.js'), true);
  assert.equal(ig.ignores('src/build.ts'), false);
  assert.equal(ig.ignores('a.log'), true);
  assert.equal(ig.ignores('keep.log'), false);
  assert.equal(ig.ignores('root-only.txt'), true);
  assert.equal(ig.ignores('sub/root-only.txt'), false);
  assert.equal(ig.ignores('docs/a/b.tmp'), true);
});

// ── output truncation ────────────────────────────────────────────────────────

test('smartTruncate keeps head, tail and error lines', () => {
  const lines: string[] = [];
  for (let i = 0; i < 4000; i++) lines.push(`filler line ${i} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
  lines[2000] = 'ERROR: NullPointerException in PortfolioRiskService.calculate';
  lines.push('BUILD FAILED');
  const { text, truncated } = smartTruncate(lines.join('\n'), 8000);

  assert.equal(truncated, true);
  assert.ok(text.includes('filler line 0'), 'head kept');
  assert.ok(text.includes('BUILD FAILED'), 'tail kept');
  assert.ok(text.includes('NullPointerException'), 'error line rescued from the middle');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 8000);
});

test('smartTruncate leaves small output alone', () => {
  const { text, truncated } = smartTruncate('all good\n', 1000);
  assert.equal(truncated, false);
  assert.equal(text, 'all good\n');
});

// ── git status parsing ───────────────────────────────────────────────────────

test('parseStatus reads porcelain v2 output', () => {
  const raw = [
    '# branch.oid abcdef1234',
    '# branch.head feat/alerts',
    '# branch.upstream origin/feat/alerts',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb src/Service.java',
    '1 .M N... 100644 100644 100644 ccc ddd src/Other.java',
    '? new-file.txt',
    '',
  ].join('\0');

  const status = parseStatus(raw);
  assert.equal(status.branch, 'feat/alerts');
  assert.equal(status.upstream, 'origin/feat/alerts');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.staged.map((f) => f.path), ['src/Service.java']);
  assert.deepEqual(status.unstaged.map((f) => f.path), ['src/Other.java']);
  assert.deepEqual(status.untracked, ['new-file.txt']);
  assert.equal(status.clean, false);
});

test('parseStatus reports a clean tree', () => {
  const status = parseStatus(['# branch.head main', ''].join('\0'));
  assert.equal(status.clean, true);
  assert.equal(status.branch, 'main');
});

// ── repository references ────────────────────────────────────────────────────

test('parseRepoSpec understands every common form', () => {
  const cases: Array<[string, { provider: string; owner: string; repo: string }]> = [
    ['github:acme/quantix', { provider: 'github', owner: 'acme', repo: 'quantix' }],
    ['https://github.com/acme/quantix.git', { provider: 'github', owner: 'acme', repo: 'quantix' }],
    ['https://github.com/acme/quantix', { provider: 'github', owner: 'acme', repo: 'quantix' }],
    ['git@github.com:acme/quantix.git', { provider: 'github', owner: 'acme', repo: 'quantix' }],
    ['gitlab:group/sub/quantix', { provider: 'gitlab', owner: 'group/sub', repo: 'quantix' }],
    ['https://gitlab.example.com/team/quantix.git', { provider: 'gitlab', owner: 'team', repo: 'quantix' }],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseRepoSpec(input);
    assert.equal(parsed.provider, expected.provider, input);
    assert.equal(parsed.owner, expected.owner, input);
    assert.equal(parsed.repo, expected.repo, input);
  }
});

test('parseRepoSpec strips credentials pasted into a URL', () => {
  const parsed = parseRepoSpec('https://user:ghp_secrettokenvalue123456@github.com/acme/quantix.git');
  assert.equal(parsed.cloneUrl.includes('ghp_'), false);
  assert.equal(parsed.repo, 'quantix');
});

test('parseRepoSpec recognises local paths as non-forge remotes', () => {
  for (const local of ['C:\\repos\\sample-app-remote.git', '/srv/git/sample.git', '../sibling-repo']) {
    const parsed = parseRepoSpec(local);
    assert.equal(parsed.provider, 'other', local);
    assert.equal(parsed.host, 'local', local);
    assert.ok(parsed.repo.length > 0, local);
  }
});

test('parseRepoSpec rejects nonsense', () => {
  assert.throws(() => parseRepoSpec('   '), (e: BridgeError) => e.code === 'INVALID_ARGUMENT');
});

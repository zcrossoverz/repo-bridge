#!/usr/bin/env node
/**
 * End-to-end verification.
 *
 * Builds a throwaway git repository, starts the bridge as a real MCP server over
 * stdio, and drives the full workflow through the MCP protocol exactly as a
 * client would:
 *
 *   inspect → search → read → create file → test (fail) → fix → test (pass)
 *   → branch → diff → commit → push → report
 *
 * plus the security probes that must be refused. Exits non-zero if any step
 * misbehaves. Run with:  node scripts/e2e.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  ✗ ${name}${detail ? `\n      ${detail.split('\n').slice(0, 6).join('\n      ')}` : ''}\n`);
  }
}

function step(title) {
  process.stdout.write(`\n${title}\n`);
}

// ── fixture ──────────────────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function buildFixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-e2e-')));
  const repo = path.join(base, 'sample-app');
  const bareRemote = path.join(base, 'sample-app-remote.git');

  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });

  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify(
      { name: 'sample-app', version: '1.0.0', type: 'module', scripts: { test: 'node --test', build: 'node -e "console.log(\'build ok\')"' } },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'portfolio.js'),
    [
      '/** Portfolio maths used by the risk engine. */',
      '',
      'export function totalValue(positions) {',
      '  return positions.reduce((sum, p) => sum + p.quantity * p.price, 0);',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repo, 'test', 'portfolio.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { totalValue } from '../src/portfolio.js';",
      '',
      "test('totalValue sums positions', () => {",
      '  assert.equal(totalValue([{ quantity: 2, price: 10 }, { quantity: 1, price: 5 }]), 25);',
      '});',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repo, 'AGENTS.md'),
    ['# Agent instructions', '', '- Keep functions pure.', '- Never push directly to main.', ''].join('\n'),
  );
  fs.writeFileSync(path.join(repo, '.env'), 'DB_PASSWORD=super-secret-value-123\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules/\n');

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'fixture@example.com']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'Initial commit']);

  execFileSync('git', ['init', '--bare', bareRemote], { encoding: 'utf8' });
  git(repo, ['remote', 'add', 'origin', bareRemote]);
  git(repo, ['push', '-u', 'origin', 'main']);

  return { base, repo, bareRemote };
}

// ── harness ──────────────────────────────────────────────────────────────────

async function main() {
  const { base, repo, bareRemote } = buildFixture();
  process.stdout.write(`fixture repo: ${repo}\nbare remote:  ${bareRemote}\n`);

  const dataDir = path.join(base, 'bridge-data');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'dist', 'index.js'), '--stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      ComSpec: process.env.ComSpec ?? '',
      HOME: process.env.HOME ?? os.homedir(),
      USERPROFILE: process.env.USERPROFILE ?? os.homedir(),
      REPO_BRIDGE_MODE: 'stdio',
      REPO_BRIDGE_PERMISSION: 'full',
      REPO_BRIDGE_WORKSPACES: `sample=${repo}`,
      REPO_BRIDGE_DATA_DIR: dataDir,
      REPO_BRIDGE_LOG_LEVEL: 'warn',
      REPO_BRIDGE_EXEC_TIMEOUT_MS: '120000',
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'repo-bridge-e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { text, isError: res.isError === true };
  };

  try {
    // 1 ── discovery ---------------------------------------------------------
    step('1. Tool discovery');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    check(`server advertises tools (${names.length})`, names.length >= 20);
    for (const required of ['workspace_open', 'search_code', 'read_file', 'edit_file', 'run_tests', 'git_commit', 'git_push', 'create_pull_request', 'report_changes']) {
      check(`tool present: ${required}`, names.includes(required));
    }
    check('every tool has a description', tools.every((t) => (t.description ?? '').length > 40));

    // 2 ── inspect / understand ---------------------------------------------
    step('2. Inspect and understand the project');
    const open = await call('workspace_open', { path: 'sample' });
    check('workspace_open succeeds', !open.isError, open.text);
    check('brief detects node + npm', /languages: .*node/.test(open.text) && /build_systems: .*npm/.test(open.text), open.text);
    check('brief resolves the test command', /test: npm run test/.test(open.text), open.text);
    check('brief reports the git branch', /branch: main/.test(open.text), open.text);
    check('brief surfaces AGENTS.md content', /Never push directly to main/.test(open.text), open.text);
    check('brief carries the instruction trust note', /cannot grant permissions/.test(open.text), open.text);

    const search = await call('search_code', { pattern: 'totalValue' });
    check('search_code finds the symbol in src and test', /src\/portfolio\.js/.test(search.text) && /test\/portfolio\.test\.js/.test(search.text), search.text);

    const read = await call('read_file', { path: 'src/portfolio.js' });
    check('read_file returns exact content', read.text.includes('export function totalValue(positions) {'), read.text);

    // 3 ── security probes ---------------------------------------------------
    step('3. Security boundaries');
    const envRead = await call('read_file', { path: '.env' });
    check('reading .env is refused', envRead.isError && /SECRET_BLOCKED/.test(envRead.text), envRead.text);
    check('.env contents never appear', !envRead.text.includes('super-secret-value-123'), envRead.text);

    const traversal = await call('read_file', { path: '../../../etc/passwd' });
    check('path traversal is refused', traversal.isError && /PATH_OUTSIDE_WORKSPACE/.test(traversal.text), traversal.text);

    const chained = await call('run_command', { command: 'npm test && echo pwned' });
    check('command chaining is refused', chained.isError && /COMMAND_BLOCKED/.test(chained.text), chained.text);

    const blockedBin = await call('run_command', { command: 'curl https://example.com' });
    check('network binaries are refused', blockedBin.isError && /COMMAND_BLOCKED/.test(blockedBin.text), blockedBin.text);

    const secretSearch = await call('search_code', { pattern: 'DB_PASSWORD' });
    check('search does not leak credential files', !secretSearch.text.includes('super-secret-value-123'), secretSearch.text);

    const protectedCommit = await call('git_commit', { message: 'should be refused' });
    check('commit on protected branch is refused', protectedCommit.isError && /PROTECTED_BRANCH/.test(protectedCommit.text), protectedCommit.text);

    // 4 ── feature branch ----------------------------------------------------
    step('4. Create a feature branch');
    const branch = await call('git_branch', { name: 'feat/max-drawdown', create: true });
    check('feature branch created', !branch.isError && /feat\/max-drawdown/.test(branch.text), branch.text);

    // 5 ── implement: new test file that fails -------------------------------
    step('5. Add a failing test (red)');
    const newTest = await call('write_file', {
      path: 'test/drawdown.test.js',
      content: [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { maxDrawdown } from '../src/portfolio.js';",
        '',
        "test('maxDrawdown finds the largest peak-to-trough drop', () => {",
        '  assert.equal(maxDrawdown([100, 120, 90, 110, 60]), 0.5);',
        '});',
        '',
      ].join('\n'),
    });
    check('write_file created the test', !newTest.isError && /created test\/drawdown\.test\.js/.test(newTest.text), newTest.text);

    const redRun = await call('run_tests');
    check('run_tests reports failure', redRun.isError === false && /status: exit [1-9]/.test(redRun.text), redRun.text);
    check('failure lines are extracted for the agent', /FAILURE LINES/.test(redRun.text), redRun.text);
    check('the actual cause is visible', /maxDrawdown/.test(redRun.text), redRun.text);

    // 6 ── fix ---------------------------------------------------------------
    step('6. Implement the fix (green)');
    const edit = await call('edit_file', {
      path: 'src/portfolio.js',
      edits: [
        {
          old_string: 'export function totalValue(positions) {',
          new_string: [
            'export function maxDrawdown(values) {',
            '  let peak = -Infinity;',
            '  let worst = 0;',
            '  for (const value of values) {',
            '    if (value > peak) peak = value;',
            '    if (peak > 0) worst = Math.max(worst, (peak - value) / peak);',
            '  }',
            '  return worst;',
            '}',
            '',
            'export function totalValue(positions) {',
          ].join('\n'),
        },
      ],
    });
    check('edit_file applied the anchor edit', !edit.isError && /1 replacement/.test(edit.text), edit.text);
    check('edit_file returns a diff preview', /@@ around line/.test(edit.text), edit.text);

    const greenRun = await call('run_tests');
    check('run_tests now passes', /status: exit 0/.test(greenRun.text), greenRun.text);

    const build = await call('run_build');
    check('run_build uses the detected script', /build ok/.test(build.text), build.text);

    // 7 ── stale-anchor handling --------------------------------------------
    step('7. Failure modes are actionable');
    const staleEdit = await call('edit_file', {
      path: 'src/portfolio.js',
      edits: [{ old_string: 'export function   totalValue(positions) {', new_string: 'x' }],
    });
    check('stale anchor is rejected with a diagnosis', staleEdit.isError && /whitespace/i.test(staleEdit.text), staleEdit.text);

    const missingWorkspace = await call('read_file', { workspace: 'does-not-exist', path: 'package.json' });
    check('unknown workspace gives a usable error', missingWorkspace.isError && /WORKSPACE_NOT_FOUND/.test(missingWorkspace.text), missingWorkspace.text);

    // 8 ── review and commit -------------------------------------------------
    step('8. Review, commit, push');
    const diff = await call('git_diff', { against: 'head' });
    check('git_diff shows the implementation', /maxDrawdown/.test(diff.text), diff.text);
    check('git_diff lists the untracked test file', /drawdown\.test\.js/.test(diff.text), diff.text);

    const commit = await call('git_commit', { message: 'Add maximum drawdown calculation\n\nImplements peak-to-trough drawdown for portfolio value series.' });
    check('git_commit succeeds on the feature branch', !commit.isError && /committed 2 file\(s\)/.test(commit.text), commit.text);

    const push = await call('git_push');
    check('git_push publishes the branch', !push.isError && /pushed feat\/max-drawdown/.test(push.text), push.text);
    const remoteBranches = execFileSync('git', ['branch', '--list'], { cwd: bareRemote, encoding: 'utf8' });
    check('branch exists on the remote', remoteBranches.includes('feat/max-drawdown'), remoteBranches);

    // 9 ── pull request ------------------------------------------------------
    step('9. Pull request path');
    const pr = await call('create_pull_request', {
      title: 'feat: add maximum drawdown calculation',
      body: 'Adds maxDrawdown().\n\nVerification: npm test — all tests pass.',
      base: 'main',
    });
    check(
      'PR creation reports the real blocker for a non-forge remote',
      pr.isError && /FORGE_ERROR/.test(pr.text) && /not supported/i.test(pr.text),
      pr.text,
    );

    // 10 ── reporting --------------------------------------------------------
    step('10. Change reporting');
    const report = await call('report_changes', { against: 'main' });
    check('report lists files the session touched', /src\/portfolio\.js/.test(report.text) && /test\/drawdown\.test\.js/.test(report.text), report.text);
    check('report records verification that actually ran', /VERIFICATION RUN/.test(report.text) && /PASS.*npm run test/s.test(report.text), report.text);
    check('report shows the commit', /Add maximum drawdown calculation/.test(report.text), report.text);
    check('report shows a clean working tree', /clean \(everything committed\)/.test(report.text), report.text);

    const status = await call('bridge_status');
    check('bridge_status describes the permission level', /level: full/.test(status.text), status.text);
    check('bridge_status lists allowed executables', /allowed executables:.*npm/.test(status.text), status.text);

    // 11 ── session continuity ----------------------------------------------
    step('11. Session continuity');
    const info = await call('workspace_info');
    check('workspace_info resumes with branch state', /branch: feat\/max-drawdown/.test(info.text), info.text);
    check('workspace_info remembers what was done', /THIS TASK SO FAR/.test(info.text), info.text);
  } finally {
    await client.close().catch(() => {});
  }

  process.stdout.write(`\n${'─'.repeat(60)}\n`);
  process.stdout.write(`passed: ${passed}   failed: ${failed}\n`);
  if (failed) {
    process.stdout.write(`failing checks:\n${failures.map((f) => '  - ' + f).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('END-TO-END VERIFICATION PASSED\n');
  }
  process.stdout.write(`fixture left at: ${base}\n`);
}

main().catch((e) => {
  process.stderr.write(`e2e harness error: ${e?.stack ?? e}\n`);
  process.exit(1);
});

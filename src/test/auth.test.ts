/**
 * Authentication tests: OAuth store semantics, audience binding, consent-form
 * tickets, and the startup rules that stop an unauthenticated bridge reaching a
 * public interface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-auth-'));
process.env.REPO_BRIDGE_DATA_DIR = dataDir;
process.env.REPO_BRIDGE_MODE = 'http';
process.env.REPO_BRIDGE_AUTH = 'oauth';
process.env.REPO_BRIDGE_TOKEN = 'test-passphrase-0123456789abcdef';
process.env.REPO_BRIDGE_WORKSPACES = '';

const { OAuthStore, resourceMatches, safeEqual, sha256 } = await import('../auth/oauth-store.js');
const { loadConfig, resetConfigForTests } = await import('../config.js');
const { canonicalResource, protectedResourceMetadata, authorizationServerMetadata, parseForm } = await import('../auth/oauth-server.js');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-store-'));
  return new OAuthStore(dir);
}

function registerTestClient(store: InstanceType<typeof OAuthStore>) {
  return store.registerClient({
    clientName: 'ChatGPT',
    redirectUris: ['https://chatgpt.com/connector/oauth/abc123'],
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
  });
}

// ── metadata documents ───────────────────────────────────────────────────────

test('protected resource metadata points at this server and its authorization server', () => {
  const meta = protectedResourceMetadata('https://bridge.example.com');
  assert.equal(meta.resource, 'https://bridge.example.com/mcp');
  assert.deepEqual(meta.authorization_servers, ['https://bridge.example.com']);
  assert.deepEqual(meta.bearer_methods_supported, ['header']);
});

test('authorization server metadata advertises PKCE S256 and the required endpoints', () => {
  const meta = authorizationServerMetadata('https://bridge.example.com') as Record<string, string[] | string>;
  assert.equal(meta.issuer, 'https://bridge.example.com');
  assert.equal(meta.authorization_endpoint, 'https://bridge.example.com/oauth/authorize');
  assert.equal(meta.token_endpoint, 'https://bridge.example.com/oauth/token');
  assert.equal(meta.registration_endpoint, 'https://bridge.example.com/oauth/register');
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(meta.grant_types_supported, ['authorization_code', 'refresh_token']);
  // `plain` PKCE must never be offered.
  assert.equal((meta.code_challenge_methods_supported as string[]).includes('plain'), false);
});

test('canonical resource has no trailing slash and includes the MCP path', () => {
  assert.equal(canonicalResource('https://bridge.example.com'), 'https://bridge.example.com/mcp');
});

// ── audience binding ─────────────────────────────────────────────────────────

test('resourceMatches enforces audience while tolerating canonical variations', () => {
  assert.equal(resourceMatches('https://b.example.com/mcp', 'https://b.example.com/mcp'), true);
  assert.equal(resourceMatches('https://B.EXAMPLE.com/mcp', 'https://b.example.com/mcp'), true);
  assert.equal(resourceMatches('https://b.example.com/mcp/', 'https://b.example.com/mcp'), true);
  // A token for the server root is usable at /mcp beneath it.
  assert.equal(resourceMatches('https://b.example.com', 'https://b.example.com/mcp'), true);
  // Tokens issued for somewhere else must be refused.
  assert.equal(resourceMatches('https://evil.example.com/mcp', 'https://b.example.com/mcp'), false);
  assert.equal(resourceMatches('https://b.example.com/other', 'https://b.example.com/mcp'), false);
});

// ── client registration ──────────────────────────────────────────────────────

test('dynamic registration issues an id and a secret and persists the client', () => {
  const store = freshStore();
  const { client, clientSecret } = registerTestClient(store);

  assert.match(client.clientId, /^rbc_/);
  assert.ok(clientSecret && clientSecret.length > 20);
  assert.equal(store.getClient(client.clientId)?.clientName, 'ChatGPT');
  // Only the hash is kept.
  assert.equal(client.clientSecretHash, sha256(clientSecret!));
  assert.notEqual(client.clientSecretHash, clientSecret);
});

test('public clients authenticate without a secret, and a correct secret is still accepted', () => {
  const store = freshStore();
  const { client, clientSecret } = registerTestClient(store);

  // ChatGPT registers as `none` but has been seen sending a secret anyway.
  assert.equal(store.verifyClientSecret(client, undefined), true);
  assert.equal(store.verifyClientSecret(client, clientSecret), true);
  assert.equal(store.verifyClientSecret(client, 'wrong-secret'), false);
});

test('registered clients survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-store-'));
  const first = new OAuthStore(dir);
  const { client } = registerTestClient(first);

  const second = new OAuthStore(dir);
  assert.equal(second.getClient(client.clientId)?.clientId, client.clientId);
});

test('the oauth state file is not world-readable', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX permission bits do not apply on Windows');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-store-'));
  const store = new OAuthStore(dir);
  registerTestClient(store);
  const mode = fs.statSync(path.join(dir, 'oauth.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

// ── authorization codes ──────────────────────────────────────────────────────

test('authorization codes are single use', () => {
  const store = freshStore();
  const code = store.createAuthorizationCode({
    clientId: 'rbc_x',
    redirectUri: 'https://chatgpt.com/connector/oauth/abc',
    codeChallenge: 'challenge',
    resource: 'https://b.example.com/mcp',
    scope: 'mcp',
  });

  assert.ok(store.consumeAuthorizationCode(code));
  assert.equal(store.consumeAuthorizationCode(code), null, 'a replayed code must be refused');
});

test('an unknown authorization code is refused', () => {
  const store = freshStore();
  assert.equal(store.consumeAuthorizationCode('rbc_never_issued'), null);
});

// ── tokens ───────────────────────────────────────────────────────────────────

test('issued access tokens validate for their own resource only', () => {
  const store = freshStore();
  const resource = 'https://b.example.com/mcp';
  const { accessToken } = store.issueTokenPair({ clientId: 'rbc_x', resource, scope: 'mcp' });

  const good = store.validateAccessToken(accessToken, resource);
  assert.equal(good.ok, true);

  const wrongAudience = store.validateAccessToken(accessToken, 'https://other.example.com/mcp');
  assert.equal(wrongAudience.ok, false);
  assert.equal(wrongAudience.ok === false && wrongAudience.reason, 'wrong_audience');
});

test('an unknown or refresh token is not accepted as an access token', () => {
  const store = freshStore();
  const resource = 'https://b.example.com/mcp';
  const { refreshToken } = store.issueTokenPair({ clientId: 'rbc_x', resource, scope: 'mcp' });

  assert.equal(store.validateAccessToken('rba_made_up', resource).ok, false);
  const asAccess = store.validateAccessToken(refreshToken, resource);
  assert.equal(asAccess.ok, false);
  assert.equal(asAccess.ok === false && asAccess.reason, 'invalid_token');
});

test('access tokens expire', async () => {
  resetConfigForTests();
  process.env.REPO_BRIDGE_OAUTH_ACCESS_TTL = '1';
  loadConfig();

  const store = freshStore();
  const resource = 'https://b.example.com/mcp';
  const { accessToken } = store.issueTokenPair({ clientId: 'rbc_x', resource, scope: 'mcp' });
  assert.equal(store.validateAccessToken(accessToken, resource).ok, true);

  await new Promise((r) => setTimeout(r, 1100));
  const expired = store.validateAccessToken(accessToken, resource);
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.reason, 'expired_token');

  delete process.env.REPO_BRIDGE_OAUTH_ACCESS_TTL;
  resetConfigForTests();
  loadConfig();
});

test('refresh rotation invalidates the whole family, so a replayed token fails', () => {
  const store = freshStore();
  const resource = 'https://b.example.com/mcp';
  const first = store.issueTokenPair({ clientId: 'rbc_x', resource, scope: 'mcp' });

  const rotated = store.rotateRefreshToken(first.refreshToken, 'rbc_x');
  assert.ok(!('error' in rotated), 'first rotation should succeed');
  if ('error' in rotated) return;

  assert.notEqual(rotated.refreshToken, first.refreshToken);
  assert.equal(store.validateAccessToken(rotated.accessToken, resource).ok, true);
  // The superseded access token is gone too.
  assert.equal(store.validateAccessToken(first.accessToken, resource).ok, false);

  const replay = store.rotateRefreshToken(first.refreshToken, 'rbc_x');
  assert.ok('error' in replay && replay.error === 'invalid_grant', 'replayed refresh token must fail');
});

test('a refresh token cannot be redeemed by a different client', () => {
  const store = freshStore();
  const { refreshToken } = store.issueTokenPair({ clientId: 'rbc_owner', resource: 'https://b/mcp', scope: 'mcp' });
  const stolen = store.rotateRefreshToken(refreshToken, 'rbc_attacker');
  assert.ok('error' in stolen && stolen.error === 'invalid_grant');
});

test('revocation drops both halves of the pair', () => {
  const store = freshStore();
  const resource = 'https://b.example.com/mcp';
  const { accessToken, refreshToken } = store.issueTokenPair({ clientId: 'rbc_x', resource, scope: 'mcp' });

  assert.equal(store.revoke(accessToken), true);
  assert.equal(store.validateAccessToken(accessToken, resource).ok, false);
  assert.ok('error' in store.rotateRefreshToken(refreshToken, 'rbc_x'));
});

test('stats never expose token material', () => {
  const store = freshStore();
  store.issueTokenPair({ clientId: 'rbc_x', resource: 'https://b/mcp', scope: 'mcp' });
  const stats = store.stats();
  assert.equal(stats.activeAccessTokens, 1);
  assert.equal(stats.activeRefreshTokens, 1);
  assert.equal(JSON.stringify(stats).includes('rba_'), false);
});

// ── consent-form tickets (CSRF protection) ───────────────────────────────────

test('consent tickets round-trip and detect tampering', () => {
  const store = freshStore();
  const ticket = store.signTicket({ client_id: 'rbc_x', redirect_uri: 'https://chatgpt.com/cb', resource: 'https://b/mcp' });

  const verified = store.verifyTicket(ticket);
  assert.equal(verified?.client_id, 'rbc_x');

  const [payload] = ticket.split('.');
  const forged = Buffer.from(JSON.stringify({ client_id: 'rbc_evil', exp: Date.now() + 10_000 }), 'utf8').toString('base64url');
  assert.equal(store.verifyTicket(`${forged}.${ticket.split('.')[1]}`), null, 'payload swap must fail');
  assert.equal(store.verifyTicket(`${payload}.deadbeef`), null, 'signature swap must fail');
  assert.equal(store.verifyTicket('garbage'), null);
});

test('consent tickets expire', () => {
  const store = freshStore();
  const ticket = store.signTicket({ client_id: 'rbc_x' }, -1);
  assert.equal(store.verifyTicket(ticket), null);
});

test('a ticket signed by one installation is rejected by another', () => {
  const a = freshStore();
  const b = freshStore();
  assert.equal(b.verifyTicket(a.signTicket({ client_id: 'rbc_x' })), null);
});

// ── PKCE ─────────────────────────────────────────────────────────────────────

test('PKCE S256 verification matches the RFC 7636 construction', () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  assert.equal(safeEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge), true);
  assert.equal(safeEqual(crypto.createHash('sha256').update('other-verifier').digest('base64url'), challenge), false);
});

test('safeEqual compares without leaking length', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

// ── form parsing ─────────────────────────────────────────────────────────────

test('parseForm decodes url-encoded token requests', () => {
  const form = parseForm('grant_type=authorization_code&code=abc%2Fdef&code_verifier=xyz');
  assert.equal(form.grant_type, 'authorization_code');
  assert.equal(form.code, 'abc/def');
  assert.equal(form.code_verifier, 'xyz');
});

// ── startup rules ────────────────────────────────────────────────────────────

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = { ...process.env };
  resetConfigForTests();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    process.env = saved;
    resetConfigForTests();
  }
}

test('unauthenticated HTTP on a non-loopback interface is refused', () => {
  withEnv(
    { REPO_BRIDGE_MODE: 'http', REPO_BRIDGE_AUTH: 'none', REPO_BRIDGE_HOST: '0.0.0.0', REPO_BRIDGE_TOKEN: undefined, REPO_BRIDGE_ALLOW_INSECURE: undefined },
    () => {
      assert.throws(() => loadConfig(), /Refusing to expose an unauthenticated MCP server/);
    },
  );
});

test('unauthenticated HTTP is allowed on loopback', () => {
  withEnv(
    { REPO_BRIDGE_MODE: 'http', REPO_BRIDGE_AUTH: 'none', REPO_BRIDGE_HOST: '127.0.0.1', REPO_BRIDGE_TOKEN: undefined },
    () => {
      assert.equal(loadConfig().auth.mode, 'none');
    },
  );
});

test('the insecure override is honoured but explicit', () => {
  withEnv(
    {
      REPO_BRIDGE_MODE: 'http',
      REPO_BRIDGE_AUTH: 'none',
      REPO_BRIDGE_HOST: '0.0.0.0',
      REPO_BRIDGE_TOKEN: undefined,
      REPO_BRIDGE_ALLOW_INSECURE: 'true',
    },
    () => {
      assert.equal(loadConfig().auth.mode, 'none');
    },
  );
});

test('oauth and path-token both require a token', () => {
  for (const mode of ['oauth', 'path-token']) {
    withEnv({ REPO_BRIDGE_MODE: 'http', REPO_BRIDGE_AUTH: mode, REPO_BRIDGE_TOKEN: undefined }, () => {
      assert.throws(() => loadConfig(), /requires REPO_BRIDGE_TOKEN/, mode);
    });
  }
});

test('short tokens are refused', () => {
  withEnv({ REPO_BRIDGE_MODE: 'http', REPO_BRIDGE_AUTH: 'oauth', REPO_BRIDGE_TOKEN: 'too-short' }, () => {
    assert.throws(() => loadConfig(), /at least 24 characters/);
  });
});

test('an existing REPO_BRIDGE_TOKEN deployment keeps working as path-token', () => {
  withEnv({ REPO_BRIDGE_MODE: 'http', REPO_BRIDGE_AUTH: undefined, REPO_BRIDGE_TOKEN: 'legacy-token-0123456789abcdefgh' }, () => {
    assert.equal(loadConfig().auth.mode, 'path-token');
  });
});

test('HTTP mode with no auth configuration at all is refused with instructions', () => {
  withEnv({ REPO_BRIDGE_MODE: 'http', REPO_BRIDGE_AUTH: undefined, REPO_BRIDGE_TOKEN: undefined, REPO_BRIDGE_ALLOW_NO_AUTH: undefined }, () => {
    assert.throws(() => loadConfig(), /needs an authentication mode/);
  });
});

test('stdio mode needs no HTTP authentication', () => {
  withEnv({ REPO_BRIDGE_MODE: 'stdio', REPO_BRIDGE_AUTH: undefined, REPO_BRIDGE_TOKEN: undefined }, () => {
    assert.equal(loadConfig().mode, 'stdio');
  });
});

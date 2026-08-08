#!/usr/bin/env node
/**
 * HTTP transport + authentication check.
 *
 * Starts the bridge twice — once in path-token mode, once in oauth mode — and
 * exercises both, including a complete OAuth 2.1 authorization-code + PKCE flow
 * driven exactly as ChatGPT would drive it:
 *
 *   discover protected resource metadata → discover authorization server
 *   → dynamically register a client → authorize (consent form) → exchange the
 *   code with a PKCE verifier → call MCP with the bearer token → refresh
 *   → revoke
 *
 * plus the refusals that matter: no token, wrong token, replayed code, wrong
 * PKCE verifier, wrong audience, unregistered redirect URI, non-S256 challenge.
 *
 * Run with:  node scripts/http-check.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'e2e-test-token-0123456789abcdef0123456789';
const REDIRECT_URI = 'http://127.0.0.1:9999/callback';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}\n`);
  }
}

function step(title) {
  process.stdout.write(`\n${title}\n`);
}

async function waitForHealth(base, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server at ${base} did not start in time`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function startBridge({ port, auth, workspace, dataDir, extraEnv = {} }) {
  return spawn(process.execPath, [path.join(projectRoot, 'dist', 'index.js'), '--http'], {
    env: {
      ...process.env,
      REPO_BRIDGE_MODE: 'http',
      REPO_BRIDGE_HOST: '127.0.0.1',
      REPO_BRIDGE_PORT: String(port),
      REPO_BRIDGE_AUTH: auth,
      REPO_BRIDGE_TOKEN: TOKEN,
      REPO_BRIDGE_PERMISSION: 'develop',
      REPO_BRIDGE_WORKSPACES: `demo=${workspace}`,
      REPO_BRIDGE_DATA_DIR: dataDir,
      REPO_BRIDGE_LOG_LEVEL: 'error',
      ...extraEnv,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

const mcpBody = (method, id = 1, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

// ── path-token mode ──────────────────────────────────────────────────────────

async function checkPathTokenMode(base, workspace) {
  step('A. path-token mode (development fallback)');

  const health = await waitForHealth(base);
  check('/health responds without credentials', health.status === 'ok', JSON.stringify(health));
  check('/health reports the auth mode', health.auth === 'path-token', JSON.stringify(health));

  const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: mcpBody('tools/list') });
  check('missing token is rejected', unauth.status === 401, `status ${unauth.status}`);

  const wrong = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: 'Bearer wrong-token-value-aaaaaaaaaaaaaaaaaaaa' },
    body: mcpBody('tools/list'),
  });
  check('wrong token is rejected', wrong.status === 401, `status ${wrong.status}`);
  const wrongBody = await wrong.text();
  check('rejection does not echo the expected token', !wrongBody.includes(TOKEN), wrongBody);

  const client = new Client({ name: 'http-check', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  const { tools } = await client.listTools();
  check(`bearer header authenticates (${tools.length} tools)`, tools.length > 10);
  check('permission level hides push tools', !tools.some((t) => t.name === 'git_push'));

  const status = await client.callTool({ name: 'bridge_status', arguments: {} });
  const statusText = (status.content ?? []).map((c) => c.text ?? '').join('\n');
  check('tool call over HTTP works', /level: develop/.test(statusText), statusText);
  check('bridge_status reports the auth mode', /path-token/.test(statusText), statusText);
  check('bridge_status separates auth from permission', /does NOT affect the permission level/i.test(statusText), statusText);
  await client.close();

  const pathClient = new Client({ name: 'http-check-path', version: '1.0.0' }, { capabilities: {} });
  await pathClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)));
  check('token in the URL path also authenticates', (await pathClient.listTools()).tools.length > 10);
  await pathClient.close();

  const opened = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
    body: mcpBody('tools/call', 2, { name: 'workspace_open', arguments: { path: 'demo' } }),
  });
  check('workspace opens over HTTP', opened.status === 200 && (await opened.text()).includes('alias: demo'), `status ${opened.status}`);
  check('workspace fixture is the one configured', fs.existsSync(path.join(workspace, 'README.md')));
}

// ── oauth mode ───────────────────────────────────────────────────────────────

async function checkOAuthMode(base) {
  step('B. OAuth 2.1 discovery (what ChatGPT does first)');

  const health = await waitForHealth(base);
  check('/health works without a token in oauth mode', health.auth === 'oauth', JSON.stringify(health));

  // 1. Unauthenticated MCP request must advertise where to authenticate.
  const challenge = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: mcpBody('tools/list') });
  const wwwAuth = challenge.headers.get('www-authenticate') ?? '';
  check('unauthenticated MCP request returns 401', challenge.status === 401, `status ${challenge.status}`);
  check('401 carries WWW-Authenticate: Bearer', /^Bearer/.test(wwwAuth), wwwAuth);
  check('WWW-Authenticate advertises resource_metadata (RFC 9728)', /resource_metadata="[^"]+oauth-protected-resource"/.test(wwwAuth), wwwAuth);

  // 2. Protected resource metadata.
  const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
  const prm = await (await fetch(prmUrl)).json();
  check('protected resource metadata is served at the advertised URL', prm.resource === `${base}/mcp`, JSON.stringify(prm));
  check('metadata names an authorization server', Array.isArray(prm.authorization_servers) && prm.authorization_servers[0] === base, JSON.stringify(prm));

  const prmPathed = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  check('path-suffixed metadata URL also resolves', prmPathed.status === 200);

  // 3. Authorization server metadata.
  const asm = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  check('authorization server metadata is served', asm.issuer === base, JSON.stringify(asm));
  check('PKCE S256 is advertised', asm.code_challenge_methods_supported?.includes('S256'), JSON.stringify(asm.code_challenge_methods_supported));
  check('plain PKCE is NOT advertised', !asm.code_challenge_methods_supported?.includes('plain'));
  check('registration endpoint is advertised (DCR)', typeof asm.registration_endpoint === 'string', asm.registration_endpoint);
  check('refresh_token grant is advertised', asm.grant_types_supported?.includes('refresh_token'));

  step('C. Dynamic client registration');

  const badRedirect = await fetch(asm.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Bad', redirect_uris: ['http://evil.example.com/cb'] }),
  });
  check('non-HTTPS non-loopback redirect URI is refused', badRedirect.status === 400, `status ${badRedirect.status}`);

  const regRes = await fetch(asm.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const registration = await regRes.json();
  check('registration returns 201 with a client_id', regRes.status === 201 && typeof registration.client_id === 'string', JSON.stringify(registration));
  check('registration echoes the redirect URI', registration.redirect_uris?.[0] === REDIRECT_URI);
  check('client_secret_expires_at is 0 (never expires)', registration.client_secret_expires_at === 0);

  step('D. Authorization code flow with PKCE');

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challengeValue = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('hex');
  const resource = `${base}/mcp`;

  const authorizeUrl = (overrides = {}) => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challengeValue,
      code_challenge_method: 'S256',
      state,
      scope: 'mcp',
      resource,
      ...overrides,
    });
    return `${asm.authorization_endpoint}?${params}`;
  };

  const unknownClient = await fetch(authorizeUrl({ client_id: 'rbc_not_registered' }), { redirect: 'manual' });
  check('unknown client_id is refused without redirecting', unknownClient.status === 400, `status ${unknownClient.status}`);

  const badUri = await fetch(authorizeUrl({ redirect_uri: 'http://127.0.0.1:9999/not-registered' }), { redirect: 'manual' });
  check('unregistered redirect_uri is refused without redirecting', badUri.status === 400, `status ${badUri.status}`);

  const plainPkce = await fetch(authorizeUrl({ code_challenge_method: 'plain' }), { redirect: 'manual' });
  const plainLocation = plainPkce.headers.get('location') ?? '';
  check('plain PKCE is rejected', plainPkce.status === 302 && /error=invalid_request/.test(plainLocation), plainLocation);

  const foreignResource = await fetch(authorizeUrl({ resource: 'https://evil.example.com/mcp' }), { redirect: 'manual' });
  check('a foreign resource indicator is rejected', /error=invalid_target/.test(foreignResource.headers.get('location') ?? ''), foreignResource.headers.get('location'));

  // The consent page a human sees.
  const consentRes = await fetch(authorizeUrl());
  const consentHtml = await consentRes.text();
  check('consent page renders', consentRes.status === 200 && /Authorize access to repo-bridge/.test(consentHtml));
  check('consent page names the client', /ChatGPT/.test(consentHtml));
  check('consent page shows the permission level', /develop/.test(consentHtml), '');
  check('consent page states that authorizing does not raise permission', /does <strong>not<\/strong> raise the level/.test(consentHtml));
  check('consent page does not contain the passphrase', !consentHtml.includes(TOKEN));

  const ticket = /name="ticket" value="([^"]+)"/.exec(consentHtml)?.[1];
  check('consent form carries a signed ticket', typeof ticket === 'string' && ticket.includes('.'));

  // Browsers apply form-action to the redirect that follows a submission, so a
  // bare 'self' silently blocks the last step of the flow in Chrome.
  const csp = consentRes.headers.get('content-security-policy') ?? '';
  const redirectOrigin = new URL(REDIRECT_URI).origin;
  check('CSP allows redirecting to the registered callback', new RegExp(`form-action [^;]*${redirectOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(csp), csp);
  check('CSP still blocks scripts and external content', /default-src 'none'/.test(csp), csp);

  const wrongPass = await fetch(asm.authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, passphrase: 'not-the-passphrase' }),
    redirect: 'manual',
  });
  check('wrong passphrase is rejected', wrongPass.status === 401, `status ${wrongPass.status}`);

  const forgedTicket = await fetch(asm.authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: 'forged.ticket', passphrase: TOKEN }),
    redirect: 'manual',
  });
  check('forged consent ticket is rejected (CSRF protection)', forgedTicket.status === 400, `status ${forgedTicket.status}`);

  const approve = await fetch(asm.authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, passphrase: TOKEN }),
    redirect: 'manual',
  });
  const location = approve.headers.get('location') ?? '';
  const callback = new URL(location);
  const code = callback.searchParams.get('code');
  check('correct passphrase redirects to the callback', approve.status === 302 && callback.origin === 'http://127.0.0.1:9999', location);
  check('authorization code is returned', typeof code === 'string' && code.length > 20);
  check('state is echoed back unchanged', callback.searchParams.get('state') === state);

  step('E. Token exchange');

  const tokenRequest = (params) =>
    fetch(asm.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });

  const badVerifier = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: registration.client_id,
    code_verifier: crypto.randomBytes(32).toString('base64url'),
  });
  const badVerifierBody = await badVerifier.json();
  check('wrong PKCE verifier is rejected', badVerifier.status === 400 && badVerifierBody.error === 'invalid_grant', JSON.stringify(badVerifierBody));

  // That failed attempt consumed the code — codes are single use either way.
  const replay = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: registration.client_id,
    code_verifier: verifier,
  });
  check('an already-used authorization code is refused', replay.status === 400, `status ${replay.status}`);

  // Fresh authorization for the successful path.
  const consent2 = await (await fetch(authorizeUrl())).text();
  const ticket2 = /name="ticket" value="([^"]+)"/.exec(consent2)?.[1];
  const approve2 = await fetch(asm.authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: ticket2, passphrase: TOKEN }),
    redirect: 'manual',
  });
  const code2 = new URL(approve2.headers.get('location')).searchParams.get('code');

  const unknownClientToken = await tokenRequest({
    grant_type: 'authorization_code',
    code: code2,
    redirect_uri: REDIRECT_URI,
    client_id: 'rbc_not_registered',
    code_verifier: verifier,
  });
  check('token request from an unknown client is refused', unknownClientToken.status === 401, `status ${unknownClientToken.status}`);

  const tokenRes = await tokenRequest({
    grant_type: 'authorization_code',
    code: code2,
    redirect_uri: REDIRECT_URI,
    client_id: registration.client_id,
    code_verifier: verifier,
    resource,
  });
  const tokens = await tokenRes.json();
  check('token exchange succeeds', tokenRes.status === 200 && typeof tokens.access_token === 'string', JSON.stringify(tokens));
  check('token type is Bearer', tokens.token_type === 'Bearer');
  check('a refresh token is issued', typeof tokens.refresh_token === 'string');
  check('expires_in is present', Number.isFinite(tokens.expires_in));
  check('token response is not cached', tokenRes.headers.get('cache-control') === 'no-store');

  step('F. MCP over OAuth');

  const invalid = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: 'Bearer rba_not_a_real_token' },
    body: mcpBody('tools/list'),
  });
  check('an invalid bearer token is rejected', invalid.status === 401, `status ${invalid.status}`);
  check('invalid-token 401 says so in WWW-Authenticate', /error="invalid_token"/.test(invalid.headers.get('www-authenticate') ?? ''), invalid.headers.get('www-authenticate'));

  const inQuery = await fetch(`${base}/mcp?access_token=${tokens.access_token}`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: mcpBody('tools/list'),
  });
  check('a token in the query string is NOT accepted', inQuery.status === 401, `status ${inQuery.status}`);

  const client = new Client({ name: 'http-check-oauth', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  const listed = await client.listTools();
  check(`MCP initialize + tools/list succeed after OAuth (${listed.tools.length} tools)`, listed.tools.length > 10);

  const status = await client.callTool({ name: 'bridge_status', arguments: {} });
  const statusText = (status.content ?? []).map((c) => c.text ?? '').join('\n');
  check('bridge_status works over OAuth', /level: develop/.test(statusText), statusText);
  check('bridge_status reports oauth', /oauth/.test(statusText), statusText);
  check('OAuth does not grant more than the configured permission', !listed.tools.some((t) => t.name === 'git_push'));
  check('no token material leaks into tool output', !statusText.includes(tokens.access_token));
  await client.close();

  step('G. Refresh and revocation');

  const refreshed = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: registration.client_id,
  });
  const newTokens = await refreshed.json();
  check('refresh grant issues a new access token', refreshed.status === 200 && typeof newTokens.access_token === 'string', JSON.stringify(newTokens));
  check('refresh token is rotated', newTokens.refresh_token !== tokens.refresh_token);

  const replayedRefresh = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: registration.client_id,
  });
  check('the old refresh token no longer works', replayedRefresh.status === 400, `status ${replayedRefresh.status}`);

  const afterRotation = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${newTokens.access_token}` },
    body: mcpBody('tools/list'),
  });
  check('the rotated access token works', afterRotation.status === 200, `status ${afterRotation.status}`);

  await fetch(asm.revocation_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: newTokens.access_token, client_id: registration.client_id }),
  });
  const afterRevoke = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${newTokens.access_token}` },
    body: mcpBody('tools/list'),
  });
  check('a revoked token is rejected', afterRevoke.status === 401, `status ${afterRevoke.status}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bridge-http-')));
  const workspace = path.join(base, 'demo');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n');

  const pathTokenPort = 8899;
  const oauthPort = 8900;
  const children = [];

  try {
    children.push(startBridge({ port: pathTokenPort, auth: 'path-token', workspace, dataDir: path.join(base, 'data-pt') }));
    await checkPathTokenMode(`http://127.0.0.1:${pathTokenPort}`, workspace);

    children.push(startBridge({ port: oauthPort, auth: 'oauth', workspace, dataDir: path.join(base, 'data-oauth') }));
    await checkOAuthMode(`http://127.0.0.1:${oauthPort}`);
  } finally {
    for (const child of children) child.kill();
  }

  process.stdout.write(`\n${'─'.repeat(60)}\n`);
  process.stdout.write(`passed: ${passed}   failed: ${failed}\n`);
  if (failed) process.stdout.write(`failing checks:\n${failures.map((f) => '  - ' + f).join('\n')}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`http-check error: ${e?.stack ?? e}\n`);
  process.exit(1);
});

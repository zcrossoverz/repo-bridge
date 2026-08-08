/**
 * OAuth 2.1 authorization server + protected resource metadata.
 *
 * The bridge is both the resource server and its own authorization server. That
 * is the shape the MCP authorization spec explicitly allows, and for a
 * self-hosted single-operator tool it avoids standing up a second service just
 * to log one person in.
 *
 * Implemented, per the MCP 2025-06-18 authorization spec and the ChatGPT
 * connector requirements:
 *   RFC 9728  protected resource metadata + WWW-Authenticate discovery
 *   RFC 8414  authorization server metadata
 *   RFC 7591  dynamic client registration
 *   OAuth 2.1 authorization code flow, PKCE S256 mandatory
 *   RFC 8707  resource indicators — the resource becomes the token audience
 *   RFC 7009  token revocation
 *
 * What the user actually does: ChatGPT opens the authorize URL in a browser, the
 * bridge shows a consent screen, the user pastes REPO_BRIDGE_TOKEN once, and
 * ChatGPT receives tokens. No header configuration anywhere.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import { describeLevel, loadConfig } from '../config.js';
import { audit, log } from '../logger.js';
import { capabilityMatrix } from '../security/permissions.js';
import { oauthStore, safeEqual } from './oauth-store.js';

const SCOPE = 'mcp';

// ── request origin ───────────────────────────────────────────────────────────

/**
 * The origin the client used to reach us. OAuth metadata must advertise exactly
 * that, or the client's issuer check fails.
 *
 * Forwarded headers are trusted here because the bridge is meant to sit behind a
 * tunnel or reverse proxy that the operator controls. `REPO_BRIDGE_PUBLIC_URL`
 * overrides them and is the recommended setting.
 */
export function publicOrigin(req: http.IncomingMessage): string {
  const cfg = loadConfig();
  if (cfg.auth.publicUrl) return cfg.auth.publicUrl;

  const first = (value: string | string[] | undefined): string =>
    ((Array.isArray(value) ? value[0] : value) ?? '').split(',')[0]?.trim() ?? '';

  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host) || `${cfg.host}:${cfg.port}`;
  const proto = first(req.headers['x-forwarded-proto']) || (isLocalHost(host) ? 'http' : 'https');
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function isLocalHost(host: string): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

/** The canonical resource identifier for this MCP server (RFC 8707 §2). */
export function canonicalResource(origin: string): string {
  return `${origin}/mcp`;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

// ── metadata documents ───────────────────────────────────────────────────────

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: canonicalResource(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'repo-bridge',
  };
}

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // PKCE S256 is mandatory; `plain` is deliberately not offered.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    resource_indicators_supported: true,
  };
}

// ── small HTTP helpers ───────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * @param formActionOrigin extra origin permitted by the `form-action` directive.
 *
 * Browsers apply `form-action` to redirects that *follow* a form submission, not
 * just to the form's own action. A successful consent POST redirects to the
 * client's callback (e.g. https://chatgpt.com/connector/oauth/…), so `'self'`
 * alone blocks the final step of the OAuth flow. The origin allowed here is the
 * redirect_uri that was already matched exactly against the client's
 * registration, so this widens nothing an attacker controls.
 */
function sendHtml(res: http.ServerResponse, status: number, html: string, formActionOrigin?: string): void {
  const formAction = ["'self'", ...(formActionOrigin ? [formActionOrigin] : [])].join(' ');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    // The consent page has no scripts and loads nothing external.
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

/** Scheme + host of a URI, for use in a CSP source list. Empty when unparsable. */
function originOf(uri: string): string | undefined {
  try {
    return new URL(uri).origin;
  } catch {
    return undefined;
  }
}

function oauthError(res: http.ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description });
}

export function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) out[key] = value;
  return out;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Client credentials may arrive in the body or as HTTP Basic (RFC 6749 §2.3.1). */
function clientCredentials(req: http.IncomingMessage, form: Record<string, string>): { clientId: string; clientSecret?: string } {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep > 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, sep)),
        clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
      };
    }
  }
  return {
    clientId: form.client_id ?? '',
    ...(form.client_secret ? { clientSecret: form.client_secret } : {}),
  };
}

// ── brute-force protection on the consent form ───────────────────────────────

const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map<string, { count: number; resetAt: number }>();

function tooManyFailures(ip: string): boolean {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip: string): void {
  const entry = failures.get(ip);
  if (!entry || entry.resetAt < Date.now()) {
    failures.set(ip, { count: 1, resetAt: Date.now() + FAILURE_WINDOW_MS });
    return;
  }
  entry.count++;
}

// ── consent page ─────────────────────────────────────────────────────────────

function consentPage(opts: {
  clientName: string;
  redirectHost: string;
  resource: string;
  ticket: string;
  error?: string;
}): string {
  const cfg = loadConfig();
  const caps = capabilityMatrix(cfg.permission);
  const capRows = Object.entries(caps)
    .map(([name, on]) => `<li class="${on ? 'on' : 'off'}">${on ? '✓' : '✗'} ${escapeHtml(name)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize repo-bridge</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --bg:#fff; --card:#f6f7f9; --line:#e2e5ea; --accent:#2563eb; --warn:#b45309; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8eaed; --muted:#9aa0a6; --bg:#15171a; --card:#1e2125; --line:#2e3238; --accent:#5b8cff; --warn:#e0a458; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 30rem; margin: 0 auto; }
  h1 { font-size:1.25rem; margin:0 0 .25rem; }
  .sub { color:var(--muted); margin:0 0 1.5rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1rem 1.15rem; margin-bottom:1.25rem; }
  dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:.35rem .9rem; font-size:.9rem; }
  dt { color:var(--muted); }
  dd { margin:0; word-break:break-all; }
  ul { list-style:none; padding:0; margin:.5rem 0 0; display:flex; flex-wrap:wrap; gap:.5rem; font-size:.85rem; }
  li { padding:.15rem .5rem; border-radius:5px; border:1px solid var(--line); }
  li.on { color:var(--accent); }
  li.off { color:var(--muted); opacity:.65; }
  label { display:block; font-weight:600; margin-bottom:.4rem; font-size:.9rem; }
  input { width:100%; padding:.65rem .75rem; font:inherit; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
          border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
  button { margin-top:1rem; width:100%; padding:.7rem; font:inherit; font-weight:600; color:#fff;
           background:var(--accent); border:0; border-radius:8px; cursor:pointer; }
  .err { color:#dc2626; font-size:.9rem; margin:.6rem 0 0; }
  .note { color:var(--muted); font-size:.82rem; margin-top:1.25rem; }
  .warn { color:var(--warn); }
</style>
</head><body><main>
  <h1>Authorize access to repo-bridge</h1>
  <p class="sub"><strong>${escapeHtml(opts.clientName)}</strong> is requesting access to your repositories.</p>

  <div class="card">
    <dl>
      <dt>Client</dt><dd>${escapeHtml(opts.clientName)}</dd>
      <dt>Redirects to</dt><dd>${escapeHtml(opts.redirectHost)}</dd>
      <dt>Resource</dt><dd>${escapeHtml(opts.resource)}</dd>
      <dt>Permission</dt><dd>${escapeHtml(cfg.permission)} — ${escapeHtml(describeLevel(cfg.permission).split('—')[1]?.trim() ?? '')}</dd>
    </dl>
    <ul>${capRows}</ul>
  </div>

  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="ticket" value="${escapeHtml(opts.ticket)}">
    <label for="passphrase">Bridge authorization passphrase</label>
    <input id="passphrase" name="passphrase" type="password" autocomplete="off" autofocus
           placeholder="value of REPO_BRIDGE_TOKEN">
    ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
    <button type="submit">Authorize</button>
  </form>

  <p class="note">
    Granting access lets this client use the tools your permission level allows — nothing more.
    Authorizing does <strong>not</strong> raise the level; that is set by the operator with
    <code>REPO_BRIDGE_PERMISSION</code> and cannot be changed from here.
    <span class="warn">If you did not start this connection, close this page.</span>
  </p>
</main></body></html>`;
}

// ── endpoint handling ────────────────────────────────────────────────────────

export interface OAuthRequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  rawBody: string;
  remoteAddress: string;
}

/** Returns true when the request was an OAuth/metadata route and has been answered. */
export async function handleOAuthRoute(ctx: OAuthRequestContext): Promise<boolean> {
  const { req, res, url } = ctx;
  const origin = publicOrigin(req);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // Metadata is served with and without the resource path suffix: RFC 9728
  // inserts the resource path into the well-known URL, and clients differ.
  if (req.method === 'GET' && /^\/\.well-known\/oauth-protected-resource(\/.*)?$/.test(pathname)) {
    sendJson(res, 200, protectedResourceMetadata(origin));
    return true;
  }
  if (req.method === 'GET' && /^\/\.well-known\/oauth-authorization-server(\/.*)?$/.test(pathname)) {
    sendJson(res, 200, authorizationServerMetadata(origin));
    return true;
  }

  if (pathname === '/oauth/register') return handleRegister(ctx, origin);
  if (pathname === '/oauth/authorize') return handleAuthorize(ctx, origin);
  if (pathname === '/oauth/token') return handleToken(ctx, origin);
  if (pathname === '/oauth/revoke') return handleRevoke(ctx);

  return false;
}

// ── RFC 7591 dynamic client registration ─────────────────────────────────────

function handleRegister(ctx: OAuthRequestContext, _origin: string): boolean {
  const { res, rawBody } = ctx;
  if (ctx.req.method !== 'POST') {
    oauthError(res, 405, 'invalid_request', 'Use POST to register a client.');
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    oauthError(res, 400, 'invalid_client_metadata', 'Body must be JSON.');
    return true;
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === 'string') : [];
  if (redirectUris.length === 0) {
    oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required.');
    return true;
  }
  // OAuth 2.1: redirect URIs must be HTTPS, or loopback for native clients.
  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      oauthError(res, 400, 'invalid_redirect_uri', `Not a valid URI: ${uri}`);
      return true;
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      oauthError(res, 400, 'invalid_redirect_uri', 'Redirect URIs must use https, or http on loopback.');
      return true;
    }
    if (parsed.hash) {
      oauthError(res, 400, 'invalid_redirect_uri', 'Redirect URIs must not contain a fragment.');
      return true;
    }
  }

  const grantTypes = Array.isArray(body.grant_types)
    ? (body.grant_types as unknown[]).filter((g): g is string => typeof g === 'string')
    : ['authorization_code', 'refresh_token'];
  const authMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';

  const { client, clientSecret } = oauthStore().registerClient({
    clientName: typeof body.client_name === 'string' && body.client_name ? body.client_name.slice(0, 120) : 'Unnamed MCP client',
    redirectUris,
    tokenEndpointAuthMethod: authMethod,
    grantTypes,
  });

  audit({ action: 'oauth_client_register', target: client.clientName, outcome: 'ok', detail: { clientId: client.clientId } });

  sendJson(ctx.res, 201, {
    client_id: client.clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_secret_expires_at: 0, // never expires
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: SCOPE,
  });
  return true;
}

// ── authorization endpoint ───────────────────────────────────────────────────

function redirectWithError(res: http.ServerResponse, redirectUri: string, state: string | undefined, error: string, description: string): void {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
  res.end();
}

function errorPage(res: http.ServerResponse, status: number, title: string, detail: string): void {
  sendHtml(
    res,
    status,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color-scheme:light dark}
h1{font-size:1.15rem}code{word-break:break-all}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`,
  );
}

function handleAuthorize(ctx: OAuthRequestContext, origin: string): boolean {
  const { req, res, url, rawBody, remoteAddress } = ctx;
  const store = oauthStore();
  const cfg = loadConfig();

  if (req.method === 'GET') {
    const params = url.searchParams;
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const state = params.get('state') ?? undefined;

    // Until client_id and redirect_uri are both validated, errors must NOT be
    // redirected anywhere — that would be an open redirect.
    const client = store.getClient(clientId);
    if (!client) {
      errorPage(res, 400, 'Unknown client', 'This client is not registered with the bridge. Reconnect the connector so it can register again.');
      return true;
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      errorPage(res, 400, 'Invalid redirect URI', 'The redirect URI does not exactly match one registered by this client.');
      return true;
    }

    if ((params.get('response_type') ?? '') !== 'code') {
      redirectWithError(res, redirectUri, state, 'unsupported_response_type', 'Only response_type=code is supported.');
      return true;
    }
    const codeChallenge = params.get('code_challenge') ?? '';
    const method = params.get('code_challenge_method') ?? '';
    if (!codeChallenge || method !== 'S256') {
      redirectWithError(res, redirectUri, state, 'invalid_request', 'PKCE with code_challenge_method=S256 is required.');
      return true;
    }

    // RFC 8707: bind the token to this server. A resource pointing elsewhere is
    // refused rather than quietly re-scoped.
    const requested = params.get('resource');
    const resource = requested ?? canonicalResource(origin);
    if (requested && !isOurResource(requested, origin)) {
      redirectWithError(res, redirectUri, state, 'invalid_target', `This server only issues tokens for ${canonicalResource(origin)}`);
      return true;
    }

    const ticket = store.signTicket({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      resource,
      scope: params.get('scope') || SCOPE,
      ...(state ? { state } : {}),
    });

    log.info('oauth authorize requested', { clientId, clientName: client.clientName, resource });
    sendHtml(
      res,
      200,
      consentPage({
        clientName: client.clientName,
        redirectHost: new URL(redirectUri).host,
        resource,
        ticket,
      }),
      originOf(redirectUri),
    );
    return true;
  }

  if (req.method !== 'POST') {
    errorPage(res, 405, 'Method not allowed', 'Use GET to start authorization.');
    return true;
  }

  // ── consent submission ──
  const form = parseForm(rawBody);
  const ticket = store.verifyTicket(form.ticket ?? '');
  if (!ticket) {
    errorPage(res, 400, 'Authorization request expired', 'This page is no longer valid. Start the connection again from your client.');
    return true;
  }

  if (tooManyFailures(remoteAddress)) {
    audit({ action: 'oauth_authorize', outcome: 'blocked', detail: { reason: 'rate_limited' } });
    errorPage(res, 429, 'Too many attempts', 'Too many incorrect passphrases. Wait 15 minutes and try again.');
    return true;
  }

  const passphrase = form.passphrase ?? '';
  if (!passphrase || !cfg.auth.token || !safeEqual(passphrase, cfg.auth.token)) {
    recordFailure(remoteAddress);
    audit({ action: 'oauth_authorize', outcome: 'blocked', detail: { reason: 'bad_passphrase' } });
    log.warn('oauth consent rejected', { remoteAddress, clientId: ticket.client_id });
    sendHtml(
      res,
      401,
      consentPage({
        clientName: store.getClient(ticket.client_id ?? '')?.clientName ?? 'MCP client',
        redirectHost: new URL(ticket.redirect_uri!).host,
        resource: ticket.resource!,
        ticket: form.ticket!,
        error: 'Incorrect passphrase. This is the value of REPO_BRIDGE_TOKEN on the bridge host.',
      }),
      originOf(ticket.redirect_uri!),
    );
    return true;
  }

  const code = store.createAuthorizationCode({
    clientId: ticket.client_id!,
    redirectUri: ticket.redirect_uri!,
    codeChallenge: ticket.code_challenge!,
    resource: ticket.resource!,
    scope: ticket.scope ?? SCOPE,
  });

  audit({ action: 'oauth_authorize', outcome: 'ok', detail: { clientId: ticket.client_id } });
  log.info('oauth authorization granted', { clientId: ticket.client_id });

  const target = new URL(ticket.redirect_uri!);
  target.searchParams.set('code', code);
  if (ticket.state) target.searchParams.set('state', ticket.state);
  res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

function isOurResource(requested: string, origin: string): boolean {
  const canonical = canonicalResource(origin).toLowerCase().replace(/\/+$/, '');
  const normalised = requested.toLowerCase().replace(/\/+$/, '');
  return normalised === canonical || normalised === origin.toLowerCase().replace(/\/+$/, '');
}

// ── token endpoint ───────────────────────────────────────────────────────────

function handleToken(ctx: OAuthRequestContext, origin: string): boolean {
  const { req, res, rawBody } = ctx;
  const store = oauthStore();

  if (req.method !== 'POST') {
    oauthError(res, 405, 'invalid_request', 'Use POST.');
    return true;
  }

  const form = parseForm(rawBody);
  const { clientId, clientSecret } = clientCredentials(req, form);
  const client = clientId ? store.getClient(clientId) : undefined;
  if (!client) {
    oauthError(res, 401, 'invalid_client', 'Unknown client_id.');
    return true;
  }
  if (!store.verifyClientSecret(client, clientSecret)) {
    oauthError(res, 401, 'invalid_client', 'Client authentication failed.');
    return true;
  }

  const grantType = form.grant_type ?? '';

  if (grantType === 'authorization_code') {
    const code = form.code ?? '';
    const verifier = form.code_verifier ?? '';
    if (!code || !verifier) {
      oauthError(res, 400, 'invalid_request', 'code and code_verifier are required.');
      return true;
    }

    const record = store.consumeAuthorizationCode(code);
    if (!record) {
      oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.');
      return true;
    }
    if (record.clientId !== clientId) {
      oauthError(res, 400, 'invalid_grant', 'Authorization code was issued to a different client.');
      return true;
    }
    if (form.redirect_uri && form.redirect_uri !== record.redirectUri) {
      oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
      return true;
    }

    // PKCE S256: BASE64URL(SHA256(verifier)) must equal the stored challenge.
    const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!safeEqual(computed, record.codeChallenge)) {
      audit({ action: 'oauth_token', outcome: 'blocked', detail: { reason: 'pkce_mismatch', clientId } });
      oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
      return true;
    }

    if (form.resource && !isOurResource(form.resource, origin)) {
      oauthError(res, 400, 'invalid_target', 'resource does not identify this MCP server.');
      return true;
    }

    const tokens = store.issueTokenPair({ clientId, resource: record.resource, scope: record.scope });
    audit({ action: 'oauth_token', outcome: 'ok', detail: { grant: 'authorization_code', clientId } });
    sendJson(res, 200, {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: record.scope,
    });
    return true;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.refresh_token ?? '';
    if (!refreshToken) {
      oauthError(res, 400, 'invalid_request', 'refresh_token is required.');
      return true;
    }
    const rotated = store.rotateRefreshToken(refreshToken, clientId);
    if ('error' in rotated) {
      audit({ action: 'oauth_token', outcome: 'blocked', detail: { grant: 'refresh_token', clientId } });
      oauthError(res, 400, rotated.error, 'Refresh token is invalid or expired. Re-authorize the connector.');
      return true;
    }
    audit({ action: 'oauth_token', outcome: 'ok', detail: { grant: 'refresh_token', clientId } });
    sendJson(res, 200, {
      access_token: rotated.accessToken,
      token_type: 'Bearer',
      expires_in: rotated.expiresIn,
      refresh_token: rotated.refreshToken,
      scope: SCOPE,
    });
    return true;
  }

  oauthError(res, 400, 'unsupported_grant_type', `grant_type "${grantType}" is not supported.`);
  return true;
}

// ── RFC 7009 revocation ──────────────────────────────────────────────────────

function handleRevoke(ctx: OAuthRequestContext): boolean {
  const { req, res, rawBody } = ctx;
  if (req.method !== 'POST') {
    oauthError(res, 405, 'invalid_request', 'Use POST.');
    return true;
  }
  const form = parseForm(rawBody);
  if (form.token) {
    oauthStore().revoke(form.token);
    audit({ action: 'oauth_revoke', outcome: 'ok' });
  }
  // RFC 7009: always 200, whether or not the token existed.
  res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Length': '0' });
  res.end();
  return true;
}

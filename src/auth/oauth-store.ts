/**
 * OAuth state: registered clients, authorization codes, access and refresh tokens.
 *
 * Design choices worth knowing:
 *
 *  - **Opaque tokens, stored hashed.** Not JWTs. A self-hosted single-operator
 *    bridge gains nothing from stateless verification, and opaque tokens are
 *    revocable immediately. Only SHA-256 hashes are persisted, so a leaked
 *    state file cannot be replayed against the server.
 *  - **All crypto comes from node:crypto** — randomBytes, sha256, HMAC, and
 *    timingSafeEqual. Nothing here invents a primitive.
 *  - **Authorization codes live in memory only.** They expire in 60 seconds;
 *    surviving a restart would be a liability, not a feature.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { atomicWriteFileSync } from '../fs/atomic.js';
import { withFileLock } from '../fs/lock.js';
import { audit, log } from '../logger.js';

export interface RegisteredClient {
  clientId: string;
  /** Absent for public clients that registered with token_endpoint_auth_method=none. */
  clientSecretHash?: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
  createdAt: number;
}

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  /** PKCE S256 challenge; required — plain is not accepted. */
  codeChallenge: string;
  /** RFC 8707 resource indicator; becomes the token audience. */
  resource: string;
  scope: string;
  expiresAt: number;
}

export interface TokenRecord {
  kind: 'access' | 'refresh';
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: number;
  /**
   * Refresh rotation family. When a refresh token is used, the whole family is
   * replaced; a replayed old token therefore fails rather than minting tokens.
   */
  family: string;
  createdAt: number;
}

interface PersistedState {
  version: 1;
  /** HMAC key for consent-form tickets. Random per installation. */
  formKey: string;
  clients: Record<string, RegisteredClient>;
  tokens: Record<string, TokenRecord>;
}

const CODE_TTL_MS = 60_000;

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that does not leak length through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export class OAuthStore {
  private readonly file: string;
  private state: PersistedState;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();

  constructor(dataDir: string = loadConfig().dataDir) {
    this.file = path.join(dataDir, 'oauth.json');
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PersistedState;
      if (parsed.version === 1 && parsed.formKey) {
        // Drop anything already expired so the file does not grow without bound.
        const now = Date.now();
        for (const [hash, token] of Object.entries(parsed.tokens ?? {})) {
          if (token.expiresAt <= now) delete parsed.tokens[hash];
        }
        parsed.clients ??= {};
        parsed.tokens ??= {};
        return parsed;
      }
    } catch {
      /* first run or unreadable — start clean */
    }
    return { version: 1, formKey: randomToken(32), clients: {}, tokens: {} };
  }

  /**
   * Apply a change under an exclusive lock, starting from the current on-disk
   * state. Without this, a second bridge process sharing the data directory
   * would overwrite tokens the first one issued — logging a live client out for
   * no visible reason.
   */
  private mutate<T>(fn: () => T): T {
    return withFileLock(this.file, () => {
      this.state = this.load();
      const result = fn();
      this.save();
      return result;
    });
  }

  private save(): void {
    atomicWriteFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    // rename does not carry mode on every platform; assert it after the fact.
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* not supported on this filesystem */
    }
  }

  // ── consent-form tickets ───────────────────────────────────────────────────

  /**
   * A signed, expiring ticket binding the consent form to the exact authorization
   * request that produced it. Without this, a third-party page could post a
   * forged approval to /oauth/authorize (CSRF), or a user could be walked into
   * approving parameters different from the ones displayed.
   */
  signTicket(payload: Record<string, string>, ttlMs = 10 * 60_000): string {
    const body = JSON.stringify({ ...payload, exp: Date.now() + ttlMs });
    const encoded = Buffer.from(body, 'utf8').toString('base64url');
    const mac = crypto.createHmac('sha256', this.state.formKey).update(encoded).digest('base64url');
    return `${encoded}.${mac}`;
  }

  verifyTicket(ticket: string): Record<string, string> | null {
    const [encoded, mac] = ticket.split('.');
    if (!encoded || !mac) return null;
    const expected = crypto.createHmac('sha256', this.state.formKey).update(encoded).digest('base64url');
    if (!safeEqual(mac, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, string> & { exp: number };
      if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  // ── clients ────────────────────────────────────────────────────────────────

  registerClient(input: {
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: string;
    grantTypes: string[];
  }): { client: RegisteredClient; clientSecret?: string } {
    const clientId = `rbc_${randomToken(16)}`;

    // ChatGPT registers as a public client (auth method "none") but has been
    // observed sending a client_secret at the token endpoint anyway. Issuing one
    // regardless costs nothing and keeps both behaviours working; PKCE and exact
    // redirect-URI matching are what actually secure the flow.
    const clientSecret = randomToken(32);

    const client: RegisteredClient = {
      clientId,
      clientSecretHash: sha256(clientSecret),
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      grantTypes: input.grantTypes,
      createdAt: Date.now(),
    };

    this.mutate(() => {
      this.state.clients[clientId] = client;
    });
    log.info('oauth client registered', {
      clientId,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      authMethod: input.tokenEndpointAuthMethod,
    });
    return { client, clientSecret };
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.state.clients[clientId];
  }

  verifyClientSecret(client: RegisteredClient, presented: string | undefined): boolean {
    // Public clients authenticate with PKCE alone.
    if (!presented) return client.tokenEndpointAuthMethod === 'none' || !client.clientSecretHash;
    if (!client.clientSecretHash) return false;
    return safeEqual(sha256(presented), client.clientSecretHash);
  }

  listClients(): RegisteredClient[] {
    return Object.values(this.state.clients).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Live token counts for one client — operator visibility, no token material. */
  tokenCountsFor(clientId: string): { access: number; refresh: number } {
    const now = Date.now();
    const live = Object.values(this.state.tokens).filter((t) => t.clientId === clientId && t.expiresAt > now);
    return {
      access: live.filter((t) => t.kind === 'access').length,
      refresh: live.filter((t) => t.kind === 'refresh').length,
    };
  }

  /**
   * Remove a client and everything it holds. Cutting off one connector should
   * not require deleting the whole state file, which is what it used to take.
   */
  revokeClient(clientId: string): { tokens: number } {
    const tokens = this.mutate(() => {
      let removed = 0;
      for (const [hash, token] of Object.entries(this.state.tokens)) {
        if (token.clientId === clientId) {
          delete this.state.tokens[hash];
          removed++;
        }
      }
      delete this.state.clients[clientId];
      return removed;
    });
    // audit(), not log.info(): revocation must reach audit.log even when the
    // CLI has quietened stderr so its own output stays readable.
    audit({ action: 'oauth_client_revoke', target: clientId, outcome: 'ok', detail: { tokensRemoved: tokens } });
    return { tokens };
  }

  // ── authorization codes ────────────────────────────────────────────────────

  createAuthorizationCode(record: Omit<AuthorizationCodeRecord, 'expiresAt'>): string {
    const code = randomToken(32);
    this.codes.set(sha256(code), { ...record, expiresAt: Date.now() + CODE_TTL_MS });
    this.pruneCodes();
    return code;
  }

  /** Single use: the record is removed whether or not the caller then succeeds. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const key = sha256(code);
    const record = this.codes.get(key);
    if (!record) return null;
    this.codes.delete(key);
    if (record.expiresAt < Date.now()) return null;
    return record;
  }

  private pruneCodes(): void {
    const now = Date.now();
    for (const [key, record] of this.codes) {
      if (record.expiresAt < now) this.codes.delete(key);
    }
  }

  // ── tokens ─────────────────────────────────────────────────────────────────

  issueTokenPair(input: { clientId: string; resource: string; scope: string; family?: string }): {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  } {
    return this.mutate(() => this.issueTokenPairLocked(input));
  }

  /** Caller must already hold the lock — refresh rotation issues within its own. */
  private issueTokenPairLocked(input: { clientId: string; resource: string; scope: string; family?: string }): {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  } {
    const cfg = loadConfig();
    const family = input.family ?? randomToken(16);
    const now = Date.now();

    const accessToken = `rba_${randomToken(32)}`;
    const refreshToken = `rbr_${randomToken(32)}`;

    this.state.tokens[sha256(accessToken)] = {
      kind: 'access',
      clientId: input.clientId,
      resource: input.resource,
      scope: input.scope,
      expiresAt: now + cfg.auth.accessTtlSec * 1000,
      family,
      createdAt: now,
    };
    this.state.tokens[sha256(refreshToken)] = {
      kind: 'refresh',
      clientId: input.clientId,
      resource: input.resource,
      scope: input.scope,
      expiresAt: now + cfg.auth.refreshTtlSec * 1000,
      family,
      createdAt: now,
    };

    this.pruneTokens();
    return { accessToken, refreshToken, expiresIn: cfg.auth.accessTtlSec };
  }

  /**
   * Rotate a refresh token. OAuth 2.1 requires rotation for public clients; the
   * whole family is invalidated so a replayed token cannot mint a second pair.
   */
  rotateRefreshToken(refreshToken: string, clientId: string): { accessToken: string; refreshToken: string; expiresIn: number } | { error: string } {
    // The whole check-and-replace runs inside one lock: two concurrent refreshes
    // of the same token must not both succeed.
    return this.mutate(() => {
      const record = this.state.tokens[sha256(refreshToken)];
      if (!record || record.kind !== 'refresh') return { error: 'invalid_grant' };
      if (record.expiresAt < Date.now()) {
        delete this.state.tokens[sha256(refreshToken)];
        return { error: 'invalid_grant' };
      }
      if (record.clientId !== clientId) return { error: 'invalid_grant' };

      for (const [hash, token] of Object.entries(this.state.tokens)) {
        if (token.family === record.family) delete this.state.tokens[hash];
      }
      return this.issueTokenPairLocked({
        clientId: record.clientId,
        resource: record.resource,
        scope: record.scope,
        family: record.family,
      });
    });
  }

  /**
   * Validate a bearer token for a specific resource.
   *
   * The audience check is not optional: the MCP spec requires a server to reject
   * tokens that were not issued for it, which is what stops a token minted for
   * some other service from being replayed here.
   */
  validateAccessToken(token: string, expectedResource: string): { ok: true; record: TokenRecord } | { ok: false; reason: 'invalid_token' | 'expired_token' | 'wrong_audience' } {
    const record = this.state.tokens[sha256(token)];
    if (!record || record.kind !== 'access') return { ok: false, reason: 'invalid_token' };
    if (record.expiresAt < Date.now()) return { ok: false, reason: 'expired_token' };
    if (!resourceMatches(record.resource, expectedResource)) return { ok: false, reason: 'wrong_audience' };
    return { ok: true, record };
  }

  revoke(token: string): boolean {
    return this.mutate(() => {
      const key = sha256(token);
      const record = this.state.tokens[key];
      if (!record) return false;
      // Revoking either half of a pair drops the whole family.
      for (const [hash, other] of Object.entries(this.state.tokens)) {
        if (other.family === record.family) delete this.state.tokens[hash];
      }
      return true;
    });
  }

  private pruneTokens(): void {
    const now = Date.now();
    for (const [hash, token] of Object.entries(this.state.tokens)) {
      if (token.expiresAt <= now) delete this.state.tokens[hash];
    }
  }

  /** Diagnostics only — never returns token material. */
  stats(): { clients: number; activeAccessTokens: number; activeRefreshTokens: number } {
    const now = Date.now();
    const live = Object.values(this.state.tokens).filter((t) => t.expiresAt > now);
    return {
      clients: Object.keys(this.state.clients).length,
      activeAccessTokens: live.filter((t) => t.kind === 'access').length,
      activeRefreshTokens: live.filter((t) => t.kind === 'refresh').length,
    };
  }
}

/**
 * Compare a token's audience with the resource being accessed.
 *
 * Canonical URIs are compared case-insensitively on scheme and host, and a
 * trailing slash is insignificant. A token issued for the server root is
 * accepted at `/mcp` beneath it, since both identify this same bridge.
 */
export function resourceMatches(tokenResource: string, requested: string): boolean {
  const normalise = (value: string): string => {
    try {
      const url = new URL(value);
      const pathname = url.pathname.replace(/\/+$/, '');
      return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
    } catch {
      return value.replace(/\/+$/, '').toLowerCase();
    }
  };
  const a = normalise(tokenResource);
  const b = normalise(requested);
  if (a === b) return true;
  return b.startsWith(a + '/');
}

let singleton: OAuthStore | null = null;

export function oauthStore(): OAuthStore {
  singleton ??= new OAuthStore();
  return singleton;
}

/** Test seam. */
export function resetOAuthStoreForTests(): void {
  singleton = null;
}

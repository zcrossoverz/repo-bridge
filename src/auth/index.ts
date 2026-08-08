/**
 * The single gate every MCP request passes through before the transport sees it.
 *
 * Three modes, one entry point — so there is exactly one place to audit the
 * question "can this caller reach the tools?".
 */
import type http from 'node:http';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';
import { safeEqual } from './oauth-store.js';
import { oauthStore } from './oauth-store.js';
import { canonicalResource, publicOrigin, resourceMetadataUrl } from './oauth-server.js';

export interface AuthSuccess {
  ok: true;
  /** Who was authenticated, for logs. Never token material. */
  principal: string;
}

export interface AuthFailure {
  ok: false;
  status: number;
  error: string;
  description: string;
  /** Value for the WWW-Authenticate response header, when one applies. */
  challenge?: string;
}

export type AuthResult = AuthSuccess | AuthFailure;

function bearerFromHeader(req: http.IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (!raw) return null;
  const match = /^bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * RFC 9728 §5.1 — a 401 from an MCP server must point the client at the
 * protected resource metadata so it can discover the authorization server.
 */
function bearerChallenge(req: http.IncomingMessage, error?: string, description?: string): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl(publicOrigin(req))}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  parts.push('scope="mcp"');
  return parts.join(', ');
}

export function authenticateMcpRequest(req: http.IncomingMessage, url: URL, remoteAddress: string): AuthResult {
  const cfg = loadConfig();

  switch (cfg.auth.mode) {
    case 'none':
      return { ok: true, principal: 'anonymous' };

    case 'path-token': {
      const presented =
        bearerFromHeader(req) ??
        // /mcp/<token> — for clients that cannot set headers.
        (url.pathname.split('/').filter(Boolean)[1] ?? null) ??
        url.searchParams.get('token');

      if (!presented || !safeEqual(presented, cfg.auth.token)) {
        log.warn('unauthorised request', { remoteAddress, mode: 'path-token', hadCredential: Boolean(presented) });
        return {
          ok: false,
          status: 401,
          error: 'invalid_token',
          description: 'Provide the bridge token as "Authorization: Bearer <token>" or in the URL path as /mcp/<token>.',
          challenge: 'Bearer realm="repo-bridge"',
        };
      }
      return { ok: true, principal: 'path-token' };
    }

    case 'oauth': {
      // OAuth 2.1 §5: tokens travel in the Authorization header, never the query.
      const token = bearerFromHeader(req);
      if (!token) {
        return {
          ok: false,
          status: 401,
          error: 'unauthorized',
          description: 'Authorization required.',
          challenge: bearerChallenge(req),
        };
      }

      const expected = canonicalResource(publicOrigin(req));
      const result = oauthStore().validateAccessToken(token, expected);
      if (!result.ok) {
        log.warn('oauth token rejected', { remoteAddress, reason: result.reason });
        const description =
          result.reason === 'expired_token'
            ? 'The access token has expired. Refresh it with the refresh token.'
            : result.reason === 'wrong_audience'
              ? `The access token was not issued for ${expected}.`
              : 'The access token is not valid.';
        return {
          ok: false,
          status: 401,
          error: 'invalid_token',
          description,
          challenge: bearerChallenge(req, 'invalid_token', description),
        };
      }
      return { ok: true, principal: `oauth:${result.record.clientId}` };
    }
  }
}

/** Human-readable summary of the active mode, for startup logs and bridge_status. */
export function describeAuthMode(): string {
  const cfg = loadConfig();
  switch (cfg.auth.mode) {
    case 'oauth':
      return 'oauth — OAuth 2.1 with dynamic client registration and PKCE (ChatGPT Web compatible)';
    case 'path-token':
      return 'path-token — shared secret in the URL path or bearer header (development only)';
    case 'none':
      return cfg.auth.allowInsecure
        ? 'none — NO AUTHENTICATION, insecure override enabled'
        : 'none — no authentication (loopback only)';
  }
}

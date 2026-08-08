/**
 * HTTP transport (Streamable HTTP) — how ChatGPT Web reaches the bridge.
 *
 * Stateless by design: every POST creates a fresh MCP server bound to a fresh
 * transport. All durable state lives on disk, so there is no session affinity to
 * lose when a connector reconnects — which ChatGPT does routinely.
 *
 * Request pipeline:
 *   CORS / OPTIONS → /health → IP allowlist → OAuth + metadata routes
 *   → authentication → /mcp
 *
 * Authentication runs before the MCP transport is constructed, so an
 * unauthenticated request never reaches a tool.
 */
import http from 'node:http';
import { loadConfig } from '../config.js';
import { runWithContext } from '../context.js';
import { log } from '../logger.js';
import { authenticateMcpRequest, describeAuthMode } from '../auth/index.js';
import { handleOAuthRoute, publicOrigin } from '../auth/oauth-server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './mcp.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, payload: unknown, contentType = 'application/json'): void {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** Read the body once as text; callers parse it per content type. */
function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startHttpServer(): http.Server {
  const cfg = loadConfig();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      log.error('http handler crashed', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const remoteAddress = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, WWW-Authenticate');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // Unauthenticated liveness probe — exposes nothing but version and mode.
    if (url.pathname === '/health') {
      send(res, 200, { status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, auth: cfg.auth.mode });
      return;
    }

    if (cfg.ipAllowlist.length && !cfg.ipAllowlist.includes(remoteAddress)) {
      log.warn('rejected by ip allowlist', { remoteAddress });
      jsonRpcError(res, 403, -32001, 'Forbidden');
      return;
    }

    let rawBody = '';
    if (req.method === 'POST') {
      try {
        rawBody = await readRawBody(req);
      } catch (e) {
        jsonRpcError(res, 400, -32700, (e as Error).message);
        return;
      }
    }

    // OAuth discovery, registration, authorization, token and revocation.
    // These are public by definition — they are how a client *becomes*
    // authenticated — and are only mounted when OAuth is the active mode.
    if (cfg.auth.mode === 'oauth') {
      const handled = await handleOAuthRoute({ req, res, url, rawBody, remoteAddress });
      if (handled) return;
    }

    const base = url.pathname.split('/').filter(Boolean)[0] ?? '';
    if (base !== 'mcp') {
      send(res, 404, {
        error: 'Not found',
        hint:
          cfg.auth.mode === 'oauth'
            ? `The MCP endpoint is POST ${publicOrigin(req)}/mcp. Discovery: /.well-known/oauth-protected-resource`
            : 'The MCP endpoint is POST /mcp',
      });
      return;
    }

    const auth = authenticateMcpRequest(req, url, remoteAddress);
    if (!auth.ok) {
      jsonRpcError(res, auth.status, -32001, `${auth.error}: ${auth.description}`, auth.challenge ? { 'WWW-Authenticate': auth.challenge } : {});
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // Stateless mode: no server-initiated stream and no session to terminate.
      res.setHeader('Allow', 'POST');
      jsonRpcError(res, 405, -32000, 'Method not allowed. This endpoint is stateless; send JSON-RPC over POST.');
      return;
    }
    if (req.method !== 'POST') {
      jsonRpcError(res, 405, -32000, 'Method not allowed');
      return;
    }

    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      jsonRpcError(res, 400, -32700, 'invalid JSON body');
      return;
    }

    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });

    await mcpServer.connect(transport);
    // Everything downstream — including which workspace is "active" — is scoped
    // to the authenticated caller, so two clients cannot redirect each other.
    await runWithContext({ principal: auth.principal }, () => transport.handleRequest(req, res, body));
  }

  server.listen(cfg.port, cfg.host, () => {
    log.info('http transport listening', {
      url: `http://${cfg.host}:${cfg.port}/mcp`,
      authMode: cfg.auth.mode,
      authDescription: describeAuthMode(),
      permission: cfg.permission,
      publicUrl: cfg.auth.publicUrl || '(derived from request headers)',
    });

    if (cfg.auth.mode === 'none') {
      log.warn('MCP server is running WITHOUT authentication', {
        hint: 'Only safe on loopback. Set REPO_BRIDGE_AUTH=oauth before exposing this to a network.',
      });
    }
    if (cfg.auth.mode === 'path-token') {
      log.warn('path-token auth is a development fallback', {
        hint: 'ChatGPT Web needs REPO_BRIDGE_AUTH=oauth. Use path-token only for temporary tunnels and local clients.',
      });
    }
  });

  return server;
}

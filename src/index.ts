#!/usr/bin/env node
/**
 * repo-bridge entry point.
 *
 *   repo-bridge --stdio     local MCP client (Claude Code, Cursor, Inspector)
 *   repo-bridge --http      remote MCP endpoint (ChatGPT Web connector)
 *   repo-bridge --both      both at once
 *
 * Without a flag, REPO_BRIDGE_MODE decides (default: stdio).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runCli } from './cli.js';
import { loadConfig } from './config.js';
import { closeLogger, configureLogger, log } from './logger.js';
import { configureSecretPatterns, registerLiteralSecret } from './security/secrets.js';
import { createMcpServer } from './server/mcp.js';
import { startHttpServer } from './server/http.js';
import { registry } from './workspace/registry.js';
import { availableTools } from './tools/index.js';

function parseMode(cfgMode: string): 'stdio' | 'http' | 'both' {
  const argv = process.argv.slice(2);
  if (argv.includes('--both')) return 'both';
  if (argv.includes('--http')) return 'http';
  if (argv.includes('--stdio')) return 'stdio';
  return cfgMode as 'stdio' | 'http' | 'both';
}

async function main(): Promise<void> {
  // --help, --version and the operator commands never start a server.
  try {
    const cli = runCli(process.argv.slice(2));
    if (cli.handled) process.exit(cli.exitCode);
  } catch (e) {
    process.stderr.write(`\nrepo-bridge: ${(e as Error).message}\n\n`);
    process.exit(2);
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    // Config errors must be legible: this is the most common setup failure.
    process.stderr.write(`\nrepo-bridge configuration error:\n  ${(e as Error).message}\n\n`);
    process.exit(2);
  }

  configureLogger({ level: cfg.log.level, file: cfg.log.file, dataDir: cfg.dataDir });
  configureSecretPatterns(cfg.extraSecretPatterns);
  registerLiteralSecret(cfg.auth.token);
  registerLiteralSecret(cfg.forge.githubToken);
  registerLiteralSecret(cfg.forge.gitlabToken);

  const mode = parseMode(cfg.mode);
  const reg = registry();

  log.info('repo-bridge starting', {
    mode,
    authMode: mode === 'stdio' ? 'n/a (stdio inherits the host environment)' : cfg.auth.mode,
    permission: cfg.permission,
    tools: availableTools().length,
    workspaceRoots: cfg.workspaceRoots.map((r) => `${r.alias}=${r.path}`),
    openWorkspaces: reg.list().map((w) => w.alias),
    dataDir: cfg.dataDir,
  });

  if (cfg.workspaceRoots.length === 0) {
    log.warn('no workspace roots configured — only repo_open_remote will work', {
      hint: 'Set REPO_BRIDGE_WORKSPACES="alias=C:\\path\\to\\project"',
    });
  }

  if (mode === 'http' || mode === 'both') {
    startHttpServer();
  }

  if (mode === 'stdio' || mode === 'both') {
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
    log.info('stdio transport connected');
  }

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    closeLogger();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });
}

void main();

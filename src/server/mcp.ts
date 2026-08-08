/**
 * MCP server wiring. Transport-agnostic: both stdio and HTTP build one of these.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, SERVER_INSTRUCTIONS, toolManifest } from '../tools/index.js';
import { log } from '../logger.js';
import { VERSION } from '../version.js';

export const SERVER_NAME = 'repo-bridge';
export const SERVER_VERSION = VERSION;

export function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolManifest() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log.info('tool call', { tool: name });
    const outcome = await callTool(name, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: 'text' as const, text: outcome.text }],
      isError: outcome.isError,
    };
  });

  return server;
}

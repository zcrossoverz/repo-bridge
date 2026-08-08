/**
 * Command-line surface.
 *
 * Everything here runs *before* a transport is connected, and writes to stdout —
 * which is safe only because we exit immediately afterwards. Once the stdio
 * transport is live, stdout belongs to the protocol.
 *
 * Operator actions (listing and revoking authorised OAuth clients) live here
 * rather than as MCP tools on purpose: revoking access is the human's decision,
 * and a model should not be able to grant or withdraw its own credentials.
 */
import { loadConfig } from './config.js';
import { configureLogger } from './logger.js';
import { oauthStore } from './auth/oauth-store.js';
import { HOMEPAGE, PACKAGE_NAME, VERSION } from './version.js';

/**
 * Operator commands print for a human. Diagnostic JSON on stderr would be
 * interleaved noise, so drop the log level — the audit trail still records the
 * action, because audit() writes to its own stream regardless of level.
 */
function quietLogger(): void {
  const cfg = loadConfig();
  configureLogger({ level: 'error', dataDir: cfg.dataDir });
}

const HELP = `repo-bridge ${VERSION} — an MCP server that gives a coding agent real access to your repositories.

USAGE
  repo-bridge [--stdio | --http | --both]
  repo-bridge clients
  repo-bridge revoke <client-id>
  repo-bridge --version | --help

TRANSPORTS
  --stdio        Local MCP client: Claude Code, Cursor, MCP Inspector. Default.
  --http         Remote endpoint, for a ChatGPT Web connector.
  --both         Both at once.

  Without a flag, REPO_BRIDGE_MODE decides.

OPERATOR COMMANDS
  clients        List OAuth clients that have been authorised, with their live token counts.
  revoke <id>    Revoke a client: its registration and every token it holds are removed.
                 The client must complete the consent flow again to reconnect.

ESSENTIAL CONFIGURATION
  REPO_BRIDGE_WORKSPACES     Repositories the bridge may open, as "alias=path" separated by ';'.
                             Nothing outside these roots is reachable. Required for local work.
  REPO_BRIDGE_PERMISSION     read_only | edit | develop (default) | full
                             read_only: search and read.  edit: + modify files.
                             develop:   + build, test, lint, local git.
                             full:      + push and pull requests.
  REPO_BRIDGE_AUTH           HTTP mode only: oauth | path-token | none
                             oauth is the only mode ChatGPT Web supports.
  REPO_BRIDGE_TOKEN          OAuth consent passphrase, or the path-token secret. 24+ characters.

  Full list: .env.example in the package, or ${HOMEPAGE}

EXAMPLES
  Local client, one project:
    REPO_BRIDGE_WORKSPACES="app=/srv/app" repo-bridge --stdio

  ChatGPT Web, behind a tunnel:
    REPO_BRIDGE_MODE=http REPO_BRIDGE_AUTH=oauth REPO_BRIDGE_TOKEN=... \\
      REPO_BRIDGE_WORKSPACES="app=/srv/app" repo-bridge --http

  See who has access, and cut one off:
    repo-bridge clients
    repo-bridge revoke rbc_AbC123...

DOCUMENTATION
  ${HOMEPAGE}
  npm: https://www.npmjs.com/package/${PACKAGE_NAME}
`;

export interface CliOutcome {
  /** True when the CLI handled the invocation and the process should exit. */
  handled: boolean;
  exitCode: number;
}

function daysSince(iso: number): string {
  const days = (Date.now() - iso) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  return `${Math.floor(days)} days ago`;
}

function listClients(): number {
  const store = oauthStore();
  const clients = store.listClients();

  if (clients.length === 0) {
    process.stdout.write(
      'No OAuth clients are authorised.\n\n' +
        'Clients register themselves when you connect them; nothing has done so yet\n' +
        'against this data directory.\n',
    );
    return 0;
  }

  const stats = store.stats();
  process.stdout.write(`${clients.length} authorised client(s):\n\n`);
  for (const client of clients) {
    const live = store.tokenCountsFor(client.clientId);
    process.stdout.write(
      `  ${client.clientId}\n` +
        `    name          ${client.clientName}\n` +
        `    registered    ${daysSince(client.createdAt)}\n` +
        `    redirects to  ${client.redirectUris.join(', ')}\n` +
        `    live tokens   ${live.access} access, ${live.refresh} refresh\n\n`,
    );
  }
  process.stdout.write(
    `Totals: ${stats.activeAccessTokens} access, ${stats.activeRefreshTokens} refresh tokens live.\n` +
      `Revoke one with:  repo-bridge revoke <client-id>\n`,
  );
  return 0;
}

function revokeClient(clientId: string): number {
  const store = oauthStore();
  const client = store.getClient(clientId);
  if (!client) {
    process.stderr.write(
      `No client with id "${clientId}".\n\nRun "repo-bridge clients" to see the authorised ones.\n`,
    );
    return 1;
  }

  const removed = store.revokeClient(clientId);
  process.stdout.write(
    `Revoked "${client.clientName}" (${clientId}).\n` +
      `Removed ${removed.tokens} token(s). The client must authorise again to reconnect.\n`,
  );
  return 0;
}

/**
 * Handle CLI-only invocations. Returns `handled: false` when the process should
 * go on to start a server.
 */
export function runCli(argv: string[]): CliOutcome {
  if (argv.includes('--help') || argv.includes('-h') || argv.includes('help')) {
    process.stdout.write(HELP);
    return { handled: true, exitCode: 0 };
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return { handled: true, exitCode: 0 };
  }

  const command = argv.find((a) => !a.startsWith('-'));

  if (command === 'clients') {
    quietLogger();
    return { handled: true, exitCode: listClients() };
  }

  if (command === 'revoke') {
    quietLogger();
    const clientId = argv[argv.indexOf('revoke') + 1];
    if (!clientId || clientId.startsWith('-')) {
      process.stderr.write('Usage: repo-bridge revoke <client-id>\n\nList them with: repo-bridge clients\n');
      return { handled: true, exitCode: 1 };
    }
    return { handled: true, exitCode: revokeClient(clientId) };
  }

  if (command && !['stdio', 'http', 'both'].includes(command)) {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return { handled: true, exitCode: 1 };
  }

  return { handled: false, exitCode: 0 };
}

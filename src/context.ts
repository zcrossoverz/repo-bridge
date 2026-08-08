/**
 * Per-request caller context.
 *
 * The bridge serves several clients from one process: a ChatGPT connector, a
 * local stdio client, an MCP Inspector session. They must not share "the active
 * workspace" — otherwise one client opening a repository silently redirects
 * another client's next edit into it.
 *
 * AsyncLocalStorage carries the caller's identity down to the workspace registry
 * without threading a parameter through all 30 tool handlers, and without a
 * mutable global that the next await would corrupt.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /**
   * Stable identity of the caller: `oauth:<client_id>`, `path-token`, or
   * `local:stdio`. Never token material — this ends up in logs.
   */
  principal: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** stdio has exactly one caller and no HTTP layer to wrap it. */
export const STDIO_PRINCIPAL = 'local:stdio';

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentPrincipal(): string {
  return storage.getStore()?.principal ?? STDIO_PRINCIPAL;
}

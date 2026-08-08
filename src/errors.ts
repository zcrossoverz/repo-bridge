/**
 * Error taxonomy. Every failure the model can trigger should be a BridgeError so
 * the tool layer can return an actionable message instead of a stack trace.
 */
export type BridgeErrorCode =
  | 'NO_WORKSPACE'
  | 'WORKSPACE_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_NOT_FOUND'
  | 'SECRET_BLOCKED'
  | 'PERMISSION_DENIED'
  | 'COMMAND_BLOCKED'
  | 'DESTRUCTIVE_BLOCKED'
  | 'PROTECTED_BRANCH'
  | 'GIT_ERROR'
  | 'FORGE_ERROR'
  | 'PATCH_FAILED'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'INVALID_ARGUMENT';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  /** Concrete next step the agent can take. Surfaced verbatim to the model. */
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BridgeErrorCode,
    message: string,
    opts: { hint?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  toPayload(): Record<string, unknown> {
    return {
      ok: false,
      error: { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) },
      ...(this.details ?? {}),
    };
  }
}

export function isBridgeError(e: unknown): e is BridgeError {
  return e instanceof BridgeError;
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Capability gating. Tools declare a capability; the configured permission level
 * decides whether it runs. Nothing else in the codebase should compare levels.
 */
import { atLeast, describeLevel, type PermissionLevel } from '../config.js';
import { BridgeError } from '../errors.js';

export type Capability =
  | 'read' // list, read, search, git inspection
  | 'write' // create/modify/move/delete files
  | 'exec' // run build/test/lint/approved commands
  | 'git_local' // branch, stage, commit, local restore
  | 'git_remote' // push, fetch/pull from remotes
  | 'forge'; // create pull/merge requests

const REQUIRED: Record<Capability, PermissionLevel> = {
  read: 'read_only',
  write: 'edit',
  exec: 'develop',
  git_local: 'develop',
  git_remote: 'full',
  forge: 'full',
};

export function allows(level: PermissionLevel, cap: Capability): boolean {
  return atLeast(level, REQUIRED[cap]);
}

export function requireCapability(level: PermissionLevel, cap: Capability): void {
  if (allows(level, cap)) return;
  throw new BridgeError(
    'PERMISSION_DENIED',
    `This action needs permission level "${REQUIRED[cap]}" but the bridge is running as "${level}".`,
    {
      hint:
        `Current level: ${describeLevel(level)}\n` +
        `Ask the operator to restart the bridge with REPO_BRIDGE_PERMISSION=${REQUIRED[cap]} (or higher).`,
    },
  );
}

/** Human-readable capability matrix, surfaced by the `bridge_status` tool. */
export function capabilityMatrix(level: PermissionLevel): Record<Capability, boolean> {
  return {
    read: allows(level, 'read'),
    write: allows(level, 'write'),
    exec: allows(level, 'exec'),
    git_local: allows(level, 'git_local'),
    git_remote: allows(level, 'git_remote'),
    forge: allows(level, 'forge'),
  };
}

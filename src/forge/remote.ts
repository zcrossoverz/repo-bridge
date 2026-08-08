/**
 * Repository reference parsing. Accepts every form a user is likely to paste:
 *
 *   github:owner/repo            gitlab:group/subgroup/repo
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo.git
 *   https://self-hosted.example.com/group/repo.git
 */
import path from 'node:path';
import { BridgeError } from '../errors.js';
import type { RemoteInfo } from '../workspace/registry.js';

/** A filesystem path, not a hosted repository: "C:\repos\x.git", "/srv/x.git", "../x". */
function isLocalPath(input: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('/') || input.startsWith('.') || input.startsWith('file://');
}

export function parseRepoSpec(spec: string): RemoteInfo {
  const input = spec.trim();
  if (!input) throw new BridgeError('INVALID_ARGUMENT', 'repository is empty');

  // Local paths are valid git remotes but have no forge behind them. Recognise
  // them explicitly so callers get "no pull requests here" rather than a
  // confusing parse error from the SSH/URL branches below.
  if (isLocalPath(input)) {
    const clean = input.replace(/^file:\/\//, '').replace(/[\\/]+$/, '');
    return {
      provider: 'other',
      host: 'local',
      owner: path.dirname(clean),
      repo: path.basename(clean).replace(/\.git$/, ''),
      cloneUrl: input,
    };
  }

  // Shorthand: github:owner/repo
  const shorthand = input.match(/^(github|gitlab):\/{0,2}(.+)$/i);
  if (shorthand) {
    const provider = shorthand[1]!.toLowerCase() as 'github' | 'gitlab';
    const pathPart = shorthand[2]!.replace(/^\/+/, '').replace(/\.git$/, '');
    // A shorthand containing a host (github:github.com/o/r) is really a URL.
    if (!pathPart.includes('.') || pathPart.split('/').length === 2) {
      const host = provider === 'github' ? 'github.com' : 'gitlab.com';
      return fromPath(provider, host, pathPart, `https://${host}/${pathPart}.git`);
    }
  }

  // SSH: git@host:path/to/repo.git
  const ssh = input.match(/^(?:ssh:\/\/)?(?:([^@]+)@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (ssh && !/^https?:/i.test(input)) {
    const host = ssh[2]!;
    const pathPart = ssh[3]!;
    return fromPath(providerOf(host), host, pathPart, input);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BridgeError('INVALID_ARGUMENT', `Could not parse repository reference: ${spec}`, {
      hint: 'Use github:owner/repo, https://host/owner/repo.git, or git@host:owner/repo.git',
    });
  }
  const pathPart = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  // Strip any credentials the user pasted — we inject our own at push time.
  url.username = '';
  url.password = '';
  const cloneUrl = url.toString().replace(/\/$/, '') + (url.pathname.endsWith('.git') ? '' : '.git');
  return fromPath(providerOf(url.hostname), url.hostname, pathPart, cloneUrl);
}

function providerOf(host: string): RemoteInfo['provider'] {
  const h = host.toLowerCase();
  if (h.includes('github')) return 'github';
  if (h.includes('gitlab')) return 'gitlab';
  return 'other';
}

function fromPath(provider: RemoteInfo['provider'], host: string, pathPart: string, cloneUrl: string): RemoteInfo {
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new BridgeError('INVALID_ARGUMENT', `Repository path needs owner and name: "${pathPart}"`);
  }
  const repo = segments[segments.length - 1]!.replace(/\.git$/, '');
  const owner = segments.slice(0, -1).join('/'); // GitLab subgroups keep their full path
  return { provider, host, owner, repo, cloneUrl };
}

/** `owner/repo`, used for API paths and log lines. */
export function fullName(remote: RemoteInfo): string {
  return `${remote.owner}/${remote.repo}`;
}

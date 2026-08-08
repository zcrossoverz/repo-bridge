/**
 * GitHub / GitLab REST integration — pull and merge request creation.
 *
 * Deliberately narrow: opening (and finding) a PR/MR is the only outward-facing
 * write the bridge performs. Merging, releasing, and repository administration
 * are out of scope and stay with the human.
 */
import { loadConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { registerLiteralSecret } from '../security/secrets.js';
import type { RemoteInfo } from '../workspace/registry.js';

export interface PullRequestInput {
  title: string;
  body: string;
  /** Source branch. */
  head: string;
  /** Target branch. */
  base: string;
  draft?: boolean;
}

export interface PullRequestResult {
  provider: 'github' | 'gitlab';
  number: number;
  url: string;
  title: string;
  state: string;
  head: string;
  base: string;
  created: boolean;
}

const USER_AGENT = 'repo-bridge-mcp/1.0';
const TIMEOUT_MS = 30_000;

async function api(url: string, init: RequestInit & { token: string; tokenHeader: 'bearer' | 'private' }): Promise<unknown> {
  const { token, tokenHeader, ...rest } = init;
  registerLiteralSecret(token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(tokenHeader === 'bearer' ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token }),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = (e as Error).name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : (e as Error).message;
    throw new BridgeError('FORGE_ERROR', `Request to ${new URL(url).host} failed: ${msg}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!res.ok) {
    const detail =
      typeof payload === 'object' && payload
        ? ((payload as { message?: string; error?: string }).message ??
           (payload as { error?: string }).error ??
           JSON.stringify(payload).slice(0, 400))
        : String(payload).slice(0, 400);
    throw new BridgeError('FORGE_ERROR', `${res.status} ${res.statusText}: ${detail}`, {
      hint:
        res.status === 401 || res.status === 403
          ? 'The configured token lacks permission. GitHub needs the "repo" scope (or Contents+Pull requests: write for fine-grained tokens); GitLab needs "api".'
          : res.status === 404
            ? 'Repository not found, or the token cannot see it. Check the owner/repo and the token\'s access.'
            : res.status === 422
              ? 'The forge rejected the request — usually the head branch has no commits ahead of base, or a PR already exists.'
              : undefined,
    });
  }
  return payload;
}

function requireToken(provider: 'github' | 'gitlab'): string {
  const cfg = loadConfig();
  const token = provider === 'github' ? cfg.forge.githubToken : cfg.forge.gitlabToken;
  if (!token) {
    throw new BridgeError('FORGE_ERROR', `No ${provider} token is configured.`, {
      hint:
        provider === 'github'
          ? 'Set GITHUB_TOKEN in the bridge environment (needs the "repo" scope).'
          : 'Set GITLAB_TOKEN in the bridge environment (needs the "api" scope).',
    });
  }
  return token;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

interface GhPull {
  number: number;
  html_url: string;
  title: string;
  state: string;
  draft?: boolean;
}

async function githubFindPull(remote: RemoteInfo, head: string, base: string): Promise<GhPull | null> {
  const cfg = loadConfig();
  const token = requireToken('github');
  const owner = remote.owner.split('/')[0]!;
  const q = new URLSearchParams({ head: `${owner}:${head}`, base, state: 'open' });
  const url = `${cfg.forge.githubApiBase}/repos/${remote.owner}/${remote.repo}/pulls?${q}`;
  const list = (await api(url, { method: 'GET', token, tokenHeader: 'bearer' })) as GhPull[];
  return Array.isArray(list) && list.length > 0 ? list[0]! : null;
}

async function githubCreatePull(remote: RemoteInfo, input: PullRequestInput): Promise<PullRequestResult> {
  const cfg = loadConfig();
  const token = requireToken('github');

  const existing = await githubFindPull(remote, input.head, input.base);
  if (existing) {
    return {
      provider: 'github',
      number: existing.number,
      url: existing.html_url,
      title: existing.title,
      state: existing.state,
      head: input.head,
      base: input.base,
      created: false,
    };
  }

  const url = `${cfg.forge.githubApiBase}/repos/${remote.owner}/${remote.repo}/pulls`;
  const created = (await api(url, {
    method: 'POST',
    token,
    tokenHeader: 'bearer',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    }),
  })) as GhPull;

  return {
    provider: 'github',
    number: created.number,
    url: created.html_url,
    title: created.title,
    state: created.state,
    head: input.head,
    base: input.base,
    created: true,
  };
}

// ── GitLab ───────────────────────────────────────────────────────────────────

interface GlMr {
  iid: number;
  web_url: string;
  title: string;
  state: string;
}

async function gitlabCreateMr(remote: RemoteInfo, input: PullRequestInput): Promise<PullRequestResult> {
  const cfg = loadConfig();
  const token = requireToken('gitlab');
  const projectId = encodeURIComponent(`${remote.owner}/${remote.repo}`);
  const base = `${cfg.forge.gitlabApiBase}/projects/${projectId}/merge_requests`;

  const q = new URLSearchParams({ source_branch: input.head, target_branch: input.base, state: 'opened' });
  const existingList = (await api(`${base}?${q}`, { method: 'GET', token, tokenHeader: 'private' })) as GlMr[];
  const existing = Array.isArray(existingList) && existingList.length > 0 ? existingList[0]! : null;
  if (existing) {
    return {
      provider: 'gitlab',
      number: existing.iid,
      url: existing.web_url,
      title: existing.title,
      state: existing.state,
      head: input.head,
      base: input.base,
      created: false,
    };
  }

  const created = (await api(base, {
    method: 'POST',
    token,
    tokenHeader: 'private',
    body: JSON.stringify({
      title: input.draft ? `Draft: ${input.title}` : input.title,
      description: input.body,
      source_branch: input.head,
      target_branch: input.base,
      remove_source_branch: true,
    }),
  })) as GlMr;

  return {
    provider: 'gitlab',
    number: created.iid,
    url: created.web_url,
    title: created.title,
    state: created.state,
    head: input.head,
    base: input.base,
    created: true,
  };
}

export async function createPullRequest(remote: RemoteInfo, input: PullRequestInput): Promise<PullRequestResult> {
  if (!input.title.trim()) throw new BridgeError('INVALID_ARGUMENT', 'Pull request title is required.');
  if (input.head === input.base) {
    throw new BridgeError('INVALID_ARGUMENT', `head and base are both "${input.head}".`);
  }

  switch (remote.provider) {
    case 'github':
      return githubCreatePull(remote, input);
    case 'gitlab':
      return gitlabCreateMr(remote, input);
    default:
      throw new BridgeError('FORGE_ERROR', `Pull requests are not supported for host "${remote.host}".`, {
        hint: 'Only GitHub and GitLab are integrated. The branch has been pushed — open the request manually.',
      });
  }
}

/** Whether a token exists for the given remote — reported by bridge_status. */
export function forgeConfigured(provider: RemoteInfo['provider']): boolean {
  const cfg = loadConfig();
  if (provider === 'github') return !!cfg.forge.githubToken;
  if (provider === 'gitlab') return !!cfg.forge.gitlabToken;
  return false;
}

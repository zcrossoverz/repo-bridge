/**
 * Pull / merge request creation — the one outward-facing write in the bridge.
 */
import { BridgeError } from '../errors.js';
import { audit } from '../logger.js';
import { createPullRequest } from '../forge/forge.js';
import { parseRepoSpec } from '../forge/remote.js';
import {
  assertGitRepo,
  assertNotProtected,
  authConfig,
  currentBranch,
  defaultBranch,
  getStatus,
  git,
  log as gitLog,
  originUrl,
} from '../git/git.js';
import { registry } from '../workspace/registry.js';
import { block, bullets, join, kv, type ToolDef } from './types.js';

export const forgeTools: ToolDef[] = [
  {
    name: 'create_pull_request',
    description:
      'Push the current branch (unless already pushed) and open a pull request on GitHub or a merge request on GitLab. Write a title in the repository\'s convention and a body that states what changed, why, and what verification was run. If an open request already exists for this branch, its URL is returned instead of creating a duplicate.',
    capability: 'forge',
    sideEffecting: true,
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace alias. Defaults to the active workspace.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: {
          type: 'string',
          description: 'Description. Include: what changed, why, files touched, and the tests/build you actually ran with their result.',
        },
        base: { type: 'string', description: 'Target branch. Default: the repository default branch (or the branch the workspace was opened from).' },
        head: { type: 'string', description: 'Source branch. Default: the current branch.' },
        draft: { type: 'boolean', description: 'Open as a draft. Default false.' },
        push: { type: 'boolean', description: 'Push the head branch first. Default true.' },
      },
      required: ['title', 'body'],
    },
    handler: async (args) => {
      const w = registry().require(args.optStr('workspace'));
      await assertGitRepo(w.root);

      const head = args.optStr('head') ?? (await currentBranch(w.root));
      const base = args.optStr('base') ?? w.remote?.baseBranch ?? (await defaultBranch(w.root)) ?? 'main';

      if (head === base) {
        throw new BridgeError('INVALID_ARGUMENT', `head and base are both "${head}" — commit your work on a feature branch first.`);
      }
      assertNotProtected(head, 'open a pull request from');

      const url = await originUrl(w.root);
      if (!url) {
        throw new BridgeError('GIT_ERROR', 'No git remote is configured, so there is nowhere to open a pull request.');
      }
      const remote = w.remote ?? parseRepoSpec(url);

      const status = await getStatus(w.root);
      if (!status.clean) {
        throw new BridgeError('GIT_ERROR', `Uncommitted changes in ${status.staged.length + status.unstaged.length + status.untracked.length} file(s).`, {
          hint: 'Commit (git_commit) before opening a pull request, so the request contains the whole change.',
        });
      }

      if (args.bool('push', true)) {
        const push = await git(w.root, ['push', '--set-upstream', 'origin', head], {
          allowFail: true,
          config: authConfig(url),
          timeoutMs: 300_000,
        });
        if (!push.ok && !/everything up-to-date/i.test(push.stderr)) {
          throw new BridgeError('GIT_ERROR', `Push failed: ${push.stderr.trim().split('\n').slice(0, 5).join('\n')}`, {
            hint: 'The pull request cannot be created until the branch exists on the remote.',
          });
        }
        registry().recordGit(w.id, 'push', `origin/${head}`);
      }

      const result = await createPullRequest(remote, {
        title: args.str('title'),
        body: args.str('body', ''),
        head,
        base,
        draft: args.bool('draft', false),
      });

      registry().recordGit(w.id, result.created ? 'pull_request' : 'pull_request_existing', `#${result.number} ${result.url}`);
      audit({
        action: 'create_pull_request',
        workspace: w.alias,
        target: `${remote.owner}/${remote.repo}#${result.number}`,
        outcome: 'ok',
        detail: { created: result.created, base, head },
      });

      const commits = await gitLog(w.root, 10, `${base}..${head}`);
      return join(
        block(result.created ? 'PULL REQUEST CREATED' : 'PULL REQUEST ALREADY OPEN', [
          ...kv({
            provider: result.provider,
            number: `#${result.number}`,
            url: result.url,
            title: result.title,
            head: result.head,
            base: result.base,
            state: result.state,
          }),
        ]),
        commits.length ? block('COMMITS INCLUDED', bullets(commits.map((c) => `${c.shortHash} ${c.subject}`), 10)) : '',
      );
    },
  },
];

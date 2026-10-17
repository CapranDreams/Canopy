import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { GhRun, GitHubClient, GitHubError, aggregateRuns, apiBaseFor, matchGitHubRemote, runStatus, summarizeReviews } from '../src/forge/githubApi';

test('matchGitHubRemote: https, scp, ssh.github.com, enterprise hosts', () => {
  const hosts = ['github.com', 'github.example.com'];
  assert.deepEqual(matchGitHubRemote('https://github.com/Octo/Hello-World.git', hosts), { host: 'github.com', owner: 'Octo', repo: 'Hello-World' });
  assert.deepEqual(matchGitHubRemote('git@github.com:octo/hello.git', hosts), { host: 'github.com', owner: 'octo', repo: 'hello' });
  assert.deepEqual(matchGitHubRemote('ssh://git@ssh.github.com:443/octo/hello.git', hosts), { host: 'github.com', owner: 'octo', repo: 'hello' });
  assert.equal(matchGitHubRemote('https://github.example.com/team/app', hosts)?.host, 'github.example.com');
  assert.equal(matchGitHubRemote('https://gitlab.com/a/b', hosts), undefined);
  assert.equal(matchGitHubRemote('https://github.com/only-owner', hosts), undefined);
  assert.equal(matchGitHubRemote('https://github.com/a/b/c', hosts), undefined);
  assert.equal(apiBaseFor('github.com'), 'https://api.github.com');
  assert.equal(apiBaseFor('github.example.com'), 'https://github.example.com/api/v3');
});

test('run status mapping and aggregation for the newest commit', () => {
  const run = (id: number, sha: string, status: string, conclusion: string | null): GhRun => ({ id, name: 'w', status, conclusion, html_url: `/r/${id}`, head_sha: sha, head_branch: 'b' });
  assert.equal(runStatus({ status: 'queued', conclusion: null }), 'running');
  assert.equal(runStatus({ status: 'completed', conclusion: 'timed_out' }), 'failed');
  assert.equal(runStatus({ status: 'completed', conclusion: 'cancelled' }), 'canceled');
  assert.equal(runStatus({ status: 'completed', conclusion: 'neutral' }), 'skipped');

  const failing = aggregateRuns([run(3, 'new', 'completed', 'success'), run(2, 'new', 'completed', 'failure'), run(1, 'old', 'completed', 'failure')]);
  assert.deepEqual([failing?.status, failing?.sha, failing?.run.id], ['failed', 'new', 2]);
  const running = aggregateRuns([run(5, 'n', 'in_progress', null), run(4, 'n', 'completed', 'success')]);
  assert.equal(running?.status, 'running');
  assert.equal(aggregateRuns([run(6, 'n', 'completed', 'success'), run(7, 'old', 'completed', 'failure')])?.status, 'success');
  assert.equal(aggregateRuns([]), undefined);
});

test('reviews: latest review per person decides', () => {
  assert.deepEqual(summarizeReviews([{ user: { login: 'a' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'b' }, state: 'COMMENTED' }]), { approved: true, changesRequested: false, approvedBy: ['a'] });
  assert.equal(summarizeReviews([{ user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'b' }, state: 'CHANGES_REQUESTED' }]).approved, false);
  assert.equal(summarizeReviews([]).approved, false);
});

test('GitHubClient: headers, ETag reuse, Link pagination, errors, token stays on the API host', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let userHits = 0;
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const h = init.headers as Record<string, string>;
    const u = new URL(url);
    if (u.pathname === '/user') {
      userHits++;
      if (h['If-None-Match'] === '"e1"') return new Response(null, { status: 304, headers: { etag: '"e1"' } });
      return new Response(JSON.stringify({ login: 'octo', name: null }), { status: 200, headers: { etag: '"e1"', 'x-oauth-scopes': 'repo, read:org' } });
    }
    if (u.pathname === '/orgs/acme/repos') {
      const page = u.searchParams.get('page');
      if (!page) return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200, headers: { link: '<https://api.github.com/orgs/acme/repos?per_page=100&page=2>; rel="next", <https://api.github.com/orgs/acme/repos?page=2>; rel="last"' } });
      return new Response(JSON.stringify([{ id: 3 }]), { status: 200 });
    }
    if (u.pathname === '/repos/o/r') return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  const c = new GitHubClient('https://api.github.com', 'tok', fetchFn);
  const first = await c.user();
  assert.equal(first.user.login, 'octo');
  assert.deepEqual(first.scopes, ['repo', 'read:org']);
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer tok');
  assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
  const second = await c.user();
  assert.equal(second.user.login, 'octo', 'a 304 answer returns the cached body');
  assert.equal(userHits, 2);

  const repos = await c.orgRepos('acme');
  assert.deepEqual(repos.map((r) => r.id), [1, 2, 3]);

  await assert.rejects(c.repo('o', 'r'), (e: GitHubError) => e.status === 403 && /rate limit/.test(e.message));
  await assert.rejects(c.repo('x', 'y'), (e: GitHubError) => e.status === 404);

  const evil = new GitHubClient('https://api.github.com', 'tok', async () => new Response(JSON.stringify([]), { status: 200, headers: { link: '<https://evil.example/next>; rel="next"' } }));
  assert.deepEqual(await evil.orgRepos('acme'), [], 'a next link on another host is not followed');
});

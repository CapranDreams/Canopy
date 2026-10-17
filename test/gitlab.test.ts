import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { GitLabClient, GitLabError } from '../src/forge/gitlabApi';
import { matchRemote, pipelineSymbol, suggestHosts, tokenPageUrl, validateInstanceUrl } from '../src/forge/instances';
import { compileQuery } from '../src/model/query';
import { RepoFacts } from '../src/model/types';

test('matchRemote: https, ssh, sub-path installs and ssh aliases', () => {
  const instances = [{ url: 'https://gitlab.example.com' }, { url: 'https://code.example.org/gitlab', sshHosts: ['ssh.example.org'] }];
  assert.deepEqual(matchRemote('https://user:tok@gitlab.example.com/group/sub/proj.git', instances)?.projectPath, 'group/sub/proj');
  assert.deepEqual(matchRemote('git@gitlab.example.com:group/proj.git', instances)?.projectPath, 'group/proj');
  assert.deepEqual(matchRemote('ssh://git@gitlab.example.com:2222/group/proj.git', instances)?.projectPath, 'group/proj');
  assert.equal(matchRemote('https://code.example.org/gitlab/team/app.git', instances)?.instance.url, 'https://code.example.org/gitlab');
  assert.equal(matchRemote('https://code.example.org/gitlab/team/app.git', instances)?.projectPath, 'team/app');
  assert.equal(matchRemote('https://code.example.org/other/team/app.git', instances), undefined);
  assert.equal(matchRemote('git@ssh.example.org:team/app.git', instances)?.projectPath, 'team/app');
  assert.equal(matchRemote('git@github.com:o/r.git', instances), undefined);
  assert.equal(matchRemote('https://gitlab.example.com/onlyone', instances), undefined);
});

test('instance URL validation, host suggestions, token page, symbols', () => {
  assert.equal(validateInstanceUrl('https://gitlab.example.com/'), undefined);
  assert.equal(validateInstanceUrl('http://127.0.0.1:8080'), undefined);
  assert.match(validateInstanceUrl('http://gitlab.example.com') ?? '', /https/);
  assert.match(validateInstanceUrl('gitlab.example.com') ?? '', /full URL/);
  const s = suggestHosts(['git@gitlab.corp.example:a/b.git', 'https://gitlab.corp.example/c/d', 'https://github.com/x/y', 'https://gitlab.com/k/l'], [{ url: 'https://gitlab.com' }]);
  assert.deepEqual([...s.entries()], [['gitlab.corp.example', 2]]);
  assert.equal(tokenPageUrl({ url: 'https://gitlab.example.com/' }), 'https://gitlab.example.com/-/user_settings/personal_access_tokens?name=CANOPY&scopes=api');
  assert.equal(pipelineSymbol('failed'), '✗');
  assert.equal(pipelineSymbol('waiting_for_resource'), '◷');
});

type FakeResponse = { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(handler: (url: URL, init: RequestInit) => FakeResponse) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    const r = handler(new URL(input), init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  };
  return { fn, calls };
}

test('GitLabClient: auth header, pagination, errors, redirects, draft title', async () => {
  const { fn, calls } = fakeFetch((url, init): FakeResponse => {
    if (url.pathname === '/api/v4/groups/acme%2Fteam/projects' || url.pathname === '/api/v4/groups/acme/team/projects') {
      const page = url.searchParams.get('page');
      return page === '1' ? { body: [{ id: 1 }, { id: 2 }], headers: { 'x-next-page': '2' } } : { body: [{ id: 3 }], headers: { 'x-next-page': '' } };
    }
    if (url.pathname === '/api/v4/user') return (init.headers as Record<string, string>).Authorization === 'Bearer good' ? { body: { id: 1, username: 'me', name: 'Me' } } : { status: 401, body: { message: '401 Unauthorized' } };
    if (url.pathname === '/api/v4/redirect') return { status: 302, headers: { location: 'https://evil.example/' } };
    if (url.pathname === '/api/v4/projects/5/merge_requests' && init.method === 'POST') return { status: 201, body: { iid: 3, ...JSON.parse(String(init.body)) } };
    return { status: 404, body: { message: '404 Project Not Found' } };
  });
  const good = new GitLabClient('https://gitlab.example.com/', 'good', fn);
  assert.equal((await good.currentUser()).username, 'me');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer good');
  assert.equal(calls[0].init.redirect, 'manual');

  const projects = await good.groupProjects('acme/team');
  assert.deepEqual(projects.map((p) => p.id), [1, 2, 3]);
  assert.match(calls[1].url, /include_subgroups=true/);

  const bad = new GitLabClient('https://gitlab.example.com', 'nope', fn);
  await assert.rejects(bad.currentUser(), (e: GitLabError) => e.status === 401 && /invalid, expired or revoked/.test(e.message));
  await assert.rejects(good.project('missing/proj'), (e: GitLabError) => e.status === 404 && /Not found/.test(e.message));
  await assert.rejects((good as unknown as { get(p: string): Promise<unknown> }).get('/redirect'), (e: GitLabError) => /redirected to https:\/\/evil\.example/.test(e.message));

  const mr = (await good.createMergeRequest(5, { sourceBranch: 'feat', targetBranch: 'main', title: 'Add thing', draft: true })) as unknown as Record<string, unknown>;
  assert.equal(mr.title, 'Draft: Add thing');
  assert.equal(mr.remove_source_branch, true);

  const down = new GitLabClient('https://gitlab.example.com', 't', async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
  });
  await assert.rejects(down.currentUser(), (e: GitLabError) => e.status === 0 && /UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(e.message));
});

test('query terms for GitLab state', () => {
  const base = { key: 'r', name: 'r', root: '/r', branch: 'feat', detached: false, headShort: 'a', upstream: 'origin/feat', ahead: 0, behind: 0, changed: 0, staged: 0, conflicts: 0, operation: null, lastCommitTime: 0, remoteUrls: [], folderNames: [], error: null, loaded: true, ci: null, mr: null, mrConflicts: false } as RepoFacts;
  const failing = { ...base, ci: 'failed', mr: 'draft' as const, mrConflicts: true };
  const running = { ...base, ci: 'pending' };
  assert.equal(compileQuery('pipeline:failed')(failing), true);
  assert.equal(compileQuery('ci:running')(running), true);
  assert.equal(compileQuery('pipeline:none')(base), true);
  assert.equal(compileQuery('is:mr AND is:draft AND is:mr-conflict')(failing), true);
  assert.equal(compileQuery('is:mr')(base), false);
});

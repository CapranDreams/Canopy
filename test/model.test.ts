import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { layoutGraph } from '../src/git/graph';
import { addFolder, deleteFolder, findFolder, folderOfRepo, moveFolder, moveRepos, normalizeLayout, setHidden, EMPTY_LAYOUT } from '../src/model/layout';
import { compileQuery, validateQuery } from '../src/model/query';
import { RepoFacts, attentionOf, compareRepos } from '../src/model/types';
import { normalizeRemote, validateCloneUrl, validateRefName, validateRelativePath, webUrlForRemote } from '../src/util/remote';
import { decodeShareData, encodeShareData, parseProfile, planProfile, toProfileFile, LocalRepoState } from '../src/model/profile';

function facts(p: Partial<RepoFacts>): RepoFacts {
  return { key: p.name ?? 'r', name: 'r', root: '/w/r', branch: 'main', detached: false, headShort: 'abc', upstream: 'origin/main', ahead: 0, behind: 0, changed: 0, staged: 0, conflicts: 0, operation: null, lastCommitTime: 0, remoteUrls: ['git@github.com:o/r.git'], folderNames: [], error: null, loaded: true, ci: null, mr: null, mrConflicts: false, ...p };
}

test('graph: linear history stays in lane 0', () => {
  const { rows, width } = layoutGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] }
  ]);
  assert.equal(width, 1);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows[2].lines, [{ x1: 0, y1: 0, x2: 0, y2: 1, color: 0 }]);
});

test('graph: branch and merge use a second lane and converge', () => {
  // m merges f into main; f and b both come from a.
  const { rows, width } = layoutGraph([
    { hash: 'm', parents: ['b', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] }
  ]);
  assert.equal(width, 2);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 0]);
  // The side lane bends back into lane 0 on the row above their common parent.
  assert.ok(rows[2].lines.some((l) => l.x1 === 1 && l.y1 === 0 && l.x2 === 0 && l.y2 === 2));
  assert.deepEqual(rows[3].lines, [{ x1: 0, y1: 0, x2: 0, y2: 1, color: 0 }]);
});

test('graph: lanes are reused after a branch ends', () => {
  const { width } = layoutGraph([
    { hash: 'd', parents: ['c', 'x'] },
    { hash: 'x', parents: ['c'] },
    { hash: 'c', parents: ['b', 'y'] },
    { hash: 'y', parents: ['b'] },
    { hash: 'b', parents: [] }
  ]);
  assert.equal(width, 2);
});

test('query language', () => {
  const now = 1_700_000_000;
  const dirtyRecent = facts({ name: 'web-app', changed: 2, lastCommitTime: now - 86400 });
  const behind = facts({ name: 'protos', behind: 3, folderNames: ['Backend'] });
  const conflict = facts({ name: 'worker', conflicts: 2, operation: 'rebase', branch: 'fix/redis' });
  const q = compileQuery('is:conflict OR (is:dirty AND age<7d)');
  assert.equal(q(dirtyRecent, now), true);
  assert.equal(q(conflict, now), true);
  assert.equal(q(behind, now), false);
  assert.equal(compileQuery('folder:back*')(behind), true);
  assert.equal(compileQuery('branch:fix/*')(conflict), true);
  assert.equal(compileQuery('-name:web behind>2')(behind), true);
  assert.equal(compileQuery('NOT is:behind')(behind), false);
  assert.equal(compileQuery('app')(dirtyRecent), true);
  assert.match(validateQuery('is:nonsense') ?? '', /Unknown/);
  assert.match(validateQuery('(is:dirty') ?? '', /parenthesis/);
});

test('query language: globs over names and CANOPY folders', () => {
  const api = facts({ name: 'api-gateway', folderNames: ['Platform', 'Backend'] });
  const auth = facts({ name: 'auth-service', folderNames: ['Platform'] });
  const web = facts({ name: 'web-app', folderNames: ['Frontend'] });
  const loose = facts({ name: 'scratch' });
  const all = [api, auth, web, loose];
  const match = (q: string) => all.filter((f) => compileQuery(q)(f)).map((f) => f.name);
  // Bare globs: repo name, or any folder the repo lives in.
  assert.deepEqual(match('api-*'), ['api-gateway']);
  assert.deepEqual(match('plat*'), ['api-gateway', 'auth-service']);
  assert.deepEqual(match('Platform/*'), ['api-gateway', 'auth-service']);
  assert.deepEqual(match('Platform/Backend/*'), ['api-gateway']);
  assert.deepEqual(match('*-{app,service}'), ['auth-service', 'web-app']);
  assert.deepEqual(match('?eb-app'), ['web-app']);
  assert.deepEqual(match('[aw]*'), ['api-gateway', 'auth-service', 'web-app']);
  assert.deepEqual(match('name:[!aw]*'), ['scratch']);
  // Plain text still matches anywhere.
  assert.deepEqual(match('front'), ['web-app']);
  // folder: / in: look only at folders (any level, or a path); repo: is the bare-word match spelled out.
  assert.deepEqual(match('folder:backend'), ['api-gateway']);
  assert.deepEqual(match('in:Platform/B*'), ['api-gateway']);
  assert.deepEqual(match('folder:platform -name:auth*'), ['api-gateway']);
  assert.deepEqual(match('repo:web*'), ['web-app']);
  assert.match(validateQuery('name:[z-a]') ?? '', /Invalid pattern/);
});

test('attention ordering', () => {
  const list = [facts({ name: 'clean' }), facts({ name: 'ahead', ahead: 1 }), facts({ name: 'behind', behind: 1 }), facts({ name: 'conf', conflicts: 1 }), facts({ name: 'div', behind: 1, ahead: 1 }), facts({ name: 'dirty', changed: 3 })];
  assert.deepEqual(list.sort(compareRepos('attention')).map((r) => r.name), ['conf', 'div', 'behind', 'dirty', 'ahead', 'clean']);
  assert.equal(attentionOf(facts({ upstream: null })), 'unpublished');
  assert.equal(attentionOf(facts({ upstream: null, remoteUrls: [] })), 'clean');
});

test('changes ordering', () => {
  const list = [facts({ name: 'clean' }), facts({ name: 'few', changed: 1 }), facts({ name: 'many', changed: 9 }), facts({ name: 'b-some', changed: 3 }), facts({ name: 'a-some', changed: 3 })];
  assert.deepEqual(list.sort(compareRepos('changes')).map((r) => r.name), ['many', 'a-some', 'b-some', 'few', 'clean']);
});

test('layout: folders, moves, nesting, delete, hidden', () => {
  let l = normalizeLayout(EMPTY_LAYOUT);
  const a = addFolder(l, 'Platform');
  l = a.layout;
  const b = addFolder(l, 'Legacy', a.id);
  l = b.layout;
  l = moveRepos(l, ['hub', 'svc'], a.id);
  l = moveRepos(l, ['old'], b.id);
  assert.equal(folderOfRepo(l, 'svc')?.name, 'Platform');
  l = moveRepos(l, ['svc'], a.id, 'hub');
  assert.deepEqual(findFolder(l, a.id)!.repos, ['svc', 'hub']);
  // Cycle refused
  assert.equal(moveFolder(l, a.id, b.id), l);
  l = moveFolder(l, b.id, null);
  assert.equal(l.folders.length, 2);
  l = deleteFolder(l, a.id);
  assert.deepEqual(l.unsorted.sort(), ['hub', 'svc']);
  l = setHidden(l, ['hub'], true);
  assert.deepEqual(l.hidden, ['hub']);
  l = setHidden(l, ['hub'], false);
  assert.deepEqual(l.hidden, []);
  // Hand-edited garbage is tolerated
  const n = normalizeLayout({ folders: [{ name: 'x', repos: ['a', 3, 'a'] }, null], hidden: 'nope' });
  assert.deepEqual(n.folders[0].repos, ['a']);
  assert.deepEqual(n.hidden, []);
});

test('remote normalization and web urls', () => {
  const same = ['git@github.com:Org/Repo.git', 'https://github.com/org/repo', 'ssh://git@github.com:22/org/repo.git', 'https://user:tok@github.com/org/repo.git/'];
  for (const u of same) assert.equal(normalizeRemote(u), 'github.com/org/repo', u);
  assert.equal(normalizeRemote('git@ssh.dev.azure.com:v3/o/p/r'), normalizeRemote('https://o@dev.azure.com/o/p/_git/r'));
  assert.equal(normalizeRemote('C:\\repos\\x.git'), 'c:/repos/x');
  assert.equal(webUrlForRemote('git@github.com:Org/Repo.git', 'feat/a'), 'https://github.com/Org/Repo/tree/feat/a');
  assert.equal(webUrlForRemote('C:\\x'), undefined);
});

test('validation of untrusted profile input', () => {
  assert.equal(validateCloneUrl('https://github.com/o/r.git'), undefined);
  assert.equal(validateCloneUrl('git@github.com:o/r.git'), undefined);
  assert.ok(validateCloneUrl('ext::sh -c touch% /tmp/pwned'));
  assert.ok(validateCloneUrl('--upload-pack=evil'));
  assert.ok(validateRelativePath('../outside'));
  assert.ok(validateRelativePath('C:\\abs'));
  assert.ok(validateRelativePath('/abs'));
  assert.equal(validateRelativePath('platform/web'), undefined);
  assert.ok(validateRefName('-x'));
  assert.ok(validateRefName('a..b'));
  assert.equal(validateRefName('feature/my-change'), undefined);
});

test('profiles: parse, round-trip through a share link, plan', () => {
  const p = parseProfile({
    canopyProfile: 1,
    name: 'Platform onboarding',
    mode: 'track',
    repos: [
      { name: 'hub', remote: 'git@github.com:acme/web-app.git', branch: 'main', path: 'platform/web' },
      { name: 'svc', remote: 'https://github.com/acme/api-server', branch: 'dev', path: 'platform/api' },
      { name: 'mgr', remote: 'https://github.com/acme/worker', branch: 'main', path: 'platform/worker' },
      { name: 'sim', remote: 'https://github.com/acme/simulator', branch: 'main', path: 'platform/sim' },
      { name: 'blocked', remote: 'https://github.com/acme/blocked', branch: 'main', path: 'blocked' }
    ]
  });
  const decoded = parseProfile(decodeShareData(encodeShareData(toProfileFile(p))));
  assert.deepEqual(decoded.repos, p.repos);

  const locals: LocalRepoState[] = [
    { key: 'platform/web', root: 'D:/w/platform/web', remoteUrls: ['https://github.com/acme/web-app'], branch: 'main', headHash: 'a', changed: 0, behind: 2, conflicts: 0, operation: null },
    { key: 'platform/api', root: 'D:/w/platform/api', remoteUrls: ['git@github.com:acme/api-server.git'], branch: 'main', headHash: 'b', changed: 0, behind: 0, conflicts: 0, operation: null },
    { key: 'platform/worker', root: 'D:/w/platform/worker', remoteUrls: ['https://github.com/acme/worker'], branch: 'fix', headHash: 'c', changed: 4, behind: 0, conflicts: 0, operation: null },
    { key: 'blocked', root: 'D:/w/blocked', remoteUrls: ['https://github.com/acme/blocked'], branch: 'x', headHash: 'd', changed: 0, behind: 0, conflicts: 1, operation: 'merge' }
  ];
  const steps = planProfile(p, locals, 'D:/w');
  assert.deepEqual(steps.map((s) => s.kind), ['pull', 'switch', 'stash-switch', 'clone', 'blocked']);
  const noStash = planProfile(p, locals, 'D:/w', { ...p.onApply, stashChanges: false, cloneMissing: false });
  assert.deepEqual(noStash.map((s) => s.kind), ['pull', 'switch', 'blocked', 'skip', 'blocked']);

  assert.throws(() => parseProfile({ name: 'x', repos: [{ remote: 'ext::evil', branch: 'main', path: 'a' }] }), /Remote helper/);
  assert.throws(() => parseProfile({ name: 'x', repos: [{ remote: 'https://x/y', branch: 'main', path: '../../etc' }] }), /\.\./);
  assert.throws(() => parseProfile({ name: 'x', repos: [{ remote: 'https://x/y', branch: 'main', path: 'a' }, { remote: 'https://x/z', branch: 'main', path: 'A' }] }), /used twice/);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { ApiChange, ApiRepoState, ApiStatus, remotesFromApi, statusFromApi } from '../src/git/apiStatus';
import { GitActivity, subcommand } from '../src/git/activity';
import { countAutoDetected } from '../src/util/autoDetect';

const root = path.resolve('/work/app');
const uri = (rel: string) => ({ fsPath: path.join(root, rel) });
const change = (rel: string, status: number, extra: Partial<ApiChange> = {}): ApiChange => ({ uri: uri(rel), originalUri: uri(rel), status, ...extra });
const state = (p: Partial<ApiRepoState>): ApiRepoState => ({ HEAD: { name: 'main', commit: 'abc123', upstream: { remote: 'origin', name: 'main' }, ahead: 2, behind: 1 }, remotes: [], mergeChanges: [], indexChanges: [], workingTreeChanges: [], ...p });

test('statusFromApi: branch, upstream, ahead/behind and every change kind', () => {
  const s = statusFromApi(
    root,
    state({
      indexChanges: [change('src/a.ts', ApiStatus.INDEX_MODIFIED), change('new.ts', ApiStatus.INDEX_ADDED), change('old name.ts', ApiStatus.INDEX_RENAMED, { renameUri: uri('new name.ts') })],
      workingTreeChanges: [change('src/b.ts', ApiStatus.MODIFIED), change('gone.ts', ApiStatus.DELETED), change('docs/x.md', ApiStatus.UNTRACKED), change('ignored.log', ApiStatus.IGNORED)],
      mergeChanges: [change('c.py', ApiStatus.BOTH_MODIFIED)]
    })
  )!;
  assert.equal(s.branch, 'main');
  assert.equal(s.oid, 'abc123');
  assert.equal(s.detached, false);
  assert.equal(s.upstream, 'origin/main');
  assert.deepEqual([s.ahead, s.behind], [2, 1]);
  assert.deepEqual(s.staged.map((f) => [f.status, f.path, f.origPath]), [['M', 'src/a.ts', undefined], ['A', 'new.ts', undefined], ['R', 'new name.ts', 'old name.ts']]);
  assert.deepEqual(s.unstaged.map((f) => [f.status, f.path]), [['M', 'src/b.ts'], ['D', 'gone.ts'], ['U', 'docs/x.md']]);
  assert.deepEqual(s.conflicts.map((f) => [f.status, f.path]), [['C', 'c.py']]);
});

test('statusFromApi: detached HEAD, no upstream, separate untracked list', () => {
  const s = statusFromApi(root, state({ HEAD: { commit: 'def456', ahead: 5 }, untrackedChanges: [change('tmp.txt', ApiStatus.UNTRACKED)] }))!;
  assert.equal(s.detached, true);
  assert.equal(s.branch, null);
  assert.equal(s.upstream, null);
  assert.deepEqual([s.ahead, s.behind], [0, 0], 'no upstream: no ahead/behind');
  assert.deepEqual(s.unstaged.map((f) => f.path), ['tmp.txt']);
});

test('statusFromApi: not usable before the first read or when the change list may be cut off', () => {
  assert.equal(statusFromApi(root, state({ HEAD: undefined })), undefined);
  const many = Array.from({ length: 5 }, (_, i) => change(`f${i}`, ApiStatus.MODIFIED));
  assert.equal(statusFromApi(root, state({ workingTreeChanges: many }), 5), undefined);
  assert.ok(statusFromApi(root, state({ workingTreeChanges: many }), 6));
});

test('remotesFromApi: fetch URL, else push URL', () => {
  const r = remotesFromApi(state({ remotes: [{ name: 'origin', fetchUrl: 'git@x:a/b.git' }, { name: 'push-only', pushUrl: 'https://y/c' }, { name: 'empty' }] }));
  assert.deepEqual([...r], [['origin', 'git@x:a/b.git'], ['push-only', 'https://y/c']]);
});

test('GitActivity: counts by subcommand, windowed, user actions separately', () => {
  let now = 1000;
  const a = new GitActivity(() => now);
  a.record(['status', '--porcelain=v2'], 50, false);
  a.record(['-c', 'protocol.file.allow=always', 'fetch', '--all'], 400, true);
  now = 5000;
  a.record(['status'], 30, false);
  const all = a.summary();
  assert.equal(all.processes, 3);
  assert.equal(all.totalMs, 480);
  assert.deepEqual(all.byCommand.map((c) => [c.cmd, c.count, c.userCount]), [['status', 2, 0], ['fetch', 1, 1]]);
  assert.equal(a.summary(1000).processes, 1, 'only the last second');
  assert.equal(subcommand(['-C', 'dir', 'log', '-1']), 'log');
});

test('countAutoDetected: workspace folders and their subfolders up to the scan depth', () => {
  const ws = path.resolve('/w');
  const roots = [ws, path.join(ws, 'a'), path.join(ws, 'b'), path.join(ws, 'group', 'c'), path.resolve('/elsewhere/d')];
  assert.equal(countAutoDetected(roots, [ws], 1), 3);
  assert.equal(countAutoDetected(roots, [ws], 2), 4);
  assert.equal(countAutoDetected(roots, [ws], 0), 1);
  assert.equal(countAutoDetected(roots, [ws], -1), 4);
  assert.equal(countAutoDetected(roots, [], 1), 0);
});

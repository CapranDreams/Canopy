import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { changedPathCount, parseBranches, parseDecorations, parseLog, parseNameStatusZ, parseNumstatZ, parseRemotes, parseStashes, parseStatusV2, parseWorktrees, withLineStats, parseGitmodulesPaths } from '../src/git/parse';

test('parseStatusV2: branch header, ahead/behind, all entry kinds', () => {
  const out = [
    '# branch.oid 1234567890abcdef1234567890abcdef12345678',
    '# branch.head feat/x',
    '# branch.upstream origin/feat/x',
    '# branch.ab +2 -5',
    '1 M. N... 100644 100644 100644 aaa bbb src/staged file.ts',
    '1 .M N... 100644 100644 100644 aaa bbb src/unstaged.ts',
    '1 MM N... 100644 100644 100644 aaa bbb both.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
    'old name.ts',
    'u UU N... 100644 100644 100644 100644 a b c conflicted.py',
    '? untracked dir/',
    ''
  ].join('\0');
  const s = parseStatusV2(out);
  assert.equal(s.branch, 'feat/x');
  assert.equal(s.detached, false);
  assert.equal(s.upstream, 'origin/feat/x');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 5);
  assert.deepEqual(s.staged.map((f) => [f.status, f.path]), [['M', 'src/staged file.ts'], ['M', 'both.ts'], ['R', 'new name.ts']]);
  assert.equal(s.staged[2].origPath, 'old name.ts');
  assert.deepEqual(s.unstaged.map((f) => [f.status, f.path]), [['M', 'src/unstaged.ts'], ['M', 'both.ts'], ['U', 'untracked dir/']]);
  assert.deepEqual(s.conflicts.map((f) => f.path), ['conflicted.py']);
  assert.equal(changedPathCount(s), 6);
});

test('parseStatusV2: submodule entries record whether the commit moved', () => {
  const out = ['# branch.oid abc', '# branch.head main', '1 .M SC.. 160000 160000 160000 aaa bbb libs/moved', '1 .M S.M. 160000 160000 160000 aaa bbb libs/dirty', '1 .M N... 100644 100644 100644 aaa bbb file.txt', ''].join('\0');
  const s = parseStatusV2(out);
  assert.deepEqual(s.submodules, { 'libs/moved': { commit: true }, 'libs/dirty': { commit: false } });
  assert.equal(s.unstaged.length, 3);
});

test('parseStatusV2: detached and initial', () => {
  const s = parseStatusV2(['# branch.oid (initial)', '# branch.head (detached)', ''].join('\0'));
  assert.equal(s.oid, null);
  assert.equal(s.detached, true);
  assert.equal(s.branch, null);
  assert.equal(s.upstream, null);
});

test('parseDecorations distinguishes head, local, remote, tag', () => {
  const refs = parseDecorations('HEAD -> main, origin/main, origin/HEAD, tag: v1.0, feature/a, upstream/dev', ['origin', 'upstream']);
  assert.deepEqual(refs, [
    { name: 'main', type: 'head' },
    { name: 'origin/main', type: 'remote' },
    { name: 'v1.0', type: 'tag' },
    { name: 'feature/a', type: 'local' },
    { name: 'upstream/dev', type: 'remote' }
  ]);
});

test('parseLog splits records and keeps subjects with odd characters', () => {
  const out = 'aaa\0bbb ccc\0HEAD -> main\0Dana\x001700000000\0Merge branch \'x\' | y\x1e\nbbb\0\0\0Sam\x001600000000\0Initial\x1e\n';
  const c = parseLog(out, ['origin']);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0].parents, ['bbb', 'ccc']);
  assert.equal(c[0].subject, "Merge branch 'x' | y");
  assert.equal(c[0].refs[0].type, 'head');
  assert.deepEqual(c[1].parents, []);
  assert.equal(c[1].time, 1600000000);
});

test('parseBranches, parseStashes, parseWorktrees, parseRemotes', () => {
  const b = parseBranches('refs/heads/main\0origin/main\0*\0abc123\x001700000000\0Subject\nrefs/remotes/origin/HEAD\0\0 \0abc\x000\0x\nrefs/remotes/origin/dev\0\0 \0def\x001\0Dev work\n');
  assert.deepEqual(b.map((x) => [x.name, x.remote, x.current]), [['main', false, true], ['origin/dev', true, false]]);
  assert.equal(b[0].upstream, 'origin/main');

  const st = parseStashes('stash@{0}\x001700000000\0On main: wip\nstash@{1}\x001600000000\0WIP on dev\n');
  assert.deepEqual(st.map((s) => [s.index, s.message]), [[0, 'On main: wip'], [1, 'WIP on dev']]);

  const wt = parseWorktrees('worktree /a\nHEAD 111\nbranch refs/heads/main\n\nworktree /b\nHEAD 222\ndetached\n');
  assert.deepEqual(wt.map((w) => [w.path, w.branch, w.detached]), [['/a', 'main', false], ['/b', undefined, true]]);

  const r = parseRemotes('origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\nfork\thttps://x/y (fetch)\n');
  assert.equal(r.get('origin'), 'git@github.com:o/r.git');
  assert.equal(r.get('fork'), 'https://x/y');
});

test('parseNameStatusZ: plain, renamed and copied entries', () => {
  const out = ['M', 'src/a b.ts', 'R087', 'old.ts', 'new.ts', 'D', 'gone.md', 'C100', 'src.ts', 'copy.ts', 'A', 'added.txt', ''].join('\0');
  assert.deepEqual(parseNameStatusZ(out), [
    { status: 'M', path: 'src/a b.ts' },
    { status: 'R', path: 'new.ts', origPath: 'old.ts' },
    { status: 'D', path: 'gone.md' },
    { status: 'A', path: 'copy.ts', origPath: 'src.ts' },
    { status: 'A', path: 'added.txt' }
  ]);
  assert.deepEqual(parseNameStatusZ(''), []);
});

test('parseNumstatZ: counts, renames, binary files; withLineStats attaches them', () => {
  const out = ['3\t1\tsrc/a b.ts', '1\t0\t', 'old.ts', 'new.ts', '-\t-\tlogo.png', ''].join('\0');
  const stats = parseNumstatZ(out);
  assert.deepEqual([...stats], [['src/a b.ts', [3, 1]], ['new.ts', [1, 0]]]);
  assert.deepEqual(withLineStats([{ status: 'M', path: 'src/a b.ts' }, { status: 'A', path: 'logo.png' }], stats), [
    { status: 'M', path: 'src/a b.ts', added: 3, deleted: 1 },
    { status: 'A', path: 'logo.png' }
  ]);
});

test('parseGitmodulesPaths: paths in order, quoted, deduplicated, unsafe ones dropped', () => {
  const text = [
    '[submodule "libs/a"]',
    '\tpath = libs/a',
    '\turl = https://example.com/a.git',
    '[submodule "b"]',
    '  path="vendor/b dir/"',
    '[submodule "dup"]',
    'path = libs/a',
    '[submodule "evil"]',
    'path = ../outside',
    '[submodule "abs"]',
    'path = /etc'
  ].join('\n');
  assert.deepEqual(parseGitmodulesPaths(text), ['libs/a', 'vendor/b dir']);
});

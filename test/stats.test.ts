import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  STATS_LOG_FORMAT,
  compileExcludes,
  languageOf,
  languageTotals,
  mergeHistories,
  parseBlameIncremental,
  parseGrepCounts,
  parseStatsLog,
  summarize
} from '../src/model/stats';

const commit = (sha: string, at: number, iso: string, name: string, email: string, stats: string[]) =>
  `\x1e${[sha, at, iso, name, email].join('\x1f')}\0` + (stats.length ? '\n' + stats.join('\0') + '\0' : '');

test('STATS_LOG_FORMAT separates records and fields', () => {
  assert.ok(STATS_LOG_FORMAT.startsWith('%x1e'));
});

test('compileExcludes: file-name patterns match anywhere, path patterns from the root', () => {
  const ex = compileExcludes(['package-lock.json', '*.min.js', 'dist/**', 'docs/*.png']);
  assert.equal(ex('package-lock.json'), true);
  assert.equal(ex('web/package-lock.json'), true);
  assert.equal(ex('a/b/app.min.js'), true);
  assert.equal(ex('app.js'), false);
  assert.equal(ex('dist/x/y.js'), true);
  assert.equal(ex('src/dist/y.js'), false);
  assert.equal(ex('docs/a.png'), true);
  assert.equal(ex('docs/sub/a.png'), false);
});

test('parseStatsLog: authors by email, renames, exclusions, oldest first, local weekday/hour', () => {
  const out =
    commit('b'.repeat(40), 2000, '2026-10-17 23:10:00 -0500', 'Ann', 'ANN@x.io', ['5\t1\tsrc/a.ts', '2\t0\t', 'old.ts', 'new.ts', '900\t0\tpackage-lock.json', '-\t-\tlogo.png']) +
    commit('a'.repeat(40), 1000, '2026-10-12 09:00:00 +0200', 'Ann B', 'ann@x.io', ['10\t0\tsrc/a.ts']) +
    commit('c'.repeat(40), 500, '2026-10-11 09:00:00 +0000', 'Bob', 'bob@x.io', []);
  const h = parseStatsLog(out, compileExcludes(['package-lock.json']));
  assert.deepEqual(h.authors.map((a) => a.email), ['ANN@x.io', 'bob@x.io']);
  assert.deepEqual(h.commits.map((c) => c.time), [500, 1000, 2000]);
  const newest = h.commits[2];
  assert.equal(newest.author, 0);
  assert.equal(newest.added, 7);
  assert.equal(newest.deleted, 1);
  assert.deepEqual(newest.files.map(([f]) => h.files[f]), ['src/a.ts', 'new.ts']);
  // 2026-10-17 is a Saturday (weekday 5 when Monday = 0); 2026-10-12 a Monday.
  assert.deepEqual([newest.weekday, newest.hour], [5, 23]);
  assert.deepEqual([h.commits[1].weekday, h.commits[1].hour], [0, 9]);
  assert.equal(h.commits[0].files.length, 0);
});

test('summarize: range filter, running line total, authors, heatmap, churn', () => {
  const W = 7 * 86400;
  const t0 = Date.UTC(2026, 0, 5) / 1000; // a Monday
  const out =
    commit('3'.repeat(40), t0 + 2 * W + 100, '2026-01-19 10:00:00 +0000', 'Bob', 'bob@x', ['4\t4\ta.ts']) +
    commit('2'.repeat(40), t0 + W + 100, '2026-01-12 10:00:00 +0000', 'Ann', 'ann@x', ['20\t5\ta.ts', '3\t0\tb.ts']) +
    commit('1'.repeat(40), t0 + 100, '2026-01-05 10:00:00 +0000', 'Ann', 'ann@x', ['100\t0\ta.ts']);
  const h = parseStatsLog(out);
  const all = summarize(h, 0, t0 + 3 * W - 1);
  assert.equal(all.unit, 'week');
  assert.deepEqual(all.buckets.map((b) => [b.commits, b.lines]), [[1, 100], [1, 118], [1, 118]]);
  assert.equal(all.commits, 3);
  assert.deepEqual(all.authors.map((a) => [a.name, a.commits, a.added, a.deleted]), [['Ann', 2, 123, 5], ['Bob', 1, 4, 4]]);
  assert.equal(all.heatmap[0][10], 3);
  assert.deepEqual(all.churn.map((c) => [c.path, c.commits]), [['a.ts', 3], ['b.ts', 1]]);

  const recent = summarize(h, t0 + W, t0 + 3 * W - 1);
  assert.equal(recent.commits, 2);
  // Lines carry history from before the range.
  assert.deepEqual(recent.buckets.map((b) => [b.commits, b.lines]), [[1, 118], [1, 118]]);
  assert.equal(recent.authors.length, 2);
});

test('summarize: long spans bucket by month; empty history has no buckets', () => {
  const h = parseStatsLog(commit('1'.repeat(40), Date.UTC(2020, 0, 15) / 1000, '2020-01-15 10:00:00 +0000', 'A', 'a@x', ['1\t0\tx']));
  const s = summarize(h, 0, Date.UTC(2026, 0, 15) / 1000);
  assert.equal(s.unit, 'month');
  assert.equal(s.buckets.length, 73);
  assert.equal(s.buckets[0].start, Date.UTC(2020, 0, 1) / 1000);
  assert.equal(summarize(parseStatsLog(''), 0, 1000).buckets.length, 0);
});

test('parseGrepCounts and languageTotals', () => {
  const counts = parseGrepCounts('HEAD:src/a.ts\x0010\nHEAD:sp ace.md\x003\nHEAD:yarn.lock\x009999\nHEAD:Dockerfile\x002\n', compileExcludes(['yarn.lock']));
  assert.deepEqual(counts, [['src/a.ts', 10], ['sp ace.md', 3], ['Dockerfile', 2]]);
  assert.deepEqual(languageTotals(counts).map((l) => [l.language, l.lines]), [['TypeScript', 10], ['Markdown', 3], ['Dockerfile', 2]]);
  assert.equal(languageOf('Makefile'), 'Makefile');
  assert.equal(languageOf('.gitignore'), 'Other');
});

test('parseBlameIncremental: lines per author across repeated commits', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  const out = [`${a} 1 1 3`, 'author Ann', 'author-mail <Ann@x>', 'filename f', `${b} 4 4 2`, 'author Bob', 'author-mail <bob@x>', 'filename f', `${a} 6 6 1`, 'filename f', ''].join('\n');
  assert.deepEqual([...parseBlameIncremental(out)], [['ann@x', { name: 'Ann', lines: 4 }], ['bob@x', { name: 'Bob', lines: 2 }]]);
});

test('mergeHistories: authors merged by email, paths prefixed, sorted by time', () => {
  const h1 = parseStatsLog(commit('1'.repeat(40), 200, '2026-01-01 10:00:00 +0000', 'Ann', 'ann@x', ['1\t0\ta.ts']));
  const h2 = parseStatsLog(commit('2'.repeat(40), 100, '2026-01-01 09:00:00 +0000', 'Ann', 'ANN@x', ['2\t0\ta.ts']));
  const m = mergeHistories([{ name: 'one', history: h1 }, { name: 'two', history: h2 }]);
  assert.equal(m.authors.length, 1);
  assert.deepEqual(m.commits.map((c) => [c.time, m.files[c.files[0][0]]]), [[100, 'two/a.ts'], [200, 'one/a.ts']]);
});

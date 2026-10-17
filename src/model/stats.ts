/**
 * Repository statistics: parsing git output and aggregating it for the Stats tab.
 * Pure functions only (no vscode), so they are unit-tested directly.
 */
import { parseNumstatZ } from '../git/parse';

/** `git log -z --numstat` header: record separator, then hash, unix time, ISO author date, author name, email. */
export const STATS_LOG_FORMAT = '%x1e%H%x1f%at%x1f%ai%x1f%aN%x1f%aE';

export interface HistoryCommit {
  time: number;
  /** Author-local weekday (0 = Monday) and hour, for the activity heatmap. */
  weekday: number;
  hour: number;
  author: number;
  added: number;
  deleted: number;
  /** [file index, added, deleted] for each text file the commit touched (excluded files left out). */
  files: Array<[number, number, number]>;
}

export interface History {
  authors: { name: string; email: string }[];
  files: string[];
  /** Oldest first. */
  commits: HistoryCommit[];
}

export const DEFAULT_EXCLUDES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock',
  'composer.lock', 'Gemfile.lock', 'go.sum', 'packages.lock.json', '*.min.js', '*.min.css', '*.map', '*.snap',
  'node_modules/**', 'vendor/**', 'dist/**', 'build/**', 'out/**'
];

/**
 * Compiles exclude patterns: a pattern without "/" matches the file name anywhere ("*.min.js"),
 * one with "/" matches the path from the repository root ("dist/**"). Supports * ** and ?.
 */
export function compileExcludes(patterns: readonly string[]): (path: string) => boolean {
  const toRe = (glob: string, anchored: boolean) => {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*' && glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`, 'i');
  };
  const res = patterns.map((p) => p.trim()).filter(Boolean).map((p) => (p.includes('/') ? toRe(p.replace(/^\//, ''), true) : toRe(p, false)));
  return (path) => res.some((re) => re.test(path));
}

/** Weekday (0 = Monday) and hour from an ISO-like author date "2026-10-17 12:20:03 -0500" (author's local time). */
function localWeekdayHour(iso: string): [number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})/.exec(iso);
  if (!m) return [0, 0];
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return [(day + 6) % 7, Number(m[4])];
}

/** Parses `git log -z --numstat --format=STATS_LOG_FORMAT` (newest first) into a History (oldest first). */
export function parseStatsLog(out: string, isExcluded: (path: string) => boolean = () => false): History {
  const authors: History['authors'] = [];
  const authorIdx = new Map<string, number>();
  const files: string[] = [];
  const fileIdx = new Map<string, number>();
  const commits: HistoryCommit[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const nul = rec.indexOf('\0');
    const header = (nul >= 0 ? rec.slice(0, nul) : rec).split('\x1f');
    if (header.length < 5) continue;
    const [, at, iso, name, email] = header;
    const key = (email || name).toLowerCase();
    let a = authorIdx.get(key);
    if (a === undefined) {
      a = authors.length;
      authors.push({ name, email });
      authorIdx.set(key, a);
    }
    const [weekday, hour] = localWeekdayHour(iso);
    const c: HistoryCommit = { time: Number(at), weekday, hour, author: a, added: 0, deleted: 0, files: [] };
    if (nul >= 0) {
      for (const [path, [add, del]] of parseNumstatZ(rec.slice(nul + 1).replace(/^\n/, ''))) {
        if (isExcluded(path)) continue;
        let f = fileIdx.get(path);
        if (f === undefined) {
          f = files.length;
          files.push(path);
          fileIdx.set(path, f);
        }
        c.files.push([f, add, del]);
        c.added += add;
        c.deleted += del;
      }
    }
    commits.push(c);
  }
  commits.reverse();
  return { authors, files, commits };
}

/** Parses `git grep -I -c -z -e '' HEAD --` into [path, lines] (binary files are skipped by git). */
export function parseGrepCounts(out: string, isExcluded: (path: string) => boolean = () => false): Array<[string, number]> {
  const result: Array<[string, number]> = [];
  for (const line of out.split('\n')) {
    const nul = line.indexOf('\0');
    if (nul < 0) continue;
    const path = line.slice(0, nul).replace(/^[^:]*:/, '');
    if (!isExcluded(path)) result.push([path, Number(line.slice(nul + 1)) || 0]);
  }
  return result;
}

/** Parses `git blame --incremental` into surviving line counts per author email (lower-cased). */
export function parseBlameIncremental(out: string): Map<string, { name: string; lines: number }> {
  const bySha = new Map<string, { lines: number; name?: string; email?: string }>();
  let cur: { lines: number; name?: string; email?: string } | undefined;
  for (const line of out.split('\n')) {
    const head = /^([0-9a-f]{40,64}) \d+ \d+ (\d+)$/.exec(line);
    if (head) {
      cur = bySha.get(head[1]);
      if (!cur) bySha.set(head[1], (cur = { lines: 0 }));
      cur.lines += Number(head[2]);
    } else if (cur && line.startsWith('author ')) cur.name = line.slice(7);
    else if (cur && line.startsWith('author-mail ')) cur.email = line.slice(12).replace(/^<|>$/g, '');
  }
  const byAuthor = new Map<string, { name: string; lines: number }>();
  for (const s of bySha.values()) {
    const key = (s.email || s.name || 'unknown').toLowerCase();
    const a = byAuthor.get(key) ?? { name: s.name ?? key, lines: 0 };
    a.lines += s.lines;
    byAuthor.set(key, a);
  }
  return byAuthor;
}

const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', pyi: 'Python', ipynb: 'Jupyter', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy', gradle: 'Groovy',
  c: 'C', h: 'C/C++ header', hpp: 'C++', hh: 'C++', cc: 'C++', cpp: 'C++', cxx: 'C++', cs: 'C#', fs: 'F#', vb: 'Visual Basic',
  go: 'Go', rs: 'Rust', swift: 'Swift', m: 'Objective-C', mm: 'Objective-C', rb: 'Ruby', php: 'PHP', pl: 'Perl', lua: 'Lua', r: 'R', dart: 'Dart',
  ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell', clj: 'Clojure', zig: 'Zig', nim: 'Nim', jl: 'Julia', sol: 'Solidity',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell', ps1: 'PowerShell', psm1: 'PowerShell', bat: 'Batch', cmd: 'Batch',
  html: 'HTML', htm: 'HTML', vue: 'Vue', svelte: 'Svelte', css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less',
  json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', ini: 'INI', cfg: 'INI', conf: 'INI', env: 'INI',
  md: 'Markdown', mdx: 'Markdown', rst: 'reStructuredText', txt: 'Text', tex: 'TeX', sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protobuf',
  tf: 'Terraform', hcl: 'Terraform', svg: 'SVG', csv: 'CSV', cmake: 'CMake'
};
const NAME_LANG: Record<string, string> = { dockerfile: 'Dockerfile', makefile: 'Makefile', 'cmakelists.txt': 'CMake', jenkinsfile: 'Groovy', rakefile: 'Ruby', gemfile: 'Ruby' };

export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  if (name.startsWith('dockerfile')) return 'Dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'Other';
  return EXT_LANG[name.slice(dot + 1)] ?? 'Other';
}

export interface StatsBucket {
  /** Bucket start (unix seconds). */
  start: number;
  commits: number;
  /** Net lines from history at the end of the bucket (running total of added − deleted). */
  lines: number;
}

export interface StatsAuthor {
  key: string;
  name: string;
  email: string;
  commits: number;
  added: number;
  deleted: number;
  first: number;
  last: number;
}

export interface StatsSummary {
  commits: number;
  added: number;
  deleted: number;
  unit: 'week' | 'month';
  buckets: StatsBucket[];
  authors: StatsAuthor[];
  /** heatmap[weekday 0=Mon][hour] = commits. */
  heatmap: number[][];
  churn: Array<{ path: string; commits: number; added: number; deleted: number }>;
}

const DAY = 86400;

function weekStart(t: number): number {
  const d = new Date(t * 1000);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) / 1000;
}
function monthStart(t: number): number {
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}
function nextMonth(t: number): number {
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

/** Aggregates commits at or after `since` (0 = all time) up to `now`; line totals count all history before each bucket's end. */
export function summarize(h: History, since: number, now: number, churnLimit = 15): StatsSummary {
  const inRange = h.commits.filter((c) => c.time >= since && c.time <= now);
  const from = since || (h.commits[0]?.time ?? now);
  const unit = now - from > 2 * 365 * DAY ? 'month' : 'week';
  const buckets: StatsBucket[] = [];
  if (h.commits.length) {
    let t = unit === 'week' ? weekStart(from) : monthStart(from);
    while (t <= now) {
      buckets.push({ start: t, commits: 0, lines: 0 });
      t = unit === 'week' ? t + 7 * DAY : nextMonth(t);
    }
  }
  // Running net line total over all history, sampled at each bucket's end.
  let cum = 0;
  let ci = 0;
  for (let b = 0; b < buckets.length; b++) {
    const end = b + 1 < buckets.length ? buckets[b + 1].start : Infinity;
    while (ci < h.commits.length && h.commits[ci].time < end) {
      const c = h.commits[ci++];
      cum += c.added - c.deleted;
      if (c.time >= buckets[b].start && c.time >= since && c.time <= now) buckets[b].commits++;
    }
    buckets[b].lines = cum;
  }

  const authors = new Map<number, StatsAuthor>();
  const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const churn = new Map<number, { commits: number; added: number; deleted: number }>();
  let added = 0;
  let deleted = 0;
  for (const c of inRange) {
    added += c.added;
    deleted += c.deleted;
    heatmap[c.weekday][c.hour]++;
    const who = h.authors[c.author];
    const a = authors.get(c.author) ?? { key: (who.email || who.name).toLowerCase(), name: who.name, email: who.email, commits: 0, added: 0, deleted: 0, first: c.time, last: c.time };
    a.commits++;
    a.added += c.added;
    a.deleted += c.deleted;
    a.first = Math.min(a.first, c.time);
    a.last = Math.max(a.last, c.time);
    authors.set(c.author, a);
    for (const [f, add, del] of c.files) {
      const x = churn.get(f) ?? { commits: 0, added: 0, deleted: 0 };
      x.commits++;
      x.added += add;
      x.deleted += del;
      churn.set(f, x);
    }
  }
  return {
    commits: inRange.length,
    added,
    deleted,
    unit,
    buckets,
    authors: [...authors.values()].sort((x, y) => y.commits - x.commits),
    heatmap,
    churn: [...churn]
      .sort((x, y) => y[1].commits - x[1].commits || y[1].added + y[1].deleted - (x[1].added + x[1].deleted))
      .slice(0, churnLimit)
      .map(([f, x]) => ({ path: h.files[f], ...x }))
  };
}

/** Combines several repositories' histories (folder totals): authors merged by email, paths prefixed with the repo name. */
export function mergeHistories(parts: Array<{ name: string; history: History }>): History {
  const authors: History['authors'] = [];
  const authorIdx = new Map<string, number>();
  const files: string[] = [];
  const commits: HistoryCommit[] = [];
  for (const { name, history } of parts) {
    const amap = history.authors.map((a) => {
      const key = (a.email || a.name).toLowerCase();
      let i = authorIdx.get(key);
      if (i === undefined) {
        i = authors.length;
        authors.push(a);
        authorIdx.set(key, i);
      }
      return i;
    });
    const offset = files.length;
    files.push(...history.files.map((f) => `${name}/${f}`));
    for (const c of history.commits) commits.push({ ...c, author: amap[c.author], files: c.files.map(([f, a, d]) => [f + offset, a, d]) });
  }
  commits.sort((x, y) => x.time - y.time);
  return { authors, files, commits };
}

/** Lines of code by language, largest first. */
export function languageTotals(counts: Array<[string, number]>): Array<{ language: string; lines: number; files: number }> {
  const by = new Map<string, { lines: number; files: number }>();
  for (const [path, lines] of counts) {
    const l = languageOf(path);
    const x = by.get(l) ?? { lines: 0, files: 0 };
    x.lines += lines;
    x.files++;
    by.set(l, x);
  }
  return [...by].map(([language, x]) => ({ language, ...x })).sort((a, b) => b.lines - a.lines);
}

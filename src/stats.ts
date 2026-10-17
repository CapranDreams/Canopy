import * as vscode from 'vscode';
import { Repo } from './repo';
import { mapLimit } from './util/limit';
import {
  DEFAULT_EXCLUDES,
  History,
  STATS_LOG_FORMAT,
  compileExcludes,
  languageTotals,
  mergeHistories,
  parseBlameIncremental,
  parseGrepCounts,
  parseStatsLog,
  summarize
} from './model/stats';

export type StatsRange = '3m' | '1y' | 'all';

interface RepoData {
  key: string;
  history: History;
  truncated: boolean;
  /** [path, lines] for each text file at HEAD (exclusions applied). */
  counts: Array<[string, number]>;
}

export interface Ownership {
  done: number;
  total: number;
  /** Surviving lines per author email (lower-cased); complete once done === total. */
  authors: Record<string, { name: string; lines: number }>;
}

const RANGE_DAYS: Record<StatsRange, number> = { '3m': 91, '1y': 365, all: 0 };

function settings(): { maxCommits: number; excludes: string[] } {
  const c = vscode.workspace.getConfiguration('canopy.stats');
  const ex = c.get<unknown>('exclude');
  return {
    maxCommits: Math.max(100, c.get<number>('maxCommits', 20000)),
    excludes: Array.isArray(ex) ? ex.filter((p): p is string => typeof p === 'string') : DEFAULT_EXCLUDES
  };
}

/** Collects and caches repository statistics for the details panel's Stats tab. */
export class StatsService {
  private readonly data = new Map<string, Promise<RepoData>>();
  private readonly owners = new Map<string, Ownership>();
  private readonly blameRuns = new Map<string, Promise<void>>();

  private cacheKey(r: Repo): string {
    const s = settings();
    return JSON.stringify([r.root, r.status?.oid ?? '', s.maxCommits, s.excludes]);
  }

  private load(r: Repo): Promise<RepoData> {
    const key = this.cacheKey(r);
    let p = this.data.get(key);
    if (!p) {
      p = this.collect(r, key);
      p.catch(() => this.data.delete(key));
      this.data.set(key, p);
      // Keep the cache small: drop older entries for the same repo.
      for (const k of this.data.keys()) if (k !== key && JSON.parse(k)[0] === r.root) this.data.delete(k);
    }
    return p;
  }

  private async collect(r: Repo, key: string): Promise<RepoData> {
    if (!r.status?.oid) return { key, history: { authors: [], files: [], commits: [] }, truncated: false, counts: [] };
    const { maxCommits, excludes } = settings();
    const isExcluded = compileExcludes(excludes);
    const [log, grep] = await Promise.all([
      r.git(['log', '--no-merges', '-z', '--numstat', '-M', `-n${maxCommits}`, `--format=${STATS_LOG_FORMAT}`, 'HEAD', '--'], { readOnly: true, timeoutMs: 5 * 60_000 }),
      r.git(['grep', '-I', '-c', '-z', '-e', '', 'HEAD', '--'], { readOnly: true, timeoutMs: 2 * 60_000 }).catch(() => '')
    ]);
    const history = parseStatsLog(log, isExcluded);
    return { key, history, truncated: history.commits.length >= maxCommits, counts: parseGrepCounts(grep, isExcluded) };
  }

  /** Summary for one repo or several (folder totals) over a time range. */
  async summary(repos: Repo[], range: StatsRange): Promise<unknown> {
    const parts = await Promise.all(repos.map(async (r) => ({ repo: r, data: await this.load(r) })));
    const history = parts.length === 1 ? parts[0].data.history : mergeHistories(parts.map((p) => ({ name: p.repo.name, history: p.data.history })));
    const now = Math.floor(Date.now() / 1000);
    const since = RANGE_DAYS[range] ? now - RANGE_DAYS[range] * 86400 : 0;
    const s = summarize(history, since, now);
    const counts = parts.length === 1 ? parts[0].data.counts : parts.flatMap((p) => p.data.counts.map(([f, n]): [string, number] => [`${p.repo.name}/${f}`, n]));
    return {
      ...s,
      authorCount: s.authors.length,
      authors: s.authors.slice(0, 50),
      totalLines: counts.reduce((a, [, n]) => a + n, 0),
      totalFiles: counts.length,
      languages: languageTotals(counts),
      truncated: parts.some((p) => p.data.truncated),
      firstCommit: history.commits[0]?.time ?? 0,
      repos:
        parts.length > 1
          ? parts.map((p) => {
              const rs = summarize(p.data.history, since, now, 0);
              return { name: p.repo.name, commits: rs.commits, authors: rs.authors.length, lines: p.data.counts.reduce((a, [, n]) => a + n, 0), added: rs.added, deleted: rs.deleted };
            })
          : undefined
    };
  }

  /** Current ownership progress for a repo (undefined until requested). */
  ownership(r: Repo): Ownership | undefined {
    return this.owners.get(this.cacheKey(r));
  }

  /**
   * Counts surviving lines per author with `git blame` over every text file at HEAD, in the background.
   * `onProgress` fires every few files; `isWanted` stops the run when the panel moves on.
   */
  startOwnership(r: Repo, onProgress: (o: Ownership) => void, isWanted: () => boolean): void {
    const key = this.cacheKey(r);
    if (this.blameRuns.has(key)) return;
    const run = (async () => {
      const data = await this.load(r);
      const files = data.counts.filter(([, n]) => n > 0).map(([f]) => f);
      const own: Ownership = { done: 0, total: files.length, authors: {} };
      this.owners.set(key, own);
      onProgress(own);
      let lastPost = 0;
      // Lower than canopy.maxConcurrentGit so other git work keeps flowing while this runs.
      await mapLimit(files, 3, async (f) => {
        if (!isWanted()) return;
        try {
          const out = await r.git(['blame', '--incremental', '-w', 'HEAD', '--', f], { readOnly: true, timeoutMs: 60_000 });
          for (const [email, a] of parseBlameIncremental(out)) {
            const x = own.authors[email] ?? (own.authors[email] = { name: a.name, lines: 0 });
            x.lines += a.lines;
          }
        } catch {
          // Unreadable or vanished files are skipped.
        }
        own.done++;
        if (own.done === own.total || Date.now() - lastPost > 400) {
          lastPost = Date.now();
          onProgress(own);
        }
      });
      if (own.done < own.total) {
        // Stopped early: forget the partial result so it restarts next time.
        this.owners.delete(key);
      }
    })().finally(() => this.blameRuns.delete(key));
    this.blameRuns.set(key, run);
  }
}

/** Counts the git processes CANOPY starts, for "CANOPY: Show Git Activity" and the benchmarks. Pure, unit tested. */

export interface GitRun {
  at: number;
  /** Git subcommand ("status", "fetch", ...). */
  cmd: string;
  ms: number;
  /** Ran at normal priority because the user was waiting on it. */
  priority: boolean;
}

export interface ActivitySummary {
  since: number;
  processes: number;
  totalMs: number;
  byCommand: Array<{ cmd: string; count: number; totalMs: number; userCount: number }>;
}

const KEEP = 20_000;

export class GitActivity {
  private readonly runs: GitRun[] = [];
  private dropped = 0;
  readonly started: number;

  constructor(private readonly now: () => number = Date.now) {
    this.started = now();
  }

  record(args: readonly string[], ms: number, priority: boolean): void {
    this.runs.push({ at: this.now(), cmd: subcommand(args), ms, priority });
    if (this.runs.length > KEEP) {
      this.runs.splice(0, this.runs.length - KEEP);
      this.dropped++;
    }
  }

  /** Runs in the last `windowMs` (all kept runs when omitted). */
  summary(windowMs?: number): ActivitySummary {
    const since = windowMs === undefined ? this.started : this.now() - windowMs;
    const by = new Map<string, { cmd: string; count: number; totalMs: number; userCount: number }>();
    let processes = 0;
    let totalMs = 0;
    for (const r of this.runs) {
      if (r.at < since) continue;
      processes++;
      totalMs += r.ms;
      const e = by.get(r.cmd) ?? { cmd: r.cmd, count: 0, totalMs: 0, userCount: 0 };
      e.count++;
      e.totalMs += r.ms;
      if (r.priority) e.userCount++;
      by.set(r.cmd, e);
    }
    return { since, processes, totalMs, byCommand: [...by.values()].sort((a, b) => b.count - a.count || a.cmd.localeCompare(b.cmd)) };
  }

  reset(): void {
    this.runs.length = 0;
  }
}

/** First argument that is a git subcommand, skipping global options such as `-c key=value` and `-C dir`. */
export function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return args[0] ?? '';
}

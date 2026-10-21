/**
 * Runs fetches outside the status limiter, with three guarantees:
 * - manual and background fetches have their own pools, so neither starves status reads or user commands;
 * - per credential host, one fetch goes first while others wait, so a login prompt appears once and the
 *   rest reuse the stored credential (and an auth failure skips the rest instead of prompting again);
 * - dropped connections are retried silently with backoff.
 * No vscode imports; unit tested.
 */
import { Limiter } from '../util/limit';
import { FetchFailure, classifyFetchError, retryDelayMs } from './fetchErrors';

export type FetchMode = 'manual' | 'background';

export interface FetchOutcome {
  ok: boolean;
  failure?: FetchFailure;
  message?: string;
  /** Skipped without running because sign-in to `authHost` already failed in this batch. */
  skipped?: boolean;
  authHost?: string;
  attempts: number;
}

/** What `exec` throws; GitError satisfies it. A null exit code means git was killed (timeout), never retried. */
interface ExecError {
  message: string;
  stderr?: string;
  exitCode?: number | null;
}

export interface FetchTask {
  /** Hosts the fetch contacts (see credentialHosts). */
  hosts: readonly string[];
  mode: FetchMode;
  /** Batch start: auth failures recorded since then skip this task. Background tasks skip on any unresolved auth failure. */
  batchStart?: number;
  exec: () => Promise<unknown>;
}

const MAX_RETRIES = 2;
/** A host whose fetch succeeded this recently needs no gate (credentials are known to work). */
const VERIFIED_TTL_MS = 30 * 60_000;
/**
 * A first fetch that failed for a reason other than sign-in (host down, DNS, repo-specific error) opens the gate
 * this long, so the host's other repos run in parallel instead of taking turns.
 */
const PROVISIONAL_MS = 2 * 60_000;
const BACKGROUND_CONCURRENCY = 2;
const UNLIMITED = 1024;

export class FetchScheduler {
  private readonly manual: Limiter;
  private readonly background = new Limiter(BACKGROUND_CONCURRENCY);
  /** Host → time until which it needs no gate. */
  private readonly verifiedUntil = new Map<string, number>();
  private readonly authFailedAt = new Map<string, number>();
  private readonly gates = new Map<string, Promise<void>>();

  constructor(
    manualConcurrency: number,
    private readonly log: (line: string) => void = () => {},
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now
  ) {
    this.manual = new Limiter(toMax(manualConcurrency));
  }

  setManualConcurrency(n: number): void {
    this.manual.setMax(toMax(n));
  }

  async run(task: FetchTask): Promise<FetchOutcome> {
    const release = new Map<string, () => void>();
    const pass = await this.passGates(task, release);
    if ('blocked' in pass) return { ok: false, failure: 'auth', skipped: true, authHost: pass.blocked, attempts: 0 };
    const claimed = pass.claimed;
    let outcome: FetchOutcome | undefined;
    try {
      outcome = await this.runWithRetries(task);
      return outcome;
    } finally {
      const t = this.now();
      for (const h of task.hosts) {
        if (outcome?.ok) {
          this.verifiedUntil.set(h, t + VERIFIED_TTL_MS);
          this.authFailedAt.delete(h);
        } else if (outcome?.failure === 'auth' && (claimed.includes(h) || !this.isVerified(h))) {
          this.authFailedAt.set(h, t);
          this.verifiedUntil.delete(h);
        } else if (claimed.includes(h)) {
          this.verifiedUntil.set(h, Math.max(this.verifiedUntil.get(h) ?? 0, t + PROVISIONAL_MS));
        }
      }
      for (const h of claimed) {
        this.gates.delete(h);
        release.get(h)!();
      }
    }
  }

  private isVerified(host: string): boolean {
    return this.now() < (this.verifiedUntil.get(host) ?? 0);
  }

  private isAuthBlocked(host: string, task: FetchTask): boolean {
    const at = this.authFailedAt.get(host);
    if (at === undefined) return false;
    return task.mode === 'background' || (task.batchStart !== undefined && at >= task.batchStart);
  }

  /** Waits until every unverified host is either verified or unclaimed, then claims the unclaimed ones. */
  private async passGates(task: FetchTask, release: Map<string, () => void>): Promise<{ claimed: string[] } | { blocked: string }> {
    for (;;) {
      const pending = task.hosts.filter((h) => !this.isVerified(h));
      const blocked = pending.find((h) => this.isAuthBlocked(h, task));
      if (blocked) return { blocked };
      const waits = pending.map((h) => this.gates.get(h)).filter((g): g is Promise<void> => !!g);
      if (!waits.length) {
        // Claim in the same synchronous step as the check, so two tasks can never both claim a host.
        for (const h of pending) this.gates.set(h, new Promise<void>((r) => release.set(h, r)));
        return { claimed: pending };
      }
      await Promise.all(waits);
    }
  }

  private async runWithRetries(task: FetchTask): Promise<FetchOutcome> {
    const pool = task.mode === 'manual' ? this.manual : this.background;
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.run(task.exec);
        return { ok: true, attempts: attempt };
      } catch (e) {
        const err = e as ExecError;
        const failure: FetchFailure = err.exitCode === null ? 'other' : classifyFetchError(`${err.message}\n${err.stderr ?? ''}`);
        if (failure === 'transient' && attempt <= MAX_RETRIES) {
          const delay = retryDelayMs(attempt);
          this.log(`fetch dropped (${err.message}); retrying in ${Math.round(delay / 100) / 10} s (attempt ${attempt + 1} of ${MAX_RETRIES + 1})`);
          // Sleep outside the pool so the slot goes to another repo meanwhile.
          await this.sleep(delay);
          continue;
        }
        return { ok: false, failure, message: err.message, attempts: attempt };
      }
    }
  }
}

function toMax(n: number): number {
  return !Number.isFinite(n) || n <= 0 ? UNLIMITED : Math.floor(n);
}

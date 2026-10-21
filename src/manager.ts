import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitError, GitRunner } from './git/runner';
import { credentialHosts } from './git/fetchErrors';
import { parseGitmodulesPaths } from './git/parse';
import { FetchMode, FetchOutcome, FetchScheduler } from './git/fetchScheduler';
import { Repo } from './repo';
import { Store } from './store';
import { mapLimit } from './util/limit';
import { Log } from './log';
import { normalizeFsPath } from './util/fsPath';
import type { BuiltinGit } from './builtinGit';

/** Window focus re-reads status only when the last full refresh is older than this; Fetch All / Refresh are the explicit ways. */
const FOCUS_REFRESH_MS = 30 * 60_000;
/** Git-dir watcher events this soon after CANOPY's own fetch or command are its own writes, already refreshed. */
const SELF_WRITE_QUIET_MS = 1500;

function fetchAllConcurrency(): number {
  return vscode.workspace.getConfiguration('canopy').get<number>('fetchAllConcurrency', 12);
}

/** Discovers repositories, keeps their status fresh and runs fetches. */
export class RepoManager implements vscode.Disposable {
  private readonly repos = new Map<string, Repo>();
  private readonly watchers = new Map<string, vscode.Disposable[]>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly _onDidChange = new vscode.EventEmitter<Repo | undefined>();
  /** Fires with a repo when one repo changed, or undefined when the set of repos changed. */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeFetching = new vscode.EventEmitter<void>();
  readonly onDidChangeFetching = this._onDidChangeFetching.event;
  private readonly _onDidReachRemote = new vscode.EventEmitter<{ repo: Repo; reason: 'fetch' | 'push' }>();
  /** A fetch the user asked for, or a push, finished successfully; pipeline / MR status is worth re-reading. */
  readonly onDidReachRemote = this._onDidReachRemote.event;
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private fetchTimer: NodeJS.Timeout | undefined;
  private lastFetchAll = 0;
  private lastRefreshAll = Date.now();
  private readonly quietUntil = new Map<string, number>();
  private byRoot: Map<string, Repo> | undefined;
  private discovering: Promise<void> | undefined;
  private readonly fetcher: FetchScheduler;
  fetchingCount = 0;

  constructor(
    readonly runner: GitRunner,
    private readonly store: Store,
    private readonly log: Log,
    /** VS Code's built-in Git, read instead of running `git status` for the repositories it has open. */
    readonly builtin?: BuiltinGit
  ) {
    this.fetcher = new FetchScheduler(fetchAllConcurrency(), (line) => log.info(line));
    if (builtin) {
      this.disposables.push(
        // The built-in extension re-read a repository: take its result (no git process of our own).
        builtin.onDidChangeRepo((root) => {
          const repo = this.findByRoot(root);
          if (repo && !repo.lazy && repo.loaded && !repo.fetching) void this.refresh(repo);
        }),
        builtin.onDidChangeTracking(() => this.reconcileWatchers())
      );
    }
    this.disposables.push(
      this._onDidChange,
      this._onDidChangeFetching,
      this._onDidReachRemote,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.touchPath(doc.uri)),
      vscode.workspace.onDidCreateFiles((e) => e.files.forEach((f) => this.touchPath(f))),
      vscode.workspace.onDidDeleteFiles((e) => e.files.forEach((f) => this.touchPath(f))),
      vscode.workspace.onDidRenameFiles((e) => e.files.forEach((f) => this.touchPath(f.newUri))),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.onFocus();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('canopy.scanRoots') || e.affectsConfiguration('canopy.scanDepth') || e.affectsConfiguration('canopy.repositories') || e.affectsConfiguration('canopy.scanNested') || e.affectsConfiguration('canopy.scanExclude')) {
          void this.discover();
        }
        if (e.affectsConfiguration('canopy.autoFetch') || e.affectsConfiguration('canopy.refreshIntervalSeconds')) this.startTimers();
        if (e.affectsConfiguration('canopy.fetchAllConcurrency')) this.fetcher.setManualConcurrency(fetchAllConcurrency());
      })
    );
    this.startTimers();
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    this.pending.forEach((t) => clearTimeout(t));
    this.watchers.forEach((ws) => ws.forEach((w) => w.dispose()));
    this.disposables.forEach((d) => d.dispose());
  }

  get all(): Repo[] {
    return [...this.repos.values()];
  }

  get(key: string): Repo | undefined {
    return this.repos.get(key);
  }

  findByRoot(root: string): Repo | undefined {
    // The tree calls this for every row on every redraw (submodule parents), so keep an index.
    if (!this.byRoot) this.byRoot = new Map(this.all.map((r) => [normalizeFsPath(r.root), r]));
    return this.byRoot.get(normalizeFsPath(root));
  }

  /** The repo whose working tree contains `fsPath` (deepest match wins). */
  findContaining(fsPath: string): Repo | undefined {
    const norm = normalizeFsPath(fsPath);
    let best: Repo | undefined;
    for (const r of this.repos.values()) {
      // An unloaded submodule is not refreshed; its parent (which shows it as modified) is.
      if (r.lazy) continue;
      const root = normalizeFsPath(r.root);
      if ((norm === root || norm.startsWith(root + '/')) && (!best || root.length > normalizeFsPath(best.root).length)) best = r;
    }
    return best;
  }

  /** Re-keys repos after the workspace base folder changes. */
  rekey(): void {
    const entries = [...this.repos.values()];
    this.repos.clear();
    this.byRoot = undefined;
    for (const r of entries) {
      r.key = this.store.keyFor(r.root);
      this.repos.set(r.key, r);
    }
    this._onDidChange.fire(undefined);
  }

  discover(): Promise<void> {
    if (!this.discovering) {
      this.discovering = this.doDiscover().finally(() => {
        this.discovering = undefined;
      });
    }
    return this.discovering;
  }

  private async doDiscover(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('canopy');
    const setting = cfg.get<number>('scanDepth', 3);
    // -1 means no depth limit (still bounded by SCAN_FOLDER_BUDGET); otherwise 0–10.
    const depth = setting < 0 ? Infinity : Math.min(10, Math.floor(setting));
    const nested = cfg.get<boolean>('scanNested', false);
    const exclude = new Set(cfg.get<string[]>('scanExclude', []).map((s) => s.toLowerCase()));
    const roots = new Set<string>();
    for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') roots.add(f.uri.fsPath);
    for (const r of cfg.get<string[]>('scanRoots', [])) {
      const expanded = expandPath(r);
      if (expanded) roots.add(expanded);
    }
    const found = new Set<string>();
    const budget = { left: SCAN_FOLDER_BUDGET };
    for (const root of roots) await scanForRepos(root, depth, nested, exclude, found, budget);
    if (budget.left <= 0) {
      this.log.warn(`Discovery stopped after reading ${SCAN_FOLDER_BUDGET} folders. Lower canopy.scanDepth or add folder names to canopy.scanExclude.`);
      void vscode.window.showWarningMessage(`CANOPY stopped scanning after ${SCAN_FOLDER_BUDGET.toLocaleString()} folders. Some repositories may be missing.`, 'Open Settings').then((a) => a && vscode.commands.executeCommand('workbench.action.openSettings', 'canopy.scanDepth'));
    }
    for (const key of this.store.extraRepositories) {
      const root = this.store.rootFor(key);
      if (await isRepoRoot(root)) found.add(path.resolve(root));
    }
    // Containing repos of workspace folders opened below a repo root.
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file' || [...found].some((r) => isInside(f.uri.fsPath, r))) continue;
      const top = await this.runner.run(['rev-parse', '--show-toplevel'], { cwd: f.uri.fsPath, readOnly: true }).catch(() => '');
      if (top.trim()) found.add(path.resolve(top.trim()));
    }

    const byNorm = new Map([...found].map((r) => [normalizeFsPath(r), r]));
    // Submodules declared in a kept repo's .gitmodules stay, though scanning did not find them.
    const kept = (repo: Repo, depth = 0): boolean => {
      if (byNorm.has(normalizeFsPath(repo.root))) return true;
      const parent = repo.declaredBy ? this.repos.get(repo.declaredBy) : undefined;
      return !!parent && depth < 20 && kept(parent, depth + 1);
    };
    let changed = false;
    for (const [key, repo] of this.repos) {
      if (!kept(repo)) {
        this.repos.delete(key);
        this.byRoot = undefined;
        this.watchers.get(key)?.forEach((w) => w.dispose());
        this.watchers.delete(key);
        changed = true;
      }
    }
    const added: Repo[] = [];
    for (const root of byNorm.values()) {
      if (this.findByRoot(root)) continue;
      const repo = new Repo(root, this.store.keyFor(root), this.runner);
      this.repos.set(repo.key, repo);
      this.byRoot = undefined;
      added.push(repo);
      changed = true;
    }
    if (changed) this._onDidChange.fire(undefined);
    this.log.info(`Discovery: ${this.repos.size} repositories (${added.length} new) from ${roots.size} scan roots.`);
    // No waiting for VS Code's Git here: measured, its first reads arrive seconds later, and rows would sit empty
    // meanwhile. Repos it has already read are taken from it; the rest read their own status once.
    await mapLimit(added, 8, (repo) => this.refresh(repo));
  }

  /** Repos read from VS Code's Git need no watchers of ours (its change events replace them), and vice versa. */
  private reconcileWatchers(): void {
    for (const repo of this.repos.values()) {
      if (repo.lazy || !repo.gitDir) continue;
      if (this.builtin?.isTracked(repo.root)) {
        this.watchers.get(repo.key)?.forEach((w) => w.dispose());
        this.watchers.delete(repo.key);
      } else {
        this.watch(repo);
      }
    }
  }

  /** How many loaded repositories are read from VS Code's built-in Git right now. */
  builtinCount(): number {
    return this.builtin?.countTracked(this.all.filter((r) => !r.lazy && r.loaded).map((r) => r.root)) ?? 0;
  }

  /**
   * Registers the initialized submodules a repo's .gitmodules declares, as unloaded rows that cost nothing
   * until expanded, and drops ones no longer declared. Reads .gitmodules only when its mtime changes.
   */
  private async syncSubmodules(repo: Repo): Promise<void> {
    const file = path.join(repo.root, '.gitmodules');
    let time = 0;
    try {
      time = (await fs.promises.stat(file)).mtimeMs;
    } catch {
      // No .gitmodules: no submodules.
    }
    if (time === repo.gitmodulesTime) return;
    repo.gitmodulesTime = time;
    repo.submodulePaths = time ? parseGitmodulesPaths(await fs.promises.readFile(file, 'utf8').catch(() => '')) : [];
    const declared = new Set<string>();
    let changed = false;
    for (const rel of repo.submodulePaths) {
      const root = path.resolve(repo.root, rel);
      declared.add(normalizeFsPath(root));
      if (this.findByRoot(root) || !(await isRepoRoot(root))) continue; // already tracked, or not initialized
      const sub = new Repo(root, this.store.keyFor(root), this.runner);
      sub.declaredBy = repo.key;
      sub.superRoot = repo.root;
      sub.lazy = true;
      this.repos.set(sub.key, sub);
      this.byRoot = undefined;
      changed = true;
    }
    for (const [key, r] of this.repos) {
      if (r.declaredBy === repo.key && !declared.has(normalizeFsPath(r.root))) {
        this.repos.delete(key);
        this.byRoot = undefined;
        this.watchers.get(key)?.forEach((w) => w.dispose());
        this.watchers.delete(key);
        changed = true;
      }
    }
    if (changed) this._onDidChange.fire(undefined);
  }

  /** First read of an unloaded submodule (its parent was expanded): status, watchers, and its own submodules. */
  async ensureLoaded(repo: Repo): Promise<void> {
    if (!repo.lazy) return;
    repo.lazy = false;
    await this.refresh(repo, true);
    this._onDidChange.fire(repo);
  }

  async addRepositories(roots: string[]): Promise<Repo[]> {
    const valid: string[] = [];
    for (const r of roots) {
      const top = await this.runner.run(['rev-parse', '--show-toplevel'], { cwd: r, readOnly: true }).catch(() => '');
      if (top.trim()) valid.push(path.resolve(top.trim()));
    }
    if (!valid.length) return [];
    await this.store.addExtraRepositories(valid);
    await this.discover();
    return valid.map((v) => this.findByRoot(v)).filter((r): r is Repo => !!r);
  }

  private watch(repo: Repo): void {
    if (this.watchers.has(repo.key) || !repo.gitDir || this.builtin?.isTracked(repo.root)) return;
    const list: vscode.Disposable[] = [];
    const add = (dir: string, glob: string) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
      const fire = () => this.onGitDirChange(repo);
      list.push(w, w.onDidChange(fire), w.onDidCreate(fire), w.onDidDelete(fire));
    };
    // Top-level files only (no '/' in the glob, so no recursive watch over objects/); rebase dirs show up as created/deleted.
    add(repo.gitDir, '{HEAD,index,ORIG_HEAD,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,BISECT_LOG,rebase-merge,rebase-apply}');
    const common = repo.commonDir ?? repo.gitDir;
    add(common, 'packed-refs');
    // The only recursive watch, and it covers refs/ alone.
    add(path.join(common, 'refs'), '**');
    this.watchers.set(repo.key, list);
  }

  /** Git-dir change: ignored while CANOPY itself is writing (fetch, push, commit...), which refreshes on completion. */
  private onGitDirChange(repo: Repo): void {
    if (repo.fetching || repo.activity.length || Date.now() < (this.quietUntil.get(repo.key) ?? 0)) return;
    this.scheduleRefresh(repo);
  }

  /** Marks the repo's own write as done: drops queued watcher refreshes and ignores the trailing watcher events. */
  private settleSelfWrite(repo: Repo): void {
    const pending = this.pending.get(repo.key);
    if (pending) clearTimeout(pending);
    this.pending.delete(repo.key);
    this.quietUntil.set(repo.key, Date.now() + SELF_WRITE_QUIET_MS);
  }

  private touchPath(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    const repo = this.findContaining(uri.fsPath);
    // VS Code's Git re-reads the repositories it has open after a save and tells us (onDidChangeRepo).
    if (repo && !this.builtin?.isTracked(repo.root)) this.scheduleRefresh(repo);
  }

  scheduleRefresh(repo: Repo, delay = 400): void {
    const existing = this.pending.get(repo.key);
    if (existing) clearTimeout(existing);
    this.pending.set(
      repo.key,
      setTimeout(() => {
        this.pending.delete(repo.key);
        void this.refresh(repo);
      }, delay)
    );
  }

  /** Re-reads one repo. `priority` skips the status queue; use it when the user is waiting on the result. */
  async refresh(repo: Repo, priority = false): Promise<void> {
    if (repo.lazy) return;
    const wasLoaded = !!repo.gitDir;
    // Background refreshes take VS Code's Git result when it has one. A refresh the user is waiting on (right
    // after their own command) reads status itself, since VS Code's Git may not have caught up yet. Repos with
    // submodules read it themselves too: only porcelain v2 says whether a submodule's commit moved.
    const provided = priority || repo.submodulePaths.length ? undefined : this.builtin?.read(repo.root);
    if (await repo.refresh(priority, provided)) this._onDidChange.fire(repo);
    if (!wasLoaded) this.watch(repo);
    await this.syncSubmodules(repo);
  }

  async refreshAll(): Promise<void> {
    this.lastRefreshAll = Date.now();
    await mapLimit(
      this.all.filter((r) => !r.lazy),
      8,
      (r) => this.refresh(r)
    );
  }

  private startTimers(): void {
    const cfg = vscode.workspace.getConfiguration('canopy');
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    // Off by default: file watchers and saves keep status current; this is only a fallback for missed events.
    const seconds = cfg.get<number>('refreshIntervalSeconds', 0);
    if (seconds > 0) {
      this.pollTimer = setInterval(() => {
        if (vscode.window.state.focused && !this.fetchingCount) void this.refreshAll();
      }, Math.max(10, seconds) * 1000);
    }
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    this.fetchTimer = undefined;
    // Off by default, as in VS Code's own git.autofetch.
    const minutes = cfg.get<number>('autoFetch.intervalMinutes', 0);
    if (minutes > 0) {
      this.fetchTimer = setInterval(() => {
        if (vscode.window.state.focused) void this.fetchAll(this.visibleForAutoFetch(), { silent: true, mode: 'background' });
      }, minutes * 60_000);
    }
  }

  /** Set by the extension so auto-fetch skips hidden repos. */
  visibleForAutoFetch: () => Repo[] = () => this.all;

  private onFocus(): void {
    if (Date.now() - this.lastRefreshAll > FOCUS_REFRESH_MS) void this.refreshAll();
    const cfg = vscode.workspace.getConfiguration('canopy');
    const minutes = cfg.get<number>('autoFetch.intervalMinutes', 0);
    if (minutes > 0 && cfg.get<boolean>('autoFetch.onFocus', true) && Date.now() - this.lastFetchAll > minutes * 60_000) {
      void this.fetchAll(this.visibleForAutoFetch(), { silent: true, mode: 'background' });
    }
  }

  /** Marks a repo busy with `label` (e.g. "Pushing") until endActivity; the tree shows a spinner meanwhile. */
  beginActivity(repo: Repo, label: string): void {
    repo.activity.push(label);
    this._onDidChange.fire(repo);
  }

  endActivity(repo: Repo, label: string): void {
    const i = repo.activity.lastIndexOf(label);
    if (i >= 0) repo.activity.splice(i, 1);
    if (!repo.activity.length) this.settleSelfWrite(repo);
    this._onDidChange.fire(repo);
  }

  async fetch(repo: Repo, opts: { prune?: boolean; allRemotes?: boolean; silent?: boolean } = {}): Promise<boolean> {
    const outcome = await this.fetchOne(repo, { ...opts, mode: 'manual', batchStart: Date.now() });
    if (!outcome.ok && !opts.silent) {
      const msg = outcome.failure === 'auth' ? `sign-in failed${outcome.message ? ` (${outcome.message})` : ''}` : (outcome.message ?? 'unknown error');
      void vscode.window.showErrorMessage(`CANOPY: fetch failed in ${repo.name}: ${msg}`, 'Show Output').then((a) => a && this.log.show());
    }
    return outcome.ok;
  }

  private async fetchOne(repo: Repo, opts: { prune?: boolean; allRemotes?: boolean; mode: FetchMode; batchStart: number }): Promise<FetchOutcome> {
    if (repo.fetching || !repo.remotes.size) return { ok: true, attempts: 0 };
    const prune = opts.prune ?? vscode.workspace.getConfiguration('canopy').get<boolean>('fetchPrune', false);
    const all = opts.allRemotes || repo.remotes.size > 1;
    const args = ['fetch', ...(all ? ['--all'] : []), ...(prune ? ['--prune'] : [])];
    const urls = all ? [...repo.remotes.values()] : repo.primaryRemote ? [repo.primaryRemote.url] : [...repo.remotes.values()];
    const background = opts.mode === 'background';
    repo.fetching = true;
    repo.activity.push('Fetching');
    this.fetchingCount++;
    this._onDidChange.fire(repo);
    this._onDidChangeFetching.fire();
    let outcome: FetchOutcome = { ok: false, attempts: 0 };
    try {
      outcome = await this.fetcher.run({
        hosts: credentialHosts(urls),
        mode: opts.mode,
        batchStart: opts.batchStart,
        exec: () =>
          repo.git(args, {
            // The fetch pools do the limiting; the status queue stays free for reads.
            priority: true,
            background,
            timeoutMs: 5 * 60_000,
            // Background fetches must never pop a sign-in window; only a fetch the user asked for may.
            env: background ? { GCM_INTERACTIVE: 'never' } : undefined
          })
      });
      if (outcome.ok) {
        repo.lastFetch = Date.now();
        if (outcome.attempts > 1) this.log.info(`${repo.name}: fetch succeeded on attempt ${outcome.attempts}.`);
      } else if (outcome.skipped) {
        this.log.warn(`${repo.name}: fetch skipped; sign-in to ${outcome.authHost} failed earlier.`);
      } else {
        this.log.warn(`${repo.name}: fetch failed${outcome.attempts > 1 ? ` after ${outcome.attempts} attempts` : ''}: ${outcome.message}`);
      }
      return outcome;
    } catch (e) {
      const msg = e instanceof GitError ? e.message : String(e);
      this.log.warn(`${repo.name}: fetch failed: ${msg}`);
      return { ok: false, failure: 'other', message: msg, attempts: 1 };
    } finally {
      repo.fetching = false;
      const i = repo.activity.lastIndexOf('Fetching');
      if (i >= 0) repo.activity.splice(i, 1);
      this.fetchingCount--;
      this.settleSelfWrite(repo);
      await repo.refresh(true);
      // One change event per finished fetch (activity, status and lastFetch together).
      this._onDidChange.fire(repo);
      this._onDidChangeFetching.fire();
      if (outcome.ok && opts.mode === 'manual') this._onDidReachRemote.fire({ repo, reason: 'fetch' });
    }
  }

  /** Called after a successful push (also from sync and publish). */
  notifyPushed(repo: Repo): void {
    this._onDidReachRemote.fire({ repo, reason: 'push' });
  }

  /**
   * Fetches many repos: `manual` (default) runs canopy.fetchAllConcurrency at a time; `background` runs two at a
   * time at low CPU priority. Dropped connections retry silently; sign-in failures are reported once per host.
   */
  async fetchAll(repos: Repo[], opts: { prune?: boolean; silent?: boolean; mode?: FetchMode } = {}): Promise<{ ok: number; failed: Repo[] }> {
    const batchStart = Date.now();
    this.lastFetchAll = batchStart;
    const mode = opts.mode ?? 'manual';
    const results = await Promise.all(repos.map(async (r) => ({ repo: r, outcome: await this.fetchOne(r, { prune: opts.prune, mode, batchStart }) })));
    const failed = results.filter((x) => !x.outcome.ok);
    if (failed.length && !opts.silent) {
      const authByHost = new Map<string, Repo[]>();
      const other: Repo[] = [];
      for (const { repo, outcome } of failed) {
        const host = outcome.failure === 'auth' ? (outcome.authHost ?? credentialHosts(repo.remotes.values())[0]) : undefined;
        if (host) authByHost.set(host, [...(authByHost.get(host) ?? []), repo]);
        else other.push(repo);
      }
      const parts = [
        ...[...authByHost].map(([host, rs]) => `sign-in to ${host} failed (${rs.length} ${rs.length === 1 ? 'repository' : 'repositories'} not fetched)`),
        ...(other.length ? [`fetch failed in ${other.map((r) => r.name).join(', ')}`] : [])
      ];
      void vscode.window.showWarningMessage(`CANOPY: ${parts.join('; ')}.`, 'Show Output').then((a) => a && this.log.show());
    }
    return { ok: repos.length - failed.length, failed: failed.map((x) => x.repo) };
  }
}

export { normalizeFsPath };

function isInside(child: string, parent: string): boolean {
  const c = normalizeFsPath(child);
  const p = normalizeFsPath(parent);
  return c === p || c.startsWith(p + '/');
}

export function expandPath(p: string): string | undefined {
  let s = p.trim();
  if (!s) return undefined;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  s = s.replace(/\$\{workspaceFolder\}/g, folder ?? '').replace(/\$\{userHome\}/g, os.homedir());
  const wf = vscode.workspace.workspaceFile;
  if (!path.isAbsolute(s)) {
    const base = wf?.scheme === 'file' ? path.dirname(wf.fsPath) : folder;
    if (!base) return undefined;
    s = path.join(base, s);
  }
  return path.resolve(s);
}

async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    await fs.promises.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Upper bound on folders read per discovery, so an unlimited depth can't crawl a whole drive. */
export const SCAN_FOLDER_BUDGET = 50_000;

async function scanForRepos(dir: string, depth: number, nested: boolean, exclude: Set<string>, found: Set<string>, budget: { left: number }): Promise<void> {
  if (budget.left-- <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const isRepo = entries.some((e) => e.name === '.git');
  if (isRepo) {
    found.add(path.resolve(dir));
    if (!nested) return;
  }
  if (depth <= 0) return;
  // Symlinks and junctions are not followed (isDirectory() is false for them), so loops are impossible.
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !exclude.has(e.name.toLowerCase()))
      .map((e) => scanForRepos(path.join(dir, e.name), depth - 1, nested, exclude, found, budget))
  );
}

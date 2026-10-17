import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitError, GitRunner } from './git/runner';
import { Repo } from './repo';
import { Store } from './store';
import { mapLimit } from './util/limit';
import { Log } from './log';

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
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private fetchTimer: NodeJS.Timeout | undefined;
  private lastFetchAll = 0;
  private discovering: Promise<void> | undefined;
  fetchingCount = 0;

  constructor(
    readonly runner: GitRunner,
    private readonly store: Store,
    private readonly log: Log
  ) {
    this.disposables.push(
      this._onDidChange,
      this._onDidChangeFetching,
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
    const norm = normalizeFsPath(root);
    return this.all.find((r) => normalizeFsPath(r.root) === norm);
  }

  /** The repo whose working tree contains `fsPath` (deepest match wins). */
  findContaining(fsPath: string): Repo | undefined {
    const norm = normalizeFsPath(fsPath);
    let best: Repo | undefined;
    for (const r of this.repos.values()) {
      const root = normalizeFsPath(r.root);
      if ((norm === root || norm.startsWith(root + '/')) && (!best || root.length > normalizeFsPath(best.root).length)) best = r;
    }
    return best;
  }

  /** Re-keys repos after the workspace base folder changes. */
  rekey(): void {
    const entries = [...this.repos.values()];
    this.repos.clear();
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
    let changed = false;
    for (const [key, repo] of this.repos) {
      if (!byNorm.has(normalizeFsPath(repo.root))) {
        this.repos.delete(key);
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
      added.push(repo);
      changed = true;
    }
    if (changed) this._onDidChange.fire(undefined);
    this.log.info(`Discovery: ${this.repos.size} repositories (${added.length} new) from ${roots.size} scan roots.`);
    await mapLimit(added, 8, async (repo) => {
      await repo.refresh();
      this.watch(repo);
      this._onDidChange.fire(repo);
    });
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
    if (this.watchers.has(repo.key) || !repo.gitDir) return;
    const list: vscode.Disposable[] = [];
    const add = (dir: string, glob: string) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
      const fire = () => this.scheduleRefresh(repo);
      list.push(w, w.onDidChange(fire), w.onDidCreate(fire), w.onDidDelete(fire));
    };
    add(repo.gitDir, '{HEAD,index,ORIG_HEAD,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,FETCH_HEAD,rebase-merge/*,rebase-apply/*}');
    add(repo.commonDir ?? repo.gitDir, '{packed-refs,refs/**}');
    this.watchers.set(repo.key, list);
  }

  private touchPath(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    const repo = this.findContaining(uri.fsPath);
    if (repo) this.scheduleRefresh(repo);
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

  async refresh(repo: Repo): Promise<void> {
    const wasLoaded = !!repo.gitDir;
    if (await repo.refresh()) this._onDidChange.fire(repo);
    if (!wasLoaded) this.watch(repo);
  }

  async refreshAll(): Promise<void> {
    await mapLimit(this.all, 8, (r) => this.refresh(r));
  }

  private startTimers(): void {
    const cfg = vscode.workspace.getConfiguration('canopy');
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (vscode.window.state.focused) void this.refreshAll();
    }, Math.max(10, cfg.get<number>('refreshIntervalSeconds', 60)) * 1000);
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    const minutes = cfg.get<number>('autoFetch.intervalMinutes', 5);
    if (minutes > 0) {
      this.fetchTimer = setInterval(() => {
        if (vscode.window.state.focused) void this.fetchAll(this.visibleForAutoFetch(), { silent: true });
      }, minutes * 60_000);
    }
  }

  /** Set by the extension so auto-fetch skips hidden repos. */
  visibleForAutoFetch: () => Repo[] = () => this.all;

  private onFocus(): void {
    void this.refreshAll();
    const cfg = vscode.workspace.getConfiguration('canopy');
    const minutes = cfg.get<number>('autoFetch.intervalMinutes', 5);
    if (minutes > 0 && cfg.get<boolean>('autoFetch.onFocus', true) && Date.now() - this.lastFetchAll > minutes * 60_000) {
      void this.fetchAll(this.visibleForAutoFetch(), { silent: true });
    }
  }

  async fetch(repo: Repo, opts: { prune?: boolean; allRemotes?: boolean; silent?: boolean } = {}): Promise<boolean> {
    if (repo.fetching || !repo.remotes.size) return true;
    const prune = opts.prune ?? vscode.workspace.getConfiguration('canopy').get<boolean>('fetchPrune', false);
    const args = ['fetch', ...(opts.allRemotes || repo.remotes.size > 1 ? ['--all'] : []), ...(prune ? ['--prune'] : [])];
    repo.fetching = true;
    this.fetchingCount++;
    this._onDidChange.fire(repo);
    this._onDidChangeFetching.fire();
    try {
      await repo.git(args, { timeoutMs: 5 * 60_000 });
      repo.lastFetch = Date.now();
      return true;
    } catch (e) {
      const msg = e instanceof GitError ? e.message : String(e);
      this.log.warn(`${repo.name}: fetch failed: ${msg}`);
      if (!opts.silent) void vscode.window.showErrorMessage(`CANOPY: fetch failed in ${repo.name}: ${msg}`, 'Show Output').then((a) => a && this.log.show());
      return false;
    } finally {
      repo.fetching = false;
      this.fetchingCount--;
      this._onDidChangeFetching.fire();
      await this.refresh(repo);
      this._onDidChange.fire(repo);
    }
  }

  async fetchAll(repos: Repo[], opts: { prune?: boolean; silent?: boolean } = {}): Promise<{ ok: number; failed: Repo[] }> {
    this.lastFetchAll = Date.now();
    const results = await Promise.all(repos.map(async (r) => ((await this.fetch(r, { ...opts, silent: true })) ? null : r)));
    const failed = results.filter((r): r is Repo => !!r);
    if (failed.length && !opts.silent) {
      void vscode.window
        .showWarningMessage(`CANOPY: fetch failed in ${failed.map((r) => r.name).join(', ')}.`, 'Show Output')
        .then((a) => a && this.log.show());
    }
    return { ok: repos.length - failed.length, failed };
  }
}

export function normalizeFsPath(p: string): string {
  const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

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

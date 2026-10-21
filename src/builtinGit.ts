import * as vscode from 'vscode';
import { ApiRepoState, remotesFromApi, statusFromApi } from './git/apiStatus';
import { StatusInfo } from './git/parse';
import { Log } from './log';
import { normalizeFsPath } from './util/fsPath';

/** The slice of VS Code's built-in Git extension API (version 1) CANOPY reads. */
interface ApiRepository {
  readonly rootUri: vscode.Uri;
  readonly state: ApiRepoState & { readonly onDidChange: vscode.Event<void> };
}
interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: readonly ApiRepository[];
  readonly onDidOpenRepository: vscode.Event<ApiRepository>;
  readonly onDidCloseRepository: vscode.Event<ApiRepository>;
}

/**
 * Reads repository state from VS Code's built-in Git extension for the repositories it already has open, so
 * CANOPY does not run a second `git status` for them (the built-in extension refreshes them on every file
 * change anyway). It never asks that extension to open a repository: that would add work, not save it.
 */
export class BuiltinGit implements vscode.Disposable {
  private api: GitApi | undefined;
  private readonly repos = new Map<string, { repo: ApiRepository; sub: vscode.Disposable }>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChangeRepo = new vscode.EventEmitter<string>();
  /** A tracked repository's state changed (normalized root). */
  readonly onDidChangeRepo = this._onDidChangeRepo.event;
  private readonly _onDidChangeTracking = new vscode.EventEmitter<void>();
  /** The built-in extension opened or closed a repository, or the integration was turned on or off. */
  readonly onDidChangeTracking = this._onDidChangeTracking.event;
  /** Settles once connected (or once it is clear there is nothing to connect to). */
  readonly ready: Promise<void>;

  constructor(private readonly log: Log) {
    this.disposables.push(
      this._onDidChangeRepo,
      this._onDidChangeTracking,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (['canopy.useBuiltinGit', 'git.enabled', 'git.autorefresh', 'git.untrackedChanges', 'git.statusLimit'].some((k) => e.affectsConfiguration(k))) {
          if (this.enabled && !this.api) void this.connect();
          this._onDidChangeTracking.fire();
        }
      })
    );
    this.ready = this.enabled ? this.connect() : Promise.resolve();
  }

  dispose(): void {
    this.repos.forEach((r) => r.sub.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  /** On unless turned off here or there, or the built-in state could be stale or incomplete. */
  get enabled(): boolean {
    const own = vscode.workspace.getConfiguration('canopy').get<boolean>('useBuiltinGit', false);
    const git = vscode.workspace.getConfiguration('git');
    return own && git.get<boolean>('enabled', true) !== false && git.get<boolean>('autorefresh', true) !== false && git.get<string>('untrackedChanges', 'mixed') !== 'hidden';
  }

  private async connect(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
      if (!ext) return;
      const exports = ext.isActive ? ext.exports : await ext.activate();
      const api = exports?.getAPI(1);
      if (!api || this.api) return;
      this.api = api;
      if (api.state !== 'initialized') {
        await new Promise<void>((resolve) => {
          const d = api.onDidChangeState((s) => {
            if (s === 'initialized') {
              d.dispose();
              resolve();
            }
          });
          setTimeout(resolve, 10_000);
        });
      }
      api.repositories.forEach((r) => this.track(r));
      this.disposables.push(
        api.onDidOpenRepository((r) => {
          this.track(r);
          this._onDidChangeTracking.fire();
        }),
        api.onDidCloseRepository((r) => {
          const key = normalizeFsPath(r.rootUri.fsPath);
          this.repos.get(key)?.sub.dispose();
          this.repos.delete(key);
          this._onDidChangeTracking.fire();
        })
      );
      this.log.info(`VS Code Git integration: ${this.repos.size} repositories open there.`);
      this._onDidChangeTracking.fire();
    } catch (e) {
      this.log.warn(`VS Code Git integration unavailable: ${(e as Error).message}`);
    }
  }

  private track(repo: ApiRepository): void {
    if (repo.rootUri.scheme !== 'file') return;
    const key = normalizeFsPath(repo.rootUri.fsPath);
    this.repos.get(key)?.sub.dispose();
    const sub = repo.state.onDidChange(() => this._onDidChangeRepo.fire(key));
    this.repos.set(key, { repo, sub });
  }

  /** True when the built-in extension has this repository open (and the integration is on). */
  isTracked(root: string): boolean {
    return this.enabled && this.repos.has(normalizeFsPath(root));
  }

  /** Status and remotes from the built-in extension, or undefined when they cannot stand in for `git status`. */
  read(root: string): { status: StatusInfo; remotes: Map<string, string> } | undefined {
    if (!this.enabled) return undefined;
    const entry = this.repos.get(normalizeFsPath(root));
    if (!entry) return undefined;
    const limit = vscode.workspace.getConfiguration('git').get<number>('statusLimit', 10_000);
    const status = statusFromApi(entry.repo.rootUri.fsPath, entry.repo.state, limit);
    return status ? { status, remotes: remotesFromApi(entry.repo.state) } : undefined;
  }

  /** Number of the given roots read from the built-in extension right now. */
  countTracked(roots: readonly string[]): number {
    return roots.filter((r) => this.isTracked(r)).length;
  }
}


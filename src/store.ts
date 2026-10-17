import * as path from 'node:path';
import * as vscode from 'vscode';
import { Layout, normalizeLayout } from './model/layout';
import { Profile, parseProfile, toProfileFile } from './model/profile';
import { Attention, SortMode } from './model/types';

const LAYOUT_KEY = 'canopy.layout';
const PROFILES_KEY = 'canopy.profiles';

/**
 * Persists the layout, profiles and extra repositories. With a workspace open they live in workspace
 * settings (the .code-workspace file or .vscode/settings.json); otherwise in global state.
 */
export class Store implements vscode.Disposable {
  private readonly _onDidChangeLayout = new vscode.EventEmitter<void>();
  readonly onDidChangeLayout = this._onDidChangeLayout.event;
  private readonly _onDidChangeProfiles = new vscode.EventEmitter<void>();
  readonly onDidChangeProfiles = this._onDidChangeProfiles.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(LAYOUT_KEY)) this._onDidChangeLayout.fire();
        if (e.affectsConfiguration(PROFILES_KEY)) this._onDidChangeProfiles.fire();
      }),
      this._onDidChangeLayout,
      this._onDidChangeProfiles
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  get hasWorkspace(): boolean {
    return !!vscode.workspace.workspaceFile || !!vscode.workspace.workspaceFolders?.length;
  }

  /** Folder that relative repo keys are resolved against. */
  get baseDir(): string | undefined {
    const wf = vscode.workspace.workspaceFile;
    if (wf && wf.scheme === 'file') return path.dirname(wf.fsPath);
    const first = vscode.workspace.workspaceFolders?.[0];
    return first?.uri.scheme === 'file' ? first.uri.fsPath : undefined;
  }

  keyFor(root: string): string {
    const abs = path.resolve(root);
    const base = this.baseDir;
    if (base) {
      const rel = path.relative(base, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
      if (!rel) return '.';
    }
    return abs.split(path.sep).join('/');
  }

  rootFor(key: string): string {
    if (key === '.') return this.baseDir ?? key;
    if (path.isAbsolute(key) || /^[a-zA-Z]:\//.test(key)) return path.normalize(key);
    return path.normalize(path.join(this.baseDir ?? '', key));
  }

  // --- layout -------------------------------------------------------------

  get layout(): Layout {
    const raw = this.hasWorkspace ? vscode.workspace.getConfiguration().get(LAYOUT_KEY) : this.ctx.globalState.get(LAYOUT_KEY);
    return normalizeLayout(raw);
  }

  async setLayout(layout: Layout): Promise<void> {
    if (this.hasWorkspace) {
      await vscode.workspace.getConfiguration().update(LAYOUT_KEY, layout, vscode.ConfigurationTarget.Workspace);
    } else {
      await this.ctx.globalState.update(LAYOUT_KEY, layout);
      this._onDidChangeLayout.fire();
    }
  }

  // --- profiles -----------------------------------------------------------

  get profiles(): Profile[] {
    const raw = (this.hasWorkspace ? vscode.workspace.getConfiguration().get<unknown[]>(PROFILES_KEY) : this.ctx.globalState.get<unknown[]>(PROFILES_KEY)) ?? [];
    const list: Profile[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      try {
        const id = item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : undefined;
        list.push(parseProfile(item, id));
      } catch {
        // Skip entries a user broke by hand; the settings editor shows the raw JSON.
      }
    }
    return list;
  }

  async setProfiles(profiles: Profile[]): Promise<void> {
    const raw = profiles.map((p) => ({ id: p.id, savedAt: p.savedAt, ...toProfileFile(p) }));
    if (this.hasWorkspace) {
      await vscode.workspace.getConfiguration().update(PROFILES_KEY, raw, vscode.ConfigurationTarget.Workspace);
    } else {
      await this.ctx.globalState.update(PROFILES_KEY, raw);
      this._onDidChangeProfiles.fire();
    }
  }

  get activeProfileId(): string | undefined {
    return this.ctx.workspaceState.get('canopy.activeProfile');
  }

  get activeProfileName(): string | undefined {
    return this.ctx.workspaceState.get('canopy.activeProfileName');
  }

  async setActiveProfileId(id: string | undefined, name?: string): Promise<void> {
    await this.ctx.workspaceState.update('canopy.activeProfile', id);
    await this.ctx.workspaceState.update('canopy.activeProfileName', id ? name : undefined);
    this._onDidChangeProfiles.fire();
  }

  /** Lets other parts (e.g. a profile file watcher) ask the profile views to refresh. */
  notifyProfilesChanged(): void {
    this._onDidChangeProfiles.fire();
  }

  // --- extra repositories ---------------------------------------------------

  get extraRepositories(): string[] {
    return vscode.workspace.getConfiguration('canopy').get<string[]>('repositories') ?? [];
  }

  async addExtraRepositories(roots: string[]): Promise<void> {
    const current = this.extraRepositories;
    const keys = roots.map((r) => this.keyFor(r)).filter((k) => !current.includes(k));
    if (!keys.length) return;
    const target = this.hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('canopy').update('repositories', [...current, ...keys], target);
  }
}

/** Per-workspace view preferences that are not worth sharing in the workspace file. */
export class ViewState {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  editMode = false;

  constructor(private readonly memento: vscode.Memento) {}

  get sort(): SortMode {
    return this.memento.get<SortMode>('canopy.sort', 'attention');
  }
  get groupBy(): 'folders' | 'status' {
    return this.memento.get<'folders' | 'status'>('canopy.groupBy', 'folders');
  }
  get filters(): Attention[] {
    return this.memento.get<Attention[]>('canopy.filters', []);
  }
  get hideClean(): boolean {
    return this.memento.get<boolean>('canopy.hideClean', false);
  }
  get textFilter(): string {
    return this.memento.get<string>('canopy.textFilter', '');
  }
  get collapsed(): string[] {
    return this.memento.get<string[]>('canopy.collapsed', []);
  }
  get isFiltered(): boolean {
    return this.filters.length > 0 || this.hideClean || this.textFilter.trim().length > 0;
  }

  async set(patch: Partial<{ sort: SortMode; groupBy: 'folders' | 'status'; filters: Attention[]; hideClean: boolean; textFilter: string }>): Promise<void> {
    for (const [k, v] of Object.entries(patch)) await this.memento.update('canopy.' + k, v);
    this._onDidChange.fire();
  }

  async setCollapsed(id: string, collapsed: boolean): Promise<void> {
    const set = new Set(this.collapsed);
    if (collapsed) set.add(id);
    else set.delete(id);
    await this.memento.update('canopy.collapsed', [...set]);
  }

  setEditMode(on: boolean): void {
    this.editMode = on;
    void vscode.commands.executeCommand('setContext', 'canopy.editMode', on);
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

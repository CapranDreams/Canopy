import * as path from 'node:path';
import * as vscode from 'vscode';
import { Layout, LayoutFolder, folderOfRepo, folderPath, moveFolder, moveRepos, setHidden, walkFolders } from './model/layout';
import { compileQuery, Predicate } from './model/query';
import { ATTENTION_LABEL, ATTENTION_ORDER, Attention, RepoFacts, attentionOf, compareRepos, needsAttention } from './model/types';
import { RepoManager } from './manager';
import { Repo } from './repo';
import { Store, ViewState } from './store';
import type { ForgeHub } from './forge/hub';
import { FORGE_WORDS } from './forge/types';
import { pipelineSymbol } from './forge/instances';

export type FolderNode = { kind: 'folder'; folder: LayoutFolder; parentId: string | null };
export type UnsortedNode = { kind: 'unsorted' };
export type GroupNode = { kind: 'group'; attention: Attention };
export type RepoNode = { kind: 'repo'; repo: Repo; parent: string };
export type Node = FolderNode | UnsortedNode | GroupNode | RepoNode;

const UNSORTED_ID = '__unsorted';
/** Scheme of repo rows' resourceUri, so only CANOPY's decorations (not Git's or Problems') apply to them. */
const REPO_SCHEME = 'canopy-repo';
const MIME = 'application/vnd.code.tree.canopy.repos';

const ATTENTION_ICON: Record<Attention, [string, string | undefined]> = {
  conflict: ['warning', 'gitDecoration.conflictingResourceForeground'],
  error: ['error', 'errorForeground'],
  diverged: ['repo-forked', 'charts.purple'],
  behind: ['repo-pull', 'canopy.behindForeground'],
  changes: ['repo', 'canopy.changesForeground'],
  ahead: ['repo-push', 'canopy.aheadForeground'],
  unpublished: ['repo', 'descriptionForeground'],
  clean: ['repo', undefined]
};

export function badgeText(r: RepoFacts): string {
  const parts: string[] = [];
  if (r.operation) parts.push(operationLabel(r.operation));
  if (r.conflicts) parts.push(`⚠${r.conflicts}`);
  if (r.behind) parts.push(`↓${r.behind}`);
  if (r.changed) parts.push(`●${r.changed}`);
  if (r.ahead) parts.push(`↑${r.ahead}`);
  return parts.join(' ');
}

/** A count squeezed into a two-character tree badge. */
const badgeCount = (sym: string, n: number) => sym + (n > 9 ? '+' : String(n));

/**
 * The single highest-priority state shown as a row's badge (and name color):
 * failed pipeline, then commits to push, commits to pull, uncommitted changes.
 */
export function priorityDecoration(r: RepoFacts): { badge: string; color: string; tooltip: string } | undefined {
  if (r.ci === 'failed') return { badge: '✕', color: 'canopy.pipelineFailedForeground', tooltip: 'Pipeline failed' };
  if (r.ahead) return { badge: badgeCount('↑', r.ahead), color: 'canopy.aheadForeground', tooltip: `${r.ahead} to push` };
  if (r.behind) return { badge: badgeCount('↓', r.behind), color: 'canopy.behindForeground', tooltip: `${r.behind} to pull` };
  if (r.changed) return { badge: badgeCount('●', r.changed), color: 'canopy.changesForeground', tooltip: `${r.changed} changed` };
  if (r.submoduleMoved) return { badge: '≠', color: 'canopy.changesForeground', tooltip: 'Checked out at a different commit than the parent repository records' };
  return undefined;
}

export function operationLabel(op: string): string {
  return { rebase: 'rebasing', merge: 'merging', 'cherry-pick': 'cherry-picking', revert: 'reverting', bisect: 'bisecting' }[op] ?? op;
}

export class RepoTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.FileDecorationProvider, vscode.Disposable {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  readonly view: vscode.TreeView<Node>;
  private readonly disposables: vscode.Disposable[] = [];
  private layout: Layout;
  private filterPredicate: Predicate | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private forgeService: ForgeHub | undefined;
  /** Submodules by parent repo key; rebuilt after every refresh. */
  private childMap: Map<string, Repo[]> | undefined;

  constructor(
    private readonly manager: RepoManager,
    private readonly store: Store,
    private readonly state: ViewState
  ) {
    this.layout = store.layout;
    this.view = vscode.window.createTreeView('canopy.repos', {
      treeDataProvider: this,
      dragAndDropController: this,
      canSelectMany: true,
      showCollapseAll: true
    });
    this.compileFilter();
    this.disposables.push(
      this.view,
      this._onDidChangeTreeData,
      this._onDidChangeFileDecorations,
      vscode.window.registerFileDecorationProvider(this),
      manager.onDidChange(() => this.scheduleRefresh()),
      store.onDidChangeLayout(() => {
        this.layout = store.layout;
        this.scheduleRefresh();
      }),
      state.onDidChange(() => {
        this.compileFilter();
        this.scheduleRefresh();
      }),
      this.view.onDidChangeCheckboxState((e) => this.onCheckbox(e)),
      this.view.onDidExpandElement((e) => this.onExpand(e.element, false)),
      this.view.onDidCollapseElement((e) => this.onExpand(e.element, true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('canopy.openDetailsOnClick')) this.scheduleRefresh();
      })
    );
    this.updateChrome();
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  set forge(service: ForgeHub) {
    this.forgeService = service;
    this.disposables.push(service.onDidChange(() => this.scheduleRefresh()));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== REPO_SCHEME) return undefined;
    const r = this.manager.get(uri.query);
    if (!r || !r.loaded) return undefined;
    const d = priorityDecoration(this.factsOf(r));
    return d && new vscode.FileDecoration(d.badge, d.tooltip, new vscode.ThemeColor(d.color));
  }

  get currentLayout(): Layout {
    return this.layout;
  }

  private compileFilter(): void {
    try {
      this.filterPredicate = this.state.textFilter.trim() ? compileQuery(this.state.textFilter) : undefined;
    } catch {
      this.filterPredicate = undefined;
    }
    void vscode.commands.executeCommand('setContext', 'canopy.filtered', this.state.isFiltered);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.childMap = undefined;
      this._onDidChangeTreeData.fire(undefined);
      this._onDidChangeFileDecorations.fire(undefined);
      this.updateChrome();
    }, 80);
  }

  refresh(): void {
    this.childMap = undefined;
    this._onDidChangeTreeData.fire(undefined);
    this._onDidChangeFileDecorations.fire(undefined);
    this.updateChrome();
  }

  // --- visibility ---------------------------------------------------------

  folderNamesOf(repo: Repo): string[] {
    const f = folderOfRepo(this.layout, repo.key);
    return f ? folderPath(this.layout, f.id) : [];
  }

  factsOf(repo: Repo): RepoFacts {
    const f = repo.facts(this.folderNamesOf(repo));
    if (repo.superRoot) f.submoduleMoved = this.isMoved(repo);
    const info = this.forgeService?.info(repo);
    if (info) {
      f.ci = info.pipeline?.status ?? null;
      f.mr = info.mr ? (info.mr.draft ? 'draft' : 'open') : null;
      f.mrConflicts = !!info.mr?.hasConflicts;
    }
    return f;
  }

  // --- submodules ---------------------------------------------------------

  /** The tracked repository this one is a submodule of. */
  parentOf(repo: Repo): Repo | undefined {
    return repo.superRoot ? this.manager.findByRoot(repo.superRoot) : undefined;
  }

  /** Submodules nest under their parent, except when the view is grouped by status (that list stays flat). */
  private get nesting(): boolean {
    return this.state.groupBy !== 'status' || this.state.editMode;
  }

  /** True when the repo is shown under its parent instead of in a folder. */
  private isNested(repo: Repo): boolean {
    return this.nesting && !!this.parentOf(repo);
  }

  private submodulesOf(repo: Repo): Repo[] {
    if (!this.childMap) {
      this.childMap = new Map();
      for (const r of this.manager.all) {
        const parent = this.parentOf(r);
        if (parent) this.childMap.set(parent.key, [...(this.childMap.get(parent.key) ?? []), r]);
      }
    }
    return this.childMap.get(repo.key) ?? [];
  }

  /** Submodules to show under a repo (filters apply), in view order. */
  private visibleSubmodules(repo: Repo): Repo[] {
    if (!this.nesting) return [];
    return this.submodulesOf(repo).filter((r) => this.passesFilter(r)).sort(this.repoComparator());
  }

  /** `repos` plus every submodule below them, deduplicated. */
  private withSubmodules(repos: Repo[]): Repo[] {
    const out = new Map<string, Repo>();
    const add = (r: Repo) => {
      if (out.has(r.key)) return;
      out.set(r.key, r);
      this.submodulesOf(r).forEach(add);
    };
    repos.forEach(add);
    return [...out.values()];
  }

  /** Is this submodule checked out at a different commit than its parent records? */
  private isMoved(repo: Repo): boolean {
    const parent = this.parentOf(repo);
    if (!parent) return false;
    const rel = path.relative(parent.root, repo.root).replace(/\\/g, '/');
    return !!parent.status?.submodules[rel]?.commit;
  }

  isHidden(repo: Repo): boolean {
    return this.layout.hidden.includes(repo.key);
  }

  /** Repos not hidden in the layout (filters ignored). */
  visibleRepos(): Repo[] {
    return this.manager.all.filter((r) => !this.isHidden(r));
  }

  /** Passes the filters itself, or (when submodules nest under it) because one of them does. */
  private passesFilter(repo: Repo): boolean {
    if (this.state.editMode) return true;
    if (this.isHidden(repo)) return false;
    return this.passesOwnFilter(repo) || (this.nesting && this.submodulesOf(repo).some((s) => this.passesFilter(s)));
  }

  private passesOwnFilter(repo: Repo): boolean {
    if (this.state.editMode) return true;
    if (this.isHidden(repo)) return false;
    const f = this.factsOf(repo);
    const att = attentionOf(f);
    if (this.state.hideClean && att === 'clean') return false;
    const filters = this.state.filters;
    if (filters.length && !filters.includes(att)) {
      // A diverged repo also counts as incoming and unpushed for filtering.
      const extra = (att === 'diverged' && (filters.includes('behind') || filters.includes('ahead'))) || (f.changed > 0 && filters.includes('changes'));
      if (!extra) return false;
    }
    if (this.filterPredicate && !this.filterPredicate(f)) return false;
    return true;
  }

  /** Repos shown in the view right now, in display order (used by Go to Repository). */
  shownRepos(): Repo[] {
    return this.manager.all.filter((r) => this.passesOwnFilter(r)).sort(this.repoComparator());
  }

  private repoComparator(manualOrder?: string[]): (a: Repo, b: Repo) => number {
    const cmp = compareRepos(this.state.sort, manualOrder);
    return (a, b) => cmp(this.factsOf(a), this.factsOf(b));
  }

  private smartMatches(folder: LayoutFolder): Repo[] {
    try {
      const pred = compileQuery(folder.query ?? '');
      return this.manager.all.filter((r) => this.passesOwnFilter(r) && pred(this.factsOf(r)));
    } catch {
      return [];
    }
  }

  private reposInFolder(folder: LayoutFolder): Repo[] {
    if (folder.query !== undefined) return this.smartMatches(folder).sort(this.repoComparator());
    return folder.repos
      .map((k) => this.manager.get(k))
      .filter((r): r is Repo => !!r && !this.isNested(r) && this.passesFilter(r))
      .sort(this.repoComparator(folder.repos));
  }

  private unsortedRepos(): Repo[] {
    const filed = new Set<string>();
    for (const { folder } of walkFolders(this.layout.folders)) if (!folder.query) folder.repos.forEach((k) => filed.add(k));
    return this.manager.all.filter((r) => !filed.has(r.key) && !this.isNested(r) && this.passesFilter(r)).sort(this.repoComparator(this.layout.unsorted));
  }

  /** All repos under a node, recursively (deduplicated). */
  reposUnder(node: Node): Repo[] {
    if (node.kind === 'repo') return [node.repo];
    if (node.kind === 'unsorted') {
      const top = this.unsortedRepos();
      return this.withSubmodules(top).filter((r) => top.includes(r) || this.passesOwnFilter(r));
    }
    if (node.kind === 'group') return this.shownRepos().filter((r) => attentionOf(this.factsOf(r)) === node.attention);
    const out = new Map<string, Repo>();
    const visit = (f: LayoutFolder) => {
      this.reposInFolder(f).forEach((r) => out.set(r.key, r));
      f.children.forEach(visit);
    };
    visit(node.folder);
    return this.withSubmodules([...out.values()]).filter((r) => out.has(r.key) || this.passesOwnFilter(r));
  }

  private folderHasContent(folder: LayoutFolder): boolean {
    if (this.state.editMode || !this.state.isFiltered) return true;
    return this.reposInFolder(folder).length > 0 || folder.children.some((c) => this.folderHasContent(c));
  }

  // --- TreeDataProvider -----------------------------------------------------

  getChildren(element?: Node): Node[] {
    if (!element) {
      if (this.state.groupBy === 'status' && !this.state.editMode) {
        const shown = this.shownRepos();
        return ATTENTION_ORDER.filter((a) => shown.some((r) => attentionOf(this.factsOf(r)) === a)).map((attention) => ({ kind: 'group', attention }));
      }
      if (!this.layout.folders.length) return this.unsortedRepos().map((repo) => ({ kind: 'repo', repo, parent: UNSORTED_ID }));
      const nodes: Node[] = this.layout.folders.filter((f) => this.folderHasContent(f)).map((folder) => ({ kind: 'folder', folder, parentId: null }));
      if (this.unsortedRepos().length || this.state.editMode) nodes.push({ kind: 'unsorted' });
      return nodes;
    }
    if (element.kind === 'folder') {
      const sub: Node[] = element.folder.children.filter((f) => this.folderHasContent(f)).map((folder) => ({ kind: 'folder', folder, parentId: element.folder.id }));
      const repos: Node[] = this.reposInFolder(element.folder).map((repo) => ({ kind: 'repo', repo, parent: element.folder.id }));
      return [...sub, ...repos];
    }
    if (element.kind === 'unsorted') return this.unsortedRepos().map((repo) => ({ kind: 'repo', repo, parent: UNSORTED_ID }));
    if (element.kind === 'group') return this.reposUnder(element).map((repo) => ({ kind: 'repo', repo, parent: 'group:' + element.attention }));
    if (element.kind === 'repo') return this.visibleSubmodules(element.repo).map((repo) => ({ kind: 'repo', repo, parent: 'sub:' + element.repo.key }));
    return [];
  }

  /** The tree node a repo is shown as: under its parent repo when nested, else in its folder or Unsorted. */
  private nodeOf(repo: Repo): RepoNode {
    const parent = this.nesting ? this.parentOf(repo) : undefined;
    if (parent) return { kind: 'repo', repo, parent: 'sub:' + parent.key };
    return { kind: 'repo', repo, parent: folderOfRepo(this.layout, repo.key)?.id ?? UNSORTED_ID };
  }

  getParent(element: Node): Node | undefined {
    if (element.kind === 'folder') {
      if (!element.parentId) return undefined;
      for (const { folder, parent } of walkFolders(this.layout.folders)) if (folder.id === element.parentId) return { kind: 'folder', folder, parentId: parent?.id ?? null };
      return undefined;
    }
    if (element.kind === 'repo') {
      if (element.parent.startsWith('sub:')) {
        const parent = this.manager.get(element.parent.slice(4));
        return parent ? this.nodeOf(parent) : undefined;
      }
      if (element.parent === UNSORTED_ID) return this.layout.folders.length ? { kind: 'unsorted' } : undefined;
      if (element.parent.startsWith('group:')) return { kind: 'group', attention: element.parent.slice(6) as Attention };
      for (const { folder, parent } of walkFolders(this.layout.folders)) if (folder.id === element.parent) return { kind: 'folder', folder, parentId: parent?.id ?? null };
    }
    return undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'repo':
        return this.repoItem(node);
      case 'folder':
        return this.folderItem(node);
      case 'unsorted': {
        const repos = this.unsortedRepos();
        const item = new vscode.TreeItem('Unsorted', this.collapsible(UNSORTED_ID));
        item.id = UNSORTED_ID;
        item.iconPath = new vscode.ThemeIcon('inbox');
        item.description = aggregate(repos.map((r) => this.factsOf(r))) || `${repos.length}`;
        item.contextValue = 'group:unsorted';
        item.tooltip = 'Repositories that are not in any folder. Drag them onto a folder to file them.';
        return item;
      }
      case 'group': {
        const repos = this.reposUnder(node);
        const item = new vscode.TreeItem(ATTENTION_LABEL[node.attention], this.collapsible('group:' + node.attention));
        item.id = 'group:' + node.attention;
        const [icon, color] = ATTENTION_ICON[node.attention];
        item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
        item.description = `${repos.length}`;
        item.contextValue = 'group:status';
        return item;
      }
    }
  }

  private collapsible(id: string): vscode.TreeItemCollapsibleState {
    return this.state.collapsed.includes(id) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
  }

  private folderItem(node: FolderNode): vscode.TreeItem {
    const f = node.folder;
    const repos = this.reposUnder(node);
    const item = new vscode.TreeItem(f.name, this.collapsible(f.id));
    item.id = 'folder:' + f.id;
    const smart = f.query !== undefined;
    item.iconPath = new vscode.ThemeIcon(smart ? 'filter' : 'folder');
    item.description = aggregate(repos.map((r) => this.factsOf(r))) || (repos.length ? `${repos.length}` : '');
    item.contextValue = smart ? 'folder:smart' : 'folder:manual';
    item.tooltip = smart ? new vscode.MarkdownString(`**Smart folder**\n\n\`${f.query}\``) : `${repos.length} repositories`;
    if (this.state.editMode && !smart) {
      const direct = f.repos.map((k) => this.manager.get(k)).filter((r): r is Repo => !!r);
      item.checkboxState = direct.length && direct.every((r) => this.isHidden(r)) ? vscode.TreeItemCheckboxState.Unchecked : vscode.TreeItemCheckboxState.Checked;
    }
    return item;
  }

  private repoItem(node: RepoNode): vscode.TreeItem {
    const r = node.repo;
    const facts = this.factsOf(r);
    const att = attentionOf(facts);
    const hidden = this.isHidden(r);
    const kids = this.visibleSubmodules(r).length;
    const item = new vscode.TreeItem(r.name, kids ? this.collapsible('sub:' + r.key) : vscode.TreeItemCollapsibleState.None);
    item.id = node.parent + '/' + r.key;
    const badges = badgeText(facts);
    const info = this.forgeService?.info(r);
    const forge = info ? [info.pipeline ? pipelineSymbol(info.pipeline.status) : '', info.mr ? `${FORGE_WORDS[info.provider].prefix}${info.mr.iid}${info.mr.draft ? ' draft' : ''}` : ''].filter(Boolean).join(' ') : '';
    const activity = r.activity[r.activity.length - 1] ?? (r.fetching ? 'Fetching' : '');
    item.description = [activity ? `${activity}…` : '', r.branchLabel, badges, forge, hidden && this.state.editMode ? '(hidden)' : ''].filter(Boolean).join('  ');
    if (activity) item.iconPath = new vscode.ThemeIcon('sync~spin');
    else if (!r.loaded) item.iconPath = new vscode.ThemeIcon('loading~spin');
    else {
      const [icon, color] = ATTENTION_ICON[att];
      // Submodules keep the warning and error icons, but otherwise get their own icon in the submodule color.
      item.iconPath =
        r.superRoot && att !== 'conflict' && att !== 'error'
          ? new vscode.ThemeIcon('file-submodule', new vscode.ThemeColor('canopy.submoduleForeground'))
          : new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    }
    const flags = ['repo'];
    if (r.superRoot) flags.push('submodule');
    if (r.remotes.size) flags.push('remote');
    if (r.behind) flags.push('behind');
    if (r.ahead) flags.push('ahead');
    if (r.changed) flags.push('dirty');
    if (r.operation || r.conflicts.length) flags.push('operation');
    if (!r.upstream && r.branch && r.remotes.size) flags.push('unpublished');
    if (hidden) flags.push('hidden');
    const forgeState = this.forgeService?.state(r);
    if (forgeState?.kind === 'connected') flags.push('forge', forgeState.provider);
    if (info?.mr) flags.push('mr');
    if (info?.pipeline) flags.push('pipeline');
    if (info?.pipeline?.status === 'failed' || info?.pipeline?.status === 'canceled') flags.push('pipelinefailed');
    item.contextValue = flags.join(':');
    item.tooltip = this.tooltip(r, facts);
    item.resourceUri = vscode.Uri.file(r.root).with({ scheme: REPO_SCHEME, query: r.key });
    if (this.state.editMode) {
      item.checkboxState = hidden ? vscode.TreeItemCheckboxState.Unchecked : vscode.TreeItemCheckboxState.Checked;
    } else if (vscode.workspace.getConfiguration('canopy').get<boolean>('openDetailsOnClick', true)) {
      item.command = { command: 'canopy.openDetails', title: 'Open Details', arguments: [r, { preserveFocus: true }] };
    }
    return item;
  }

  private tooltip(r: Repo, f: RepoFacts): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(r.name)}**  \n`);
    if (r.superRoot) {
      const parent = this.parentOf(r);
      md.appendMarkdown(`$(file-submodule) submodule of ${parent ? '**' + escapeMd(parent.name) + '**' : '`' + escapeMd(r.superRoot) + '`'}${f.submoduleMoved ? ' · checked out at a different commit than the parent records' : ''}  \n`);
    }
    md.appendMarkdown(`$(git-branch) \`${escapeMd(r.branchLabel)}\`${r.upstream ? ` → \`${escapeMd(r.upstream)}\`` : r.branch ? ' (no upstream)' : ''}  \n`);
    if (r.operation) md.appendMarkdown(`$(warning) ${operationLabel(r.operation)} in progress  \n`);
    if (f.conflicts) md.appendMarkdown(`$(warning) ${f.conflicts} conflicted files  \n`);
    if (r.behind || r.ahead) md.appendMarkdown(`$(arrow-down) ${r.behind} incoming · $(arrow-up) ${r.ahead} unpushed  \n`);
    if (f.changed) md.appendMarkdown(`$(diff) ${f.changed} changed files (${f.staged} staged)  \n`);
    if (r.error) md.appendMarkdown(`$(error) ${escapeMd(r.error)}  \n`);
    md.appendMarkdown(`$(folder) ${escapeMd(r.root)}  \n`);
    if (r.lastFetch) md.appendMarkdown(`$(cloud-download) fetched ${timeAgo(r.lastFetch)}  \n`);
    if (r.lastCommitTime) md.appendMarkdown(`$(git-commit) last commit ${timeAgo(r.lastCommitTime * 1000)}  \n`);
    const fs = this.forgeService?.state(r);
    if (fs?.kind === 'connected' && fs.info) {
      const i = fs.info;
      const w = FORGE_WORDS[i.provider];
      if (i.pipeline) md.appendMarkdown(`$(rocket) ${w.pipeline} [${i.pipeline.id ? '#' + i.pipeline.id : 'details'}](${i.pipeline.webUrl}) **${i.pipeline.status}**${i.pipeline.isHead ? '' : ' (for an older or newer commit)'}  \n`);
      if (i.mr) {
        const appr = i.mr.changesRequested ? ', changes requested' : i.mr.approved ? ', approved' : i.mr.approvalsLeft ? `, ${i.mr.approvalsLeft} approval(s) needed` : '';
        md.appendMarkdown(`$(git-pull-request) [${w.prefix}${i.mr.iid}](${i.mr.webUrl}) ${escapeMd(i.mr.title)}${i.mr.draft ? ' (draft)' : ''}${i.mr.hasConflicts ? ', has conflicts' : ''}${appr}  \n`);
      }
      if (i.error) md.appendMarkdown(`$(warning) ${w.name}: ${escapeMd(i.error)}`);
    } else if (fs?.kind === 'disconnected') {
      const w = FORGE_WORDS[fs.provider];
      const cmd = `canopy.${fs.provider}.connect`;
      md.appendMarkdown(`$(plug) [${fs.provider === 'github' ? 'Sign in to' : 'Connect'} ${fs.host}](command:${cmd}?${encodeURIComponent(JSON.stringify([fs.host]))}) to see ${w.pipeline} and ${w.request}s`);
      md.isTrusted = { enabledCommands: [cmd] };
    }
    md.supportThemeIcons = true;
    return md;
  }

  // --- chrome ---------------------------------------------------------------

  private updateChrome(): void {
    const visible = this.visibleRepos();
    const attention = visible.filter((r) => needsAttention(this.factsOf(r))).length;
    this.view.badge = attention ? { value: attention, tooltip: `${attention} repositories need attention` } : undefined;
    const shown = this.shownRepos().length;
    const parts: string[] = [];
    if (this.state.editMode) {
      this.view.message = 'Editing layout: drag repos into folders, uncheck to hide. Click ✓ when done.';
    } else if (this.state.isFiltered) {
      const names = this.state.filters.map((a) => ATTENTION_LABEL[a]);
      if (this.state.hideClean) names.push('hiding clean');
      if (this.state.textFilter.trim()) names.push(`"${this.state.textFilter.trim()}"`);
      this.view.message = `Filtered: ${names.join(', ')} · ${shown} of ${visible.length} repos`;
    } else {
      this.view.message = undefined;
    }
    const hiddenCount = this.manager.all.length - visible.length;
    parts.push(`${visible.length} repos`);
    if (hiddenCount) parts.push(`${hiddenCount} hidden`);
    this.view.description = parts.join(' · ');
  }

  // --- edit mode: checkboxes ------------------------------------------------

  private async onCheckbox(e: vscode.TreeCheckboxChangeEvent<Node>): Promise<void> {
    const show: string[] = [];
    const hide: string[] = [];
    for (const [node, st] of e.items) {
      const target = st === vscode.TreeItemCheckboxState.Checked ? show : hide;
      if (node.kind === 'repo') target.push(node.repo.key);
      else if (node.kind === 'folder' && node.folder.query === undefined) {
        for (const { folder } of walkFolders([node.folder])) if (!folder.query) target.push(...folder.repos);
      }
    }
    let layout = this.layout;
    if (hide.length) layout = setHidden(layout, hide, true);
    if (show.length) layout = setHidden(layout, show, false);
    await this.saveLayout(layout);
  }

  private async onExpand(node: Node, collapsed: boolean): Promise<void> {
    const id = node.kind === 'folder' ? node.folder.id : node.kind === 'unsorted' ? UNSORTED_ID : node.kind === 'group' ? 'group:' + node.attention : node.kind === 'repo' ? 'sub:' + node.repo.key : undefined;
    if (id) await this.state.setCollapsed(id, collapsed);
  }

  async saveLayout(layout: Layout): Promise<void> {
    this.layout = layout;
    this.refresh();
    await this.store.setLayout(layout);
  }

  // --- drag and drop --------------------------------------------------------

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const payload = source
      .map((n) => (n.kind === 'repo' ? (this.isNested(n.repo) ? undefined : { t: 'repo', key: n.repo.key }) : n.kind === 'folder' ? { t: 'folder', id: n.folder.id } : undefined))
      .filter(Boolean);
    if (payload.length) data.set(MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(MIME);
    if (!item) return;
    let payload: Array<{ t: 'repo'; key: string } | { t: 'folder'; id: string }>;
    try {
      payload = JSON.parse(await item.asString());
    } catch {
      return;
    }
    if (this.state.groupBy === 'status' && !this.state.editMode) {
      void vscode.window.showInformationMessage('Switch to "Group by Folders" to rearrange repositories.');
      return;
    }
    let layout = this.layout;
    const keys = payload.filter((p) => p.t === 'repo').map((p) => (p as { key: string }).key);
    const folders = payload.filter((p) => p.t === 'folder').map((p) => (p as { id: string }).id);

    let folderId: string | null = null;
    let beforeKey: string | undefined;
    if (target?.kind === 'folder') {
      if (target.folder.query !== undefined) {
        void vscode.window.showInformationMessage(`"${target.folder.name}" is a smart folder; it fills itself from its query.`);
        return;
      }
      folderId = target.folder.id;
    } else if (target?.kind === 'repo') {
      folderId = target.parent === UNSORTED_ID || target.parent.startsWith('group:') ? null : target.parent;
      const parentFolder = folderId ? walkAll(layout).find((f) => f.id === folderId) : undefined;
      if (parentFolder?.query !== undefined) folderId = folderOfRepo(layout, target.repo.key)?.id ?? null;
      beforeKey = target.repo.key;
    } else if (target?.kind === 'group') {
      return;
    }

    if (keys.length) layout = moveRepos(layout, keys, folderId, beforeKey);
    for (const id of folders) {
      if (target?.kind === 'folder') layout = moveFolder(layout, id, target.folder.id);
      else if (target?.kind === 'repo') layout = moveFolder(layout, id, folderId);
      else layout = moveFolder(layout, id, null);
    }
    if (keys.length && beforeKey && this.state.sort !== 'manual') {
      void vscode.window.showInformationMessage('Order saved. Switch Sort to "Manual" to see the manual order.', 'Sort Manually').then((a) => {
        if (a) void this.state.set({ sort: 'manual' });
      });
    }
    await this.saveLayout(layout);
  }
}

function walkAll(layout: Layout): LayoutFolder[] {
  return [...walkFolders(layout.folders)].map((x) => x.folder);
}

function aggregate(list: RepoFacts[]): string {
  const sum = (k: 'behind' | 'changed' | 'ahead' | 'conflicts') => list.reduce((n, r) => n + r[k], 0);
  const parts: string[] = [];
  if (sum('conflicts')) parts.push(`⚠${sum('conflicts')}`);
  if (sum('behind')) parts.push(`↓${sum('behind')}`);
  if (sum('changed')) parts.push(`●${sum('changed')}`);
  if (sum('ahead')) parts.push(`↑${sum('ahead')}`);
  return parts.join(' ');
}

export function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
  return `${Math.floor(s / (86400 * 365))}y ago`;
}

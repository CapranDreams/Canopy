import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitOps } from './gitOps';
import { Log } from '../log';
import { RepoManager } from '../manager';
import { addFolder, deleteFolder, moveRepos, setHidden, updateFolder, walkFolders } from '../model/layout';
import { compileQuery, validateQuery } from '../model/query';
import { ATTENTION_LABEL, Attention, SORT_MODES, SortMode, attentionOf } from '../model/types';
import { DetailPanel } from '../panels/detailPanel';
import { ProfilesPanel } from '../panels/profilesPanel';
import { Profiles } from '../profiles';
import { Repo } from '../repo';
import { Store, ViewState } from '../store';
import { Node, RepoTree, badgeText } from '../tree';
import { repoNameFromUrl, validateCloneUrl, webUrlForRemote } from '../util/remote';
import { ForgeHub } from '../forge/hub';
import { ForgeProvider } from '../forge/types';

interface Deps {
  ctx: vscode.ExtensionContext;
  manager: RepoManager;
  store: Store;
  state: ViewState;
  tree: RepoTree;
  ops: GitOps;
  detail: DetailPanel;
  profiles: Profiles;
  profilesPanel: ProfilesPanel;
  forge: ForgeHub;
  log: Log;
}

function isNode(x: unknown): x is Node {
  return !!x && typeof x === 'object' && 'kind' in x && ['repo', 'folder', 'unsorted', 'group'].includes((x as Node).kind);
}

export function registerCommands(d: Deps): vscode.Disposable[] {
  const { manager, store, state, tree, ops, detail, profiles, profilesPanel, forge, log } = d;
  const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand('canopy.' + id, fn);

  /** Resolves command arguments to repos: tree nodes (incl. multi-select), Repo objects, paths, or a prompt. */
  async function resolveRepos(arg: unknown, all: unknown, multi: boolean): Promise<Repo[]> {
    if (Array.isArray(all) && all.length > 1 && all.every(isNode)) {
      const set = new Map<string, Repo>();
      for (const n of all as Node[]) tree.reposUnder(n).forEach((r) => set.set(r.key, r));
      return [...set.values()];
    }
    if (arg instanceof Repo) return [arg];
    if (isNode(arg)) return tree.reposUnder(arg);
    if (typeof arg === 'string') {
      const r = manager.get(arg) ?? manager.findByRoot(arg);
      return r ? [r] : [];
    }
    if (arg instanceof vscode.Uri) {
      const r = manager.findContaining(arg.fsPath);
      return r ? [r] : [];
    }
    const sel = tree.view.selection.filter((n) => n.kind === 'repo').map((n) => (n as { repo: Repo }).repo);
    if (sel.length && tree.view.visible) return multi ? sel : [sel[0]];
    if (detail.activeRepo) return [detail.activeRepo];
    const editorPath = vscode.window.activeTextEditor?.document.uri;
    if (editorPath?.scheme === 'file') {
      const r = manager.findContaining(editorPath.fsPath);
      if (r) return [r];
    }
    const picked = await pickRepos(multi);
    return picked;
  }

  async function pickRepos(multi: boolean, placeHolder = 'Choose a repository'): Promise<Repo[]> {
    const items = tree.visibleRepos().map((r) => ({ label: r.name, description: [r.branchLabel, badgeText(tree.factsOf(r))].filter(Boolean).join('  '), detail: r.root, repo: r }));
    if (!items.length) {
      void vscode.window.showInformationMessage('CANOPY has no repositories yet.');
      return [];
    }
    if (multi) {
      const picks = await vscode.window.showQuickPick(items, { placeHolder: placeHolder + 's', canPickMany: true, matchOnDescription: true });
      return picks?.map((p) => p.repo) ?? [];
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
    return pick ? [pick.repo] : [];
  }

  const disposables: vscode.Disposable[] = [];

  // --- git operations ---------------------------------------------------------
  for (const [id, h] of Object.entries(ops.handlers())) {
    disposables.push(
      reg(id, async (arg?: unknown, all?: unknown) => {
        const repos = await resolveRepos(arg, all, !!h.multi);
        if (!repos.length) return;
        await h.run(repos, typeof all === 'string' ? all : undefined);
      })
    );
  }

  const one = (fn: (r: Repo) => unknown) => async (arg?: unknown, all?: unknown) => {
    const [r] = await resolveRepos(arg, all, false);
    if (r) await fn(r);
  };

  disposables.push(
    reg('openDetails', async (arg?: unknown, opts?: { preserveFocus?: boolean }) => {
      const [r] = await resolveRepos(arg, undefined, false);
      if (r) detail.show(r, opts?.preserveFocus ?? false);
    }),
    reg('openOnRemote', one(async (r) => {
      const remote = r.primaryRemote;
      const url = remote ? webUrlForRemote(remote.url, r.upstream ? r.upstream.slice(remote.name.length + 1) : r.branch ?? undefined) : undefined;
      if (!url) return void vscode.window.showInformationMessage(`${r.name} has no web remote.`);
      await vscode.env.openExternal(vscode.Uri.parse(url));
    })),
    reg('showOutput', () => log.show()),

    // --- view commands ----------------------------------------------------------
    reg('refresh', async () => {
      await manager.discover();
      await manager.refreshAll();
      forge.refreshVisible(true);
    }),
    reg('scanForRepositories', async () => {
      await manager.discover();
      void vscode.window.setStatusBarMessage(`$(check) CANOPY: ${manager.all.length} repositories`, 3000);
    }),
    reg('fetchAll', async () => {
      const repos = tree.visibleRepos();
      const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Fetching ${repos.length} repositories` }, () => manager.fetchAll(repos));
      void vscode.window.setStatusBarMessage(`$(cloud-download) Fetched ${res.ok} of ${repos.length} repositories`, 4000);
    }),
    reg('filter', async () => {
      const facts = tree.visibleRepos().map((r) => tree.factsOf(r));
      const count = (a: Attention) => facts.filter((f) => attentionOf(f) === a || (a === 'behind' && f.behind > 0) || (a === 'ahead' && f.ahead > 0) || (a === 'changes' && f.changed > 0)).length;
      const atts: Attention[] = ['conflict', 'diverged', 'behind', 'changes', 'ahead', 'unpublished', 'error'];
      type Item = vscode.QuickPickItem & { att?: Attention; special?: 'hideClean' | 'text'; sort?: SortMode };
      const items: Item[] = [
        ...atts.map((a) => ({ label: ATTENTION_LABEL[a], description: `${count(a)}`, att: a })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: 'Hide clean repositories', special: 'hideClean' as const },
        { label: state.textFilter ? `Text / query filter: ${state.textFilter}` : 'Text / query filter…', description: 'name, branch, or e.g. is:dirty age<7d', special: 'text' as const },
        { label: 'Sort by', kind: vscode.QuickPickItemKind.Separator },
        ...SORT_MODES.map(({ mode, label, description }) => ({ label, description, sort: mode }))
      ];
      // A custom quick pick so the sort options behave like radio buttons: checking one unchecks the others.
      const qp = vscode.window.createQuickPick<Item>();
      qp.canSelectMany = true;
      qp.placeholder = 'Show only repositories that match (any checked status), and pick a sort order';
      qp.items = items;
      qp.selectedItems = items.filter((i) => (i.att && state.filters.includes(i.att)) || (i.special === 'hideClean' && state.hideClean) || (i.special === 'text' && !!state.textFilter) || i.sort === state.sort);
      let sort = state.sort;
      qp.onDidChangeSelection((sel) => {
        const sorts = sel.filter((i) => i.sort);
        const next = sorts.find((i) => i.sort !== sort)?.sort ?? sorts[0]?.sort ?? sort;
        sort = next;
        if (sorts.length !== 1 || sorts[0].sort !== next) qp.selectedItems = [...sel.filter((i) => !i.sort), items.find((i) => i.sort === next)!];
      });
      const picks = await new Promise<readonly Item[] | undefined>((resolve) => {
        let accepted = false;
        qp.onDidAccept(() => {
          accepted = true;
          resolve(qp.selectedItems);
          qp.hide();
        });
        qp.onDidHide(() => {
          if (!accepted) resolve(undefined);
          qp.dispose();
        });
        qp.show();
      });
      if (!picks) return;
      let text = state.textFilter;
      if (picks.some((p) => p.special === 'text')) {
        const t = await vscode.window.showInputBox({ prompt: 'Filter by name/branch text or a query (is:behind, branch:feat/*, age<7d, folder:Backend)', value: state.textFilter, validateInput: (v) => (v.trim() ? validateQuery(v) : undefined) });
        if (t === undefined) return;
        text = t.trim();
      } else text = '';
      await state.set({ filters: picks.filter((p) => p.att).map((p) => p.att!), hideClean: picks.some((p) => p.special === 'hideClean'), textFilter: text, sort });
    }),
    reg('clearFilter', () => state.set({ filters: [], hideClean: false, textFilter: '' })),
    reg('sortBy', async () => {
      const pick = await vscode.window.showQuickPick(SORT_MODES.map(({ mode, label, description }) => ({ label: (state.sort === mode ? '$(check) ' : '') + label, description, m: mode })), { placeHolder: 'Sort repositories by' });
      if (pick) await state.set({ sort: pick.m });
    }),
    reg('toggleGroupBy', () => state.set({ groupBy: state.groupBy === 'folders' ? 'status' : 'folders' })),
    reg('editLayout', () => {
      if (state.groupBy === 'status') void state.set({ groupBy: 'folders' });
      state.setEditMode(true);
    }),
    reg('doneEditing', () => state.setEditMode(false)),
    reg('showAllRepositories', async () => {
      const layout = tree.currentLayout;
      if (layout.hidden.length) await tree.saveLayout({ ...layout, hidden: [] });
    }),
    reg('hideCleanRepositories', async () => {
      const clean = manager.all.filter((r) => attentionOf(tree.factsOf(r)) === 'clean').map((r) => r.key);
      await tree.saveLayout(setHidden(tree.currentLayout, clean, true));
      void vscode.window.showInformationMessage(`Hid ${clean.length} clean repositories. Check them again in edit mode to show them.`);
    }),
    reg('goToRepository', async () => {
      type Item = vscode.QuickPickItem & { repo: Repo };
      const qp = vscode.window.createQuickPick<Item>();
      const all = tree.visibleRepos();
      const toItem = (r: Repo): Item => ({ label: r.name, description: [r.branchLabel, badgeText(tree.factsOf(r)), tree.folderNamesOf(r).join(' / ')].filter(Boolean).join('  ·  '), detail: r.root, repo: r });
      qp.items = all.map(toItem);
      qp.matchOnDescription = true;
      qp.placeholder = 'Go to repository (type a name, or a query like is:behind folder:Backend)';
      qp.onDidChangeValue((v) => {
        if (/\b(is|branch|folder|name|path|remote):|[<>]=?\d/.test(v)) {
          try {
            const pred = compileQuery(v);
            qp.items = all.filter((r) => pred(tree.factsOf(r))).map((r) => ({ ...toItem(r), alwaysShow: true }));
          } catch {
            qp.items = [];
          }
        } else if (qp.items.length !== all.length) qp.items = all.map(toItem);
      });
      qp.onDidAccept(async () => {
        const r = qp.selectedItems[0]?.repo;
        qp.hide();
        if (!r) return;
        detail.show(r);
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),

    // --- layout / folders ---------------------------------------------------------
    reg('newFolder', async (arg?: unknown) => {
      const parentId = isNode(arg) && arg.kind === 'folder' && arg.folder.query === undefined ? arg.folder.id : null;
      const name = await vscode.window.showInputBox({ prompt: parentId ? 'New subfolder name' : 'New folder name', validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
      if (name?.trim()) await tree.saveLayout(addFolder(tree.currentLayout, name.trim(), parentId).layout);
    }),
    reg('newSubfolder', (arg?: unknown) => vscode.commands.executeCommand('canopy.newFolder', arg)),
    reg('newSmartFolder', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Smart folder name', placeHolder: 'Needs me today' });
      if (!name?.trim()) return;
      const query = await askQuery('');
      if (query !== undefined) await tree.saveLayout(addFolder(tree.currentLayout, name.trim(), null, query).layout);
    }),
    reg('editSmartFolder', async (arg?: unknown) => {
      if (!isNode(arg) || arg.kind !== 'folder' || arg.folder.query === undefined) return;
      const query = await askQuery(arg.folder.query);
      if (query !== undefined) await tree.saveLayout(updateFolder(tree.currentLayout, arg.folder.id, { query }));
    }),
    reg('renameFolder', async (arg?: unknown) => {
      if (!isNode(arg) || arg.kind !== 'folder') return;
      const name = await vscode.window.showInputBox({ prompt: 'Rename folder', value: arg.folder.name, validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
      if (name?.trim()) await tree.saveLayout(updateFolder(tree.currentLayout, arg.folder.id, { name: name.trim() }));
    }),
    reg('deleteFolder', async (arg?: unknown) => {
      if (!isNode(arg) || arg.kind !== 'folder') return;
      const before = tree.currentLayout;
      await tree.saveLayout(deleteFolder(before, arg.folder.id));
      void vscode.window.showInformationMessage(`Deleted folder "${arg.folder.name}". Its repositories moved up a level.`, 'Undo').then((a) => a && tree.saveLayout(before));
    }),
    reg('fetchFolder', async (arg?: unknown) => {
      const repos = isNode(arg) ? tree.reposUnder(arg) : [];
      if (repos.length) await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Fetching ${repos.length} repositories` }, () => manager.fetchAll(repos));
    }),
    reg('pullFolder', async (arg?: unknown) => {
      const repos = isNode(arg) ? tree.reposUnder(arg) : [];
      if (repos.length) await ops.pull(repos, 'ff-only');
    }),
    reg('moveToFolder', async (arg?: unknown, all?: unknown) => {
      const repos = await resolveRepos(arg, all, true);
      if (!repos.length) return;
      const layout = tree.currentLayout;
      const folders = [...walkFolders(layout.folders)].filter((x) => x.folder.query === undefined);
      const pathOf = (id: string): string => {
        const names: string[] = [];
        let cur: string | null = id;
        while (cur) {
          const entry = folders.find((f) => f.folder.id === cur);
          if (!entry) break;
          names.unshift(entry.folder.name);
          cur = entry.parent?.id ?? null;
        }
        return names.join(' / ');
      };
      type Item = vscode.QuickPickItem & { id: string | null | 'new' };
      const items: Item[] = [
        { label: '$(new-folder) New folder…', id: 'new' },
        ...folders.map((f) => ({ label: `$(folder) ${pathOf(f.folder.id)}`, id: f.folder.id })),
        { label: '$(inbox) Unsorted', id: null }
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Move ${repos.length === 1 ? repos[0].name : repos.length + ' repositories'} to` });
      if (!pick) return;
      let target = pick.id;
      let next = layout;
      if (target === 'new') {
        const name = await vscode.window.showInputBox({ prompt: 'New folder name' });
        if (!name?.trim()) return;
        const res = addFolder(next, name.trim());
        next = res.layout;
        target = res.id;
      }
      await tree.saveLayout(moveRepos(next, repos.map((r) => r.key), target as string | null));
    }),
    reg('removeFromFolder', async (arg?: unknown, all?: unknown) => {
      const repos = await resolveRepos(arg, all, true);
      if (repos.length) await tree.saveLayout(moveRepos(tree.currentLayout, repos.map((r) => r.key), null));
    }),
    reg('hideRepository', async (arg?: unknown, all?: unknown) => {
      const repos = await resolveRepos(arg, all, true);
      if (!repos.length) return;
      const before = tree.currentLayout;
      await tree.saveLayout(setHidden(before, repos.map((r) => r.key), true));
      void vscode.window.showInformationMessage(`Hid ${repos.length === 1 ? repos[0].name : repos.length + ' repositories'}. Show it again from Edit Layout.`, 'Undo').then((a) => a && tree.saveLayout(before));
    }),
    reg('addRepository', async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Add to CANOPY' });
      if (!uris?.length) return;
      const added = await manager.addRepositories(uris.map((u) => u.fsPath));
      if (!added.length) void vscode.window.showWarningMessage('No Git repositories found in the selected folders.');
      else void vscode.window.setStatusBarMessage(`$(check) Added ${added.map((r) => r.name).join(', ')}`, 4000);
    }),
    reg('cloneRepository', async () => {
      const url = await vscode.window.showInputBox({ prompt: 'Repository URL to clone', placeHolder: 'https://github.com/org/repo.git', validateInput: validateCloneUrl, ignoreFocusOut: true });
      if (!url) return;
      const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: store.baseDir ? vscode.Uri.file(store.baseDir) : undefined, openLabel: 'Clone Here' });
      if (!parent?.length) return;
      const name = await vscode.window.showInputBox({ prompt: 'Folder name', value: repoNameFromUrl(url), validateInput: (v) => (/^[^\\/:*?"<>|]+$/.test(v.trim()) ? undefined : 'Enter a plain folder name') });
      if (!name) return;
      const dest = path.join(parent[0].fsPath, name.trim());
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${repoNameFromUrl(url)}…` }, () =>
          manager.runner.run(['clone', '--', url.trim(), dest], { cwd: parent[0].fsPath, priority: true, timeoutMs: 30 * 60_000 })
        );
      } catch (e) {
        return void vscode.window.showErrorMessage(`Clone failed: ${(e as Error).message}`, 'Show Output').then((a) => a && log.show());
      }
      const [repo] = await manager.addRepositories([dest]);
      if (!repo) return;
      const a = await vscode.window.showInformationMessage(`Cloned ${repo.name}.`, 'Open Details', 'Move to Folder…', 'Add to Workspace');
      if (a === 'Open Details') detail.show(repo);
      else if (a === 'Move to Folder…') await vscode.commands.executeCommand('canopy.moveToFolder', repo);
      else if (a === 'Add to Workspace') await vscode.commands.executeCommand('canopy.addToWorkspace', repo);
    }),

    // --- GitLab & GitHub --------------------------------------------------------------
    ...(['gitlab', 'github'] as const).flatMap((kind) => {
      const svc = forge.get(kind);
      return [
        reg(`${kind}.connect`, async (arg?: unknown) => {
          if (typeof arg === 'string') return svc.connect(arg);
          const r = arg instanceof Repo ? arg : isNode(arg) && arg.kind === 'repo' ? arg.repo : undefined;
          const s = r ? svc.state(r) : undefined;
          return svc.connect(s?.kind === 'disconnected' ? s.host : undefined);
        }),
        reg(`${kind}.disconnect`, () => svc.disconnect()),
        reg(`${kind}.cloneFromGroup`, () => svc.cloneFromGroup('clone')),
        reg(`${kind}.profileFromGroup`, () => svc.cloneFromGroup('profile'))
      ];
    }),
    ...(
      [
        ['createRequest', (p, r) => p.createRequest(r)],
        ['openRequest', (p, r) => p.openRequest(r)],
        ['openPipeline', (p, r) => p.openPipeline(r)],
        ['retryPipeline', (p, r) => p.retryPipeline(r)],
        ['openProject', (p, r) => p.openProject(r)]
      ] as Array<[string, (p: ForgeProvider, r: Repo) => Promise<void>]>
    ).map(([id, fn]) =>
      reg(`forge.${id}`, one(async (r) => {
        const p = forge.providerFor(r);
        if (p) return fn(p, r);
        const a = await vscode.window.showInformationMessage(`${r.name} has no remote on GitLab or GitHub.`, 'Connect GitLab…', 'Sign in to GitHub…');
        if (a === 'Connect GitLab…') await forge.get('gitlab').connect();
        else if (a) await forge.get('github').connect();
      }))
    ),
    reg('forge.refresh', async (arg?: unknown, all?: unknown) => {
      if (arg === undefined) return forge.refreshVisible(true);
      for (const r of await resolveRepos(arg, all, true)) await forge.refresh(r);
    }),
    reg('getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${d.ctx.extension.id}#canopy.getStarted`, false)),

    // --- profiles ------------------------------------------------------------------
    reg('openProfiles', () => profilesPanel.show()),
    reg('importProfile', async () => {
      const p = await profiles.importFromFile();
      if (p) await profilesPanel.show(p, 'import');
    }),
    reg('switchProfile', async () => {
      const list = await profiles.listAll();
      if (!list.length) {
        const a = await vscode.window.showInformationMessage('No saved profiles yet. Save one from the Profiles panel, or add a .canopy-profile.json file to your workspace.', 'Open Profiles');
        if (a) await profilesPanel.show();
        return;
      }
      const active = profiles.activeId;
      const pick = await vscode.window.showQuickPick(
        list.map((e) => ({ label: (e.profile.id === active ? '$(check) ' : '') + e.profile.name, description: `${e.profile.repos.length} repos · ${e.profile.mode === 'pin' ? 'pinned' : 'tracks branches'}`, detail: e.location, p: e.profile })),
        { placeHolder: 'Switch to profile' }
      );
      if (!pick) return;
      const base = profiles.defaultBaseFolder();
      const { steps, summary } = profiles.plan(pick.p, base);
      const detailText = steps.map((s) => `${s.kind.toUpperCase().padEnd(12)} ${s.entry.name}: ${s.detail}`).join('\n');
      const work = steps.filter((s) => !['ok', 'skip', 'blocked'].includes(s.kind)).length;
      if (!work) {
        await store.setActiveProfileId(pick.p.id, pick.p.name);
        return void vscode.window.showInformationMessage(`Already matching "${pick.p.name}". ${summary}`);
      }
      const ok = await vscode.window.showInformationMessage(`Switch to "${pick.p.name}"?`, { modal: true, detail: `${summary}\n\n${detailText}` }, `Run ${work} Steps`);
      if (ok) await profiles.apply(pick.p, base);
    })
  );

  async function askQuery(value: string): Promise<string | undefined> {
    const q = await vscode.window.showInputBox({
      prompt: 'Smart folder query',
      value,
      placeHolder: 'is:conflict OR (is:dirty AND age<7d)',
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v.trim()) return 'Enter a query';
        const err = validateQuery(v);
        if (err) return err;
        const pred = compileQuery(v);
        const n = manager.all.filter((r) => pred(tree.factsOf(r))).length;
        return { message: `Matches ${n} repositories right now`, severity: vscode.InputBoxValidationSeverity.Info };
      }
    });
    return q?.trim() || undefined;
  }

  return disposables;
}


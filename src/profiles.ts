import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Log } from './log';
import { RepoManager } from './manager';
import { Layout, addFolder, folderOfRepo, folderPath, moveRepos, walkFolders } from './model/layout';
import {
  ApplyOptions,
  DEFAULT_APPLY,
  LocalRepoState,
  PlanStep,
  Profile,
  ProfileValidationError,
  decodeShareData,
  encodeShareData,
  joinPath,
  parseProfile,
  planProfile,
  summarizePlan,
  toProfileFile
} from './model/profile';
import { Repo } from './repo';
import { Store } from './store';
import { RepoTree } from './tree';
import { mapLimit } from './util/limit';
import { normalizeRemote } from './util/remote';

export interface EditorRow {
  include: boolean;
  name: string;
  remote: string;
  branch: string;
  path: string;
  folder?: string;
  commit?: string;
  /** Root of the matching local repo, if any. */
  localRoot?: string;
  branches: string[];
}

export interface EditorModel {
  id: string | null;
  /** Set when the profile was loaded from a .canopy-profile.json file in the workspace. */
  fileUri?: string;
  name: string;
  mode: 'track' | 'pin';
  onApply: ApplyOptions;
  rows: EditorRow[];
  source: 'current' | 'profile' | 'import';
  baseFolder: string;
}

/** A saved profile and where it lives. */
export interface ProfileEntry {
  profile: Profile;
  source: 'workspace' | 'file';
  uri?: vscode.Uri;
  /** Where it is stored, for display. */
  location: string;
}

export const PROFILE_FILE_GLOB = '**/*.canopy-profile.json';

export interface StepResult {
  step: PlanStep;
  ok: boolean;
  message: string;
}

/** Clone/switch profiles: building, planning, applying, sharing. */
export class Profiles {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly manager: RepoManager,
    private readonly tree: RepoTree,
    private readonly log: Log
  ) {}

  get list(): Profile[] {
    return this.store.profiles;
  }

  get activeId(): string | undefined {
    return this.store.activeProfileId;
  }

  /** Where "Save in workspace" writes, for display. */
  settingsLocation(): string {
    const wf = vscode.workspace.workspaceFile;
    if (wf?.scheme === 'file') return path.basename(wf.fsPath);
    if (vscode.workspace.workspaceFolders?.length) return '.vscode/settings.json';
    return 'VS Code storage (no folder open)';
  }

  /** Profiles saved in workspace settings plus .canopy-profile.json files anywhere in the workspace. */
  async listAll(): Promise<ProfileEntry[]> {
    const where = this.settingsLocation();
    const entries: ProfileEntry[] = this.list.map((profile) => ({ profile, source: 'workspace' as const, location: where }));
    if (vscode.workspace.workspaceFolders?.length) {
      const files = await vscode.workspace.findFiles(PROFILE_FILE_GLOB, '**/{node_modules,.git,.vscode-test,out,dist}/**', 200);
      for (const uri of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
        const rel = vscode.workspace.asRelativePath(uri, true);
        try {
          const raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
          const profile = parseProfile(raw, 'file:' + uri.toString());
          const stat = await vscode.workspace.fs.stat(uri);
          profile.savedAt = new Date(stat.mtime).toISOString();
          entries.push({ profile, source: 'file', uri, location: rel });
        } catch (e) {
          this.log.warn(`Skipping profile file ${rel}: ${(e as Error).message}`);
        }
      }
    }
    return entries;
  }

  async find(id: string): Promise<ProfileEntry | undefined> {
    return (await this.listAll()).find((e) => e.profile.id === id);
  }

  /** Writes a profile to a .canopy-profile.json file (asks where when `uri` is not given). */
  async saveToFile(p: Profile, uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (!uri) {
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
      const base = this.store.baseDir ?? this.defaultBaseFolder();
      uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(base, `${slug}.canopy-profile.json`)),
        filters: { 'CANOPY profile': ['json'] },
        saveLabel: 'Save Profile',
        title: 'Save the profile as a file (files inside the workspace appear in the Saved list)'
      });
      if (!uri) return undefined;
      if (!uri.path.endsWith('.canopy-profile.json')) uri = uri.with({ path: uri.path.replace(/(\.json)?$/, '.canopy-profile.json') });
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(toProfileFile(p), null, 2) + '\n', 'utf8'));
    return uri;
  }

  defaultBaseFolder(): string {
    return this.store.baseDir ?? path.dirname(this.manager.all[0]?.root ?? process.cwd());
  }

  async save(p: Profile): Promise<Profile> {
    const list = this.list;
    const saved: Profile = { ...p, savedAt: new Date().toISOString() };
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = saved;
    else list.push(saved);
    await this.store.setProfiles(list);
    return saved;
  }

  async remove(id: string): Promise<void> {
    await this.store.setProfiles(this.list.filter((p) => p.id !== id));
    if (this.activeId === id) await this.store.setActiveProfileId(undefined);
  }

  private relPathFor(repo: Repo, base: string): string {
    const rel = path.relative(base, repo.root);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    return repo.name;
  }

  private folderNameFor(repo: Repo, layout: Layout): string | undefined {
    const f = folderOfRepo(layout, repo.key);
    return f ? folderPath(layout, f.id).join('/') : undefined;
  }

  /** Branch names offered in the editor's dropdown for a repo (local + remote, de-duplicated). */
  async branchesOf(repo: Repo): Promise<string[]> {
    try {
      const out = await repo.git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { readOnly: true });
      const names = new Set<string>();
      for (const line of out.split('\n')) {
        if (line.startsWith('refs/heads/')) names.add(line.slice(11));
        else if (line.startsWith('refs/remotes/') && !line.endsWith('/HEAD')) names.add(line.slice(13).split('/').slice(1).join('/'));
      }
      return [...names].filter(Boolean).slice(0, 80);
    } catch {
      return [];
    }
  }

  private async rowForRepo(repo: Repo, base: string, layout: Layout, include: boolean, override?: { branch?: string; path?: string; folder?: string; commit?: string }): Promise<EditorRow> {
    const remote = repo.primaryRemote?.url ?? '';
    const branches = await this.branchesOf(repo);
    const branch = override?.branch ?? repo.branch ?? branches[0] ?? 'main';
    if (!branches.includes(branch)) branches.unshift(branch);
    return {
      include: include && !!remote,
      name: repo.name,
      remote,
      branch,
      path: override?.path ?? this.relPathFor(repo, base),
      folder: override?.folder ?? this.folderNameFor(repo, layout),
      commit: override?.commit ?? repo.status?.oid ?? undefined,
      localRoot: repo.root,
      branches
    };
  }

  /** An editor pre-filled with every visible repo on its current branch. */
  async editorFromCurrent(): Promise<EditorModel> {
    const base = this.defaultBaseFolder();
    const layout = this.store.layout;
    const repos = this.tree.visibleRepos().sort((a, b) => a.name.localeCompare(b.name));
    const rows = await mapLimit(repos, 6, (r) => this.rowForRepo(r, base, layout, true));
    return { id: null, name: 'Untitled profile', mode: 'track', onApply: { ...DEFAULT_APPLY }, rows, source: 'current', baseFolder: base };
  }

  /** An editor for a saved or imported profile; visible repos not in it appear unchecked. */
  async editorFromProfile(p: Profile, source: 'profile' | 'import', fileUri?: string): Promise<EditorModel> {
    const base = this.defaultBaseFolder();
    const layout = this.store.layout;
    const locals = this.localStates();
    const used = new Set<string>();
    const rows: EditorRow[] = [];
    for (const entry of p.repos) {
      const local = locals.find((l) => l.remoteUrls.some((u) => normalizeRemote(u) === normalizeRemote(entry.remote)));
      const repo = local ? this.manager.get(local.key) : undefined;
      if (repo) {
        used.add(repo.key);
        rows.push({ ...(await this.rowForRepo(repo, base, layout, true, entry)), remote: entry.remote, name: entry.name || repo.name });
      } else {
        rows.push({ include: true, name: entry.name, remote: entry.remote, branch: entry.branch, path: entry.path, folder: entry.folder, commit: entry.commit, branches: [entry.branch] });
      }
    }
    for (const repo of this.tree.visibleRepos()) {
      if (!used.has(repo.key)) rows.push(await this.rowForRepo(repo, base, layout, false));
    }
    return { id: source === 'profile' ? p.id : null, fileUri, name: p.name, mode: p.mode, onApply: { ...p.onApply }, rows, source, baseFolder: base };
  }

  /** Validates an editor model into a Profile (throws ProfileValidationError). */
  profileFromEditor(m: EditorModel): Profile {
    const repos = m.rows
      .filter((r) => r.include)
      .map((r) => ({ name: r.name, remote: r.remote, branch: r.branch, path: r.path, ...(m.mode === 'pin' && r.commit ? { commit: r.commit } : {}), ...(r.folder ? { folder: r.folder } : {}) }));
    if (!repos.length) throw new ProfileValidationError('Check at least one repository.');
    return parseProfile({ canopyProfile: 1, name: m.name, mode: m.mode, onApply: m.onApply, repos }, m.id ?? 'p' + Date.now().toString(36));
  }

  localStates(): LocalRepoState[] {
    return this.manager.all.map((r) => ({
      key: r.key,
      root: r.root,
      remoteUrls: [...r.remotes.values()],
      branch: r.branch,
      headHash: r.status?.oid ?? null,
      changed: r.changed,
      behind: r.behind,
      conflicts: r.conflicts.length,
      operation: r.operation
    }));
  }

  plan(p: Profile, baseFolder: string): { steps: PlanStep[]; summary: string } {
    const steps = planProfile(p, this.localStates(), baseFolder, p.onApply);
    return { steps, summary: summarizePlan(steps) };
  }

  async apply(p: Profile, baseFolder: string): Promise<StepResult[]> {
    const { steps } = this.plan(p, baseFolder);
    const work = steps.filter((s) => !['ok', 'skip', 'blocked'].includes(s.kind));
    const results: StepResult[] = steps.filter((s) => !work.includes(s)).map((step) => ({ step, ok: step.kind !== 'blocked', message: step.detail }));
    const cloned: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Switching to "${p.name}"`, cancellable: false }, async (progress) => {
      let done = 0;
      await mapLimit(work, 3, async (step) => {
        progress.report({ message: `${step.entry.name}: ${step.kind}` });
        try {
          const msg = await this.runStep(p, step, baseFolder, cloned);
          results.push({ step, ok: true, message: msg });
        } catch (e) {
          const msg = (e as Error).message;
          this.log.error(`Profile "${p.name}": ${step.entry.name}: ${msg}`);
          results.push({ step, ok: false, message: msg });
        }
        progress.report({ increment: 100 / Math.max(1, work.length), message: `${++done}/${work.length}` });
      });
    });
    if (cloned.length) await this.store.addExtraRepositories(cloned);
    await this.manager.discover();
    await this.manager.refreshAll();
    if (p.onApply.recreateLayout) await this.recreateLayout(p, baseFolder);
    await this.store.setActiveProfileId(p.id, p.name);
    const failed = results.filter((r) => !r.ok);
    const summary = `"${p.name}": ${results.length - failed.length} of ${results.length} repos ready${cloned.length ? `, ${cloned.length} cloned` : ''}.`;
    if (failed.length) {
      const a = await vscode.window.showWarningMessage(`${summary} Problems: ${failed.map((f) => `${f.step.entry.name} (${f.message})`).join('; ')}`, 'Show Output');
      if (a) this.log.show();
    } else {
      void vscode.window.showInformationMessage(summary);
    }
    return results;
  }

  private async runStep(p: Profile, step: PlanStep, baseFolder: string, cloned: string[]): Promise<string> {
    const e = step.entry;
    const run = (cwd: string, args: string[]) => this.manager.runner.run(args, { cwd, priority: true, timeoutMs: 30 * 60_000 });
    if (step.kind === 'clone') {
      const dest = path.resolve(joinPath(baseFolder, e.path));
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} already exists and is not empty`);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await run(path.dirname(dest), ['clone', '--branch', e.branch, '--', e.remote, dest]);
      if (p.mode === 'pin' && e.commit) await run(dest, ['switch', '--detach', e.commit]);
      cloned.push(dest);
      return `cloned into ${dest}`;
    }
    const local = step.local!;
    const repo = this.manager.get(local.key);
    if (!repo) throw new Error('repository disappeared');
    const git = (args: string[]) => run(repo.root, args);
    if ((step.kind === 'stash-switch' || step.kind === 'pin') && local.changed) {
      await git(['stash', 'push', '--include-untracked', '-m', `CANOPY: switching to profile "${p.name}"`]);
    }
    if (step.kind === 'pin') {
      try {
        await git(['cat-file', '-e', `${e.commit}^{commit}`]);
      } catch {
        await git(['fetch', '--all']);
      }
      await git(['switch', '--detach', e.commit!]);
      return `checked out ${e.commit!.slice(0, 8)}`;
    }
    if (step.kind === 'switch' || step.kind === 'stash-switch') {
      try {
        await git(['switch', e.branch]);
      } catch {
        await git(['fetch', '--all']);
        await git(['switch', e.branch]);
      }
    }
    if (p.onApply.pullAfter && (step.kind === 'pull' || step.kind === 'switch' || step.kind === 'stash-switch')) {
      await this.manager.refresh(repo, true);
      if (repo.upstream) await git(['pull', '--ff-only']);
    }
    await this.manager.refresh(repo, true);
    return step.kind === 'pull' ? 'pulled' : `on ${e.branch}`;
  }

  private async recreateLayout(p: Profile, baseFolder: string): Promise<void> {
    let layout = this.store.layout;
    const locals = this.localStates();
    for (const entry of p.repos) {
      if (!entry.folder) continue;
      const repoState = locals.find((l) => l.remoteUrls.some((u) => normalizeRemote(u) === normalizeRemote(entry.remote))) ?? locals.find((l) => l.root.replace(/\\/g, '/').toLowerCase() === joinPath(baseFolder, entry.path).toLowerCase());
      if (!repoState) continue;
      let parentId: string | null = null;
      for (const name of entry.folder.split('/').filter(Boolean)) {
        const siblings: Array<{ id: string; name: string; query?: string }> = parentId
          ? ([...walkFolders(layout.folders)].find((x) => x.folder.id === parentId)?.folder.children ?? [])
          : layout.folders;
        const existing = siblings.find((f) => f.name === name && f.query === undefined);
        if (existing) parentId = existing.id;
        else {
          const res = addFolder(layout, name, parentId);
          layout = res.layout;
          parentId = res.id;
        }
      }
      if (parentId) layout = moveRepos(layout, [repoState.key], parentId);
    }
    await this.store.setLayout(layout);
  }

  // --- sharing ---------------------------------------------------------------

  async exportToFile(p: Profile): Promise<void> {
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
    const base = this.store.baseDir ?? this.defaultBaseFolder();
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(base, `${slug}.canopy-profile.json`)),
      filters: { 'CANOPY profile': ['json'] },
      saveLabel: 'Export Profile'
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(toProfileFile(p), null, 2) + '\n', 'utf8'));
    void vscode.window.showInformationMessage(`Exported "${p.name}" to ${uri.fsPath}.`, 'Reveal').then((a) => a && vscode.commands.executeCommand('revealFileInOS', uri));
  }

  shareLink(p: Profile): string {
    return `${vscode.env.uriScheme}://${this.ctx.extension.id}/profile?data=${encodeShareData(toProfileFile(p))}`;
  }

  async copyShareLink(p: Profile): Promise<void> {
    const link = this.shareLink(p);
    await vscode.env.clipboard.writeText(link);
    void vscode.window.showInformationMessage(`Copied a link for "${p.name}". Anyone with CANOPY installed can open it to review and apply the profile.${link.length > 6000 ? ' The link is long; sharing the exported file may be easier.' : ''}`);
  }

  async importFromFile(): Promise<Profile | undefined> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CANOPY profile': ['json'] }, openLabel: 'Import Profile' });
    if (!uris?.length) return undefined;
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString('utf8');
      return parseProfile(JSON.parse(text));
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not import profile: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Parses a vscode://…/profile?data=… or ?url=https://… link. Never applies anything by itself. */
  async profileFromUri(uri: vscode.Uri): Promise<Profile | undefined> {
    if (uri.path !== '/profile') return undefined;
    const params = new URLSearchParams(uri.query);
    try {
      const data = params.get('data');
      if (data) return parseProfile(decodeShareData(data));
      const url = params.get('url');
      if (url) {
        if (!/^https:\/\//i.test(url)) throw new ProfileValidationError('Only https:// profile links are supported.');
        const ok = await vscode.window.showInformationMessage(`Download a CANOPY profile from ${new URL(url).host}?`, { modal: true, detail: url }, 'Download');
        if (!ok) return undefined;
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > 1_000_000) throw new ProfileValidationError('Profile file is too large.');
        return parseProfile(JSON.parse(text));
      }
      throw new ProfileValidationError('The link does not contain a profile.');
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not open profile link: ${(e as Error).message}`);
      return undefined;
    }
  }
}

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitOps } from '../commands/gitOps';
import { Commit, FileEntry, LOG_FORMAT, parseLog, parseNameStatusZ, parseNumstatZ, withLineStats } from '../git/parse';
import { layoutGraph } from '../git/graph';
import { openChange, openCommitFileDiff, openFile, openHeadDiff, openMergeEditor, openRefDiff } from '../gitContent';
import { Log } from '../log';
import { RepoManager } from '../manager';
import { Repo } from '../repo';
import { RepoTree } from '../tree';
import { listBranches, listStashes } from '../pickers';
import { branchColors } from '../branchColors';
import { webviewHtml } from './webviewUtil';
import { StatsRange, StatsService } from '../stats';
import { folderOfRepo, walkFolders } from '../model/layout';
import type { ForgeHub } from '../forge/hub';
import type { ProfilesPanel } from './profilesPanel';

type Scope = 'all' | 'local' | 'current';

const SHA = /^[0-9a-f]{4,64}$/i;

type LineStats = Map<string, [number, number]>;
interface WipStats {
  head: LineStats;
  staged: LineStats;
  unstaged: LineStats;
}

/** The per-repo details editor: toolbar, changes and commit graph. One panel, retargeted on selection. */
export class DetailPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private repo: Repo | undefined;
  private scope: Scope = 'all';
  private readonly disposables: vscode.Disposable[] = [];
  private postTimer: NodeJS.Timeout | undefined;
  private graphKey = '';
  private graphCache: unknown;
  /** Last render reported by the webview (used by tests and to surface script errors). */
  lastRender: { rows: number; files: number } | undefined;
  private forgeService: ForgeHub | undefined;
  private readonly stats = new StatsService();
  /** Shared profiles editor shown in the Profiles tab. */
  profiles: ProfilesPanel | undefined;
  private profilesView: vscode.Disposable | undefined;
  /** CANOPY version shown in the panel's top-right corner. */
  version = '';

  set forge(service: ForgeHub) {
    this.forgeService = service;
    this.disposables.push(
      service.onDidChange((r) => {
        if (this.panel && this.repo && (!r || r === this.repo)) this.schedulePost();
      })
    );
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
    private readonly ops: GitOps,
    private readonly tree: RepoTree,
    private readonly log: Log
  ) {
    this.disposables.push(
      manager.onDidChange((r) => {
        if (this.panel && this.repo && (!r || r === this.repo)) this.schedulePost();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('canopy.branchColors')) this.schedulePost();
      })
    );
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  get activeRepo(): Repo | undefined {
    return this.panel?.active || this.panel?.visible ? this.repo : undefined;
  }

  show(repo: Repo, preserveFocus = false): void {
    const changed = this.repo !== repo;
    this.repo = repo;
    if (changed) this.graphKey = '';
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('canopy.details', `CANOPY · ${repo.name}`, { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'canopy.svg');
      this.panel.webview.html = webviewHtml(this.panel.webview, this.extensionUri, 'detail.js', 'CANOPY', ['profiles.js']);
      this.profilesView = this.profiles?.attachView((m) => void this.panel?.webview.postMessage({ type: 'profiles', msg: m }));
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.log.error(String(e))), undefined, this.disposables);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.profilesView?.dispose();
        this.profilesView = undefined;
      }, undefined, this.disposables);
      this.panel.onDidChangeViewState(() => {
        if (this.panel?.visible) this.schedulePost();
      }, undefined, this.disposables);
    } else {
      this.panel.reveal(undefined, preserveFocus);
    }
    this.panel.title = `CANOPY · ${repo.name}`;
    if (changed) void this.panel.webview.postMessage({ type: 'switching', name: repo.name });
    this.schedulePost(0);
    void this.manager.refresh(repo);
  }

  private schedulePost(delay = 150): void {
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      void this.post();
    }, delay);
  }

  private async post(): Promise<void> {
    const r = this.repo;
    if (!r || !this.panel) return;
    const [graph, stashes, branchList, wipStats] = await Promise.all([
      this.loadGraph(r),
      listStashes(r).catch(() => []),
      listBranches(r).catch(() => []),
      this.wipLineStats(r).catch((): WipStats => ({ head: new Map(), staged: new Map(), unstaged: new Map() }))
    ]);
    // for-each-ref already sorts newest first; keep that order within local and remote.
    const branches = {
      local: branchList.filter((b) => !b.remote).map((b) => ({ name: b.name, time: b.time, current: b.current, upstream: b.upstream ?? null })),
      remote: branchList.filter((b) => b.remote).map((b) => ({ name: b.name, time: b.time }))
    };
    const folderNames = this.tree.folderNamesOf(r);
    const fs = this.forgeService?.state(r) ?? { kind: 'none' as const };
    const forge =
      fs.kind === 'connected'
        ? { kind: 'connected', provider: fs.provider, readOnly: fs.readOnly, host: fs.info?.host, project: fs.info?.project, pipeline: fs.info?.pipeline, mr: fs.info?.mr, error: fs.info?.error, loading: !fs.info }
        : fs;
    await this.panel.webview.postMessage({
      type: 'state',
      scope: this.scope,
      version: this.version,
      safetyStash: vscode.workspace.getConfiguration('canopy').get<boolean>('discard.safetyStash', true),
      colors: branchColors(),
      branches,
      repo: {
        name: r.name,
        root: r.root,
        crumb: ['CANOPY', ...(folderNames.length ? folderNames : ['Unsorted'])].join('  /  '),
        branch: r.branch,
        branchLabel: r.branchLabel,
        detached: r.detached,
        upstream: r.upstream,
        ahead: r.ahead,
        behind: r.behind,
        operation: r.operation,
        error: r.error,
        lastFetch: r.lastFetch,
        fetching: r.fetching,
        remotes: [...r.remotes.keys()],
        stashCount: stashes.length,
        staged: r.staged,
        unstaged: r.unstaged,
        conflicts: r.conflicts,
        forge
      },
      graph,
      wipStats: { head: Object.fromEntries(wipStats.head), staged: Object.fromEntries(wipStats.staged), unstaged: Object.fromEntries(wipStats.unstaged) }
    });
  }

  private async loadGraph(r: Repo): Promise<unknown> {
    const key = JSON.stringify([r.root, this.scope, r.status?.oid, r.upstream, r.ahead, r.behind, r.lastFetch, r.changed > 0, r.lastCommitTime]);
    if (key === this.graphKey && this.graphCache) return this.graphCache;
    const max = vscode.workspace.getConfiguration('canopy').get<number>('graph.maxCommits', 300);
    const range =
      this.scope === 'all' ? ['--exclude=refs/stash', '--all'] : this.scope === 'local' ? ['--branches', '--tags', 'HEAD'] : ['HEAD', ...(r.upstream ? [r.upstream] : [])];
    let commits: Commit[];
    try {
      const out = await r.git(['log', '--topo-order', `-n${max}`, `--format=${LOG_FORMAT}`, ...range, '--'], { readOnly: true });
      commits = parseLog(out, [...r.remotes.keys()]);
    } catch {
      commits = [];
    }
    if (r.changed > 0 && r.status?.oid) {
      commits.unshift({ hash: '*', parents: [r.status.oid], refs: [], author: '', time: 0, subject: '' });
    }
    const { rows, width } = layoutGraph(commits);
    this.graphCache = {
      width,
      truncated: commits.length >= max,
      rows: commits.map((c, i) => ({
        hash: c.hash,
        short: c.hash === '*' ? '' : c.hash.slice(0, 8),
        refs: c.refs,
        author: c.author,
        time: c.time,
        subject: c.subject,
        lane: rows[i].lane,
        lines: rows[i].lines,
        wip: c.hash === '*',
        head: c.hash === r.status?.oid
      }))
    };
    this.graphKey = key;
    return this.graphCache;
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    const r = this.repo;
    if (m.type === 'ready') return this.schedulePost(0);
    if (m.type === 'rendered') {
      this.lastRender = { rows: Number(m.rows), files: Number(m.files) };
      return;
    }
    if (m.type === 'error') return this.log.error(`Details view script error: ${String(m.message)}`);
    if (m.type === 'profiles' && m.msg && typeof m.msg === 'object') {
      const p = this.profiles;
      if (p) await p.handleMessage(m.msg as { type: string }, (x) => void this.panel?.webview.postMessage({ type: 'profiles', msg: x })).catch((e) => p.fail(e));
      return;
    }
    if (!r) return;
    const paths = Array.isArray(m.paths) ? (m.paths as string[]) : [];
    switch (m.type) {
      case 'cmd': {
        const id = String(m.id);
        try {
          await vscode.commands.executeCommand('canopy.' + id, r);
        } finally {
          // Lets the webview stop the progress animation on the button that started this.
          void this.panel?.webview.postMessage({ type: 'cmdDone', id, root: r.root });
        }
        break;
      }
      case 'stage':
        await this.ops.stage(r, paths.length ? paths : ['.']);
        break;
      case 'unstage':
        await this.ops.unstage(r, paths);
        break;
      case 'discard':
        await this.ops.discard(r, paths.length ? paths : undefined);
        break;
      case 'open': {
        const p = String(m.path);
        if (m.mode === 'file') await openFile(r, p);
        else {
          const list = m.staged ? r.staged : m.conflict ? r.conflicts : r.unstaged;
          const file = list.find((f) => f.path === p);
          if (file) await openChange(r, file, !!m.staged);
          else await openFile(r, p);
        }
        break;
      }
      case 'checkoutBranch': {
        const name = String(m.name ?? '');
        if (name) await this.ops.switchTo(r, m.remote ? 'remote' : 'local', name);
        break;
      }
      case 'mergeEditor':
        await openMergeEditor(r, String(m.path));
        break;
      case 'commit': {
        const mode = String(m.mode ?? 'commit');
        const flags = mode === 'amend' ? ['--amend'] : mode === 'signoff' ? ['--signoff'] : mode === 'noverify' ? ['--no-verify'] : [];
        const after = mode === 'push' ? 'push' : mode === 'sync' ? 'sync' : undefined;
        const ok = await this.ops.commit(r, String(m.message ?? ''), flags, after);
        if (ok) void this.panel?.webview.postMessage({ type: 'committed' });
        break;
      }
      case 'scope':
        this.scope = (['all', 'local', 'current'] as const).includes(m.scope as Scope) ? (m.scope as Scope) : 'all';
        this.graphKey = '';
        this.schedulePost(0);
        break;
      case 'commitFiles': {
        const sha = String(m.sha ?? '');
        if (!SHA.test(sha)) return;
        let files: FileEntry[] = [];
        let error: string | undefined;
        try {
          files = await this.commitFiles(r, sha);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        void this.panel?.webview.postMessage({ type: 'commitFiles', root: r.root, sha, files, error });
        break;
      }
      case 'openCommitFile': {
        const sha = String(m.sha ?? '');
        const file: FileEntry = { path: String(m.path), status: String(m.status ?? 'M'), origPath: typeof m.origPath === 'string' && m.origPath ? m.origPath : undefined };
        if (sha === '*') await openHeadDiff(r, file);
        else if (SHA.test(sha)) await openCommitFileDiff(r, file.path, sha, file.status, file.origPath);
        break;
      }
      case 'stats':
        await this.postStats(r, (['3m', '1y', 'all'] as const).includes(m.range as StatsRange) ? (m.range as StatsRange) : '1y', m.scope === 'folder' ? 'folder' : 'repo');
        break;
      case 'commitAction':
        await this.commitAction(r, String(m.action), String(m.sha), typeof m.ref === 'string' ? m.ref : undefined);
        break;
      case 'refresh':
        this.graphKey = '';
        await this.manager.refresh(r);
        this.schedulePost(0);
        break;
    }
  }

  /** The repo's CANOPY folder (including subfolders) and the loaded repos in it. */
  private folderOf(r: Repo): { name: string; repos: Repo[] } | undefined {
    const f = folderOfRepo(this.tree.currentLayout, r.key);
    if (!f) return undefined;
    const keys = new Set(f.repos);
    for (const { folder } of walkFolders(f.children)) folder.repos.forEach((k) => keys.add(k));
    const repos = [...keys].map((k) => this.manager.get(k)).filter((x): x is Repo => !!x && x.loaded);
    return { name: f.name, repos };
  }

  private async postStats(r: Repo, range: StatsRange, scope: 'repo' | 'folder'): Promise<void> {
    const folder = this.folderOf(r);
    const repos = scope === 'folder' && folder && folder.repos.length > 1 ? folder.repos : [r];
    const effective = repos.length > 1 ? 'folder' : 'repo';
    const base = { type: 'stats', root: r.root, range, scope: effective, folder: folder && folder.repos.length > 1 ? { name: folder.name, count: folder.repos.length } : null };
    try {
      const data = await this.stats.summary(repos, range);
      if (this.repo !== r) return;
      void this.panel?.webview.postMessage({ ...base, data, ownership: effective === 'repo' ? this.stats.ownership(r) ?? null : null });
    } catch (e) {
      if (this.repo !== r) return;
      void this.panel?.webview.postMessage({ ...base, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (effective === 'repo') {
      this.stats.startOwnership(
        r,
        (ownership) => {
          if (this.repo === r) void this.panel?.webview.postMessage({ type: 'statsOwners', root: r.root, ownership });
        },
        () => this.repo === r && !!this.panel
      );
    }
  }

  /** Files a commit changed, with line counts, against its first parent (so merges list what they brought in). */
  private async commitFiles(r: Repo, sha: string): Promise<FileEntry[]> {
    const diff = (format: string) => r.git(['diff-tree', '-r', '-z', format, '-M', '--root', '--no-commit-id', '--diff-merges=first-parent', sha, '--'], { readOnly: true });
    const [names, stats] = await Promise.all([diff('--name-status'), diff('--numstat').catch(() => '')]);
    return withLineStats(parseNameStatusZ(names), parseNumstatZ(stats));
  }

  /**
   * Lines added / deleted per uncommitted file: `head` is everything against HEAD (graph row), `staged`
   * is index vs HEAD and `unstaged` is working tree vs index (Changes list). Untracked files count as all added.
   */
  private async wipLineStats(r: Repo): Promise<WipStats> {
    const none: WipStats = { head: new Map(), staged: new Map(), unstaged: new Map() };
    if (!r.changed) return none;
    const numstat = async (args: string[]) => parseNumstatZ(await r.git(['diff', '-z', '--numstat', '-M', ...args, '--'], { readOnly: true }).catch(() => ''));
    const [head, staged, unstaged] = await Promise.all([r.status?.oid ? numstat(['HEAD']) : numstat(['--cached']), numstat(['--cached']), numstat([])]);
    const untracked = r.unstaged.filter((f) => f.status === 'U' && !f.path.endsWith('/')).slice(0, 200);
    await Promise.all(
      untracked.map(async (f) => {
        const abs = path.join(r.root, f.path);
        const st = await fsp.stat(abs).catch(() => undefined);
        if (!st?.isFile() || st.size > 2_000_000) return;
        const buf = await fsp.readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) return; // binary
        let lines = 0;
        for (const b of buf) if (b === 10) lines++;
        if (buf.length && buf[buf.length - 1] !== 10) lines++;
        head.set(f.path, [lines, 0]);
        unstaged.set(f.path, [lines, 0]);
      })
    );
    return { head, staged, unstaged };
  }

  private async commitAction(r: Repo, action: string, sha: string, ref?: string): Promise<void> {
    if (!SHA.test(sha)) return;
    const target = ref ?? sha;
    switch (action) {
      case 'checkout':
        return this.ops.checkoutDetached(r, sha);
      case 'checkoutRef':
        if (ref) await this.ops.switchTo(r, ref.includes('/') && [...r.remotes.keys()].some((x) => ref.startsWith(x + '/')) ? 'remote' : 'local', ref);
        return;
      case 'branch':
        return this.ops.createBranchAt(r, sha);
      case 'tag':
        return this.ops.createTag(r, sha);
      case 'cherryPick':
        return this.ops.cherryPickSha(r, sha);
      case 'revert':
        return this.ops.revertSha(r, sha);
      case 'merge':
        return this.ops.mergeRef(r, target);
      case 'rebase':
        return this.ops.rebaseOntoRef(r, target);
      case 'rebaseInteractive':
        return this.ops.interactiveRebaseFrom(r, sha);
      case 'resetSoft':
        return this.ops.resetSha(r, sha, 'soft');
      case 'resetMixed':
        return this.ops.resetSha(r, sha, 'mixed');
      case 'resetHard':
        return this.ops.resetSha(r, sha, 'hard');
      case 'copy':
        await vscode.env.clipboard.writeText(sha);
        void vscode.window.setStatusBarMessage(`Copied ${sha.slice(0, 8)}`, 2500);
        return;
      case 'compare': {
        const files = parseNameStatusZ(await r.git(['diff', '-z', '--name-status', '-M', sha, '--'], { readOnly: true }));
        if (!files.length) return void vscode.window.showInformationMessage('No differences from the working tree.');
        const pick = await vscode.window.showQuickPick(
          files.map((f) => ({ label: f.path, description: f.status, f })),
          { placeHolder: `Files that differ between ${sha.slice(0, 8)} and the working tree`, matchOnDescription: true }
        );
        if (pick) await openRefDiff(r, pick.f.path, sha, sha.slice(0, 8));
        return;
      }
    }
  }
}

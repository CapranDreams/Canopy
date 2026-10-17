import * as vscode from 'vscode';
import { GitOps } from '../commands/gitOps';
import { Commit, LOG_FORMAT, parseLog } from '../git/parse';
import { layoutGraph } from '../git/graph';
import { openChange, openCommitFileDiff, openFile, openMergeEditor, openRefDiff } from '../gitContent';
import { Log } from '../log';
import { RepoManager } from '../manager';
import { Repo } from '../repo';
import { RepoTree } from '../tree';
import { listBranches, listStashes } from '../pickers';
import { branchColors } from '../branchColors';
import { webviewHtml } from './webviewUtil';
import type { ForgeHub } from '../forge/hub';

type Scope = 'all' | 'local' | 'current';

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
      this.panel.webview.html = webviewHtml(this.panel.webview, this.extensionUri, 'detail.js', 'CANOPY');
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.log.error(String(e))), undefined, this.disposables);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
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
    const [graph, stashes, branchList] = await Promise.all([this.loadGraph(r), listStashes(r).catch(() => []), listBranches(r).catch(() => [])]);
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
      graph
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
    if (!r) return;
    const paths = Array.isArray(m.paths) ? (m.paths as string[]) : [];
    switch (m.type) {
      case 'cmd':
        await vscode.commands.executeCommand('canopy.' + String(m.id), r);
        break;
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

  private async commitAction(r: Repo, action: string, sha: string, ref?: string): Promise<void> {
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) return;
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
      case 'files':
      case 'compare': {
        const compare = action === 'compare';
        const out = await r.git(compare ? ['diff', '--name-status', sha] : ['show', '--name-status', '--format=', sha], { readOnly: true });
        const files = out
          .split('\n')
          .map((l) => l.split('\t'))
          .filter((p) => p.length >= 2)
          .map(([st, a, b]) => ({ status: st[0], path: b ?? a }));
        if (!files.length) return void vscode.window.showInformationMessage(compare ? 'No differences from the working tree.' : 'This commit changes no files.');
        const pick = await vscode.window.showQuickPick(
          files.map((f) => ({ label: f.path, description: f.status, f })),
          { placeHolder: compare ? `Files that differ between ${sha.slice(0, 8)} and the working tree` : `Files changed in ${sha.slice(0, 8)}`, matchOnDescription: true }
        );
        if (!pick) return;
        if (compare) await openRefDiff(r, pick.f.path, sha, sha.slice(0, 8));
        else await openCommitFileDiff(r, pick.f.path, sha, pick.f.status);
        return;
      }
    }
  }
}

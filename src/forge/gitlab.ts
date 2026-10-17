import * as vscode from 'vscode';
import { GitOps } from '../commands/gitOps';
import { Log } from '../log';
import { RepoManager } from '../manager';
import { Profile, parseProfile } from '../model/profile';
import { ProfilesPanel } from '../panels/profilesPanel';
import { Profiles } from '../profiles';
import { Repo } from '../repo';
import { Store } from '../store';
import { Limiter } from '../util/limit';
import { normalizeRemote } from '../util/remote';
import { GitLabClient, GitLabError, GitLabGroup, GitLabProject } from './gitlabApi';
import { ForgeInfo, ForgeProvider, ForgeState } from './types';
import { GitLabInstance, RemoteMatch, instanceHost, matchRemote, normalizeInstanceUrl, suggestHosts, tokenPageUrl, validateInstanceUrl } from './instances';

export type { ForgeInfo, ForgeState } from './types';

const SECRET_PREFIX = 'canopy.gitlab.token:';
const RUNNING = ['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled'];

/** GitLab integration for any configured server (gitlab.com or self-hosted). */
export class GitLabService implements ForgeProvider {
  readonly kind = 'gitlab' as const;
  readonly label = 'GitLab';
  private readonly _onDidChange = new vscode.EventEmitter<Repo | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private readonly infos = new Map<string, ForgeInfo>();
  private readonly tokens = new Map<string, string>();
  private readonly projects = new Map<string, { id: number; webUrl: string; defaultBranch: string | null; at: number }>();
  private readonly limiter = new Limiter(4);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly rejected = new Set<string>();
  private readonly snoozed = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private promptTimer: NodeJS.Timeout | undefined;
  private prompting = false;
  profiles!: Profiles;
  profilesPanel!: ProfilesPanel;
  visibleRepos: () => Repo[] = () => this.manager.all;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly manager: RepoManager,
    private readonly store: Store,
    private readonly ops: GitOps,
    private readonly log: Log
  ) {
    this.disposables.push(
      this._onDidChange,
      manager.onDidChange((repo) => {
        if (repo) this.onRepoChanged(repo);
        else this.schedulePrompt();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('canopy.gitlab')) {
          this.startTimer();
          void this.loadTokens().then(() => this.refreshVisible(true));
        }
      }),
      ctx.secrets.onDidChange((e) => {
        if (e.key.startsWith(SECRET_PREFIX)) void this.loadTokens().then(() => this.refreshVisible(true));
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.refreshVisible(false);
      })
    );
    this.startTimer();
    void this.loadTokens();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.promptTimer) clearTimeout(this.promptTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // --- configuration & tokens ---------------------------------------------------

  instances(): GitLabInstance[] {
    const raw = vscode.workspace.getConfiguration('canopy').get<unknown[]>('gitlab.instances', []);
    const list: GitLabInstance[] = [];
    for (const r of Array.isArray(raw) ? raw : []) {
      const o = (typeof r === 'string' ? { url: r } : r) as GitLabInstance;
      if (o && typeof o.url === 'string' && !validateInstanceUrl(o.url) && !list.some((x) => normalizeInstanceUrl(x.url) === normalizeInstanceUrl(o.url))) {
        list.push({ url: normalizeInstanceUrl(o.url), name: o.name, sshHosts: Array.isArray(o.sshHosts) ? o.sshHosts.filter((h) => typeof h === 'string') : undefined });
      }
    }
    return list;
  }

  private async loadTokens(): Promise<void> {
    this.tokens.clear();
    for (const inst of this.instances()) {
      const t = await this.ctx.secrets.get(SECRET_PREFIX + inst.url);
      if (t) this.tokens.set(inst.url, t);
    }
    void vscode.commands.executeCommand('setContext', 'canopy.gitlab.connected', this.tokens.size > 0);
  }

  isConnected(inst: GitLabInstance): boolean {
    return this.tokens.has(normalizeInstanceUrl(inst.url));
  }

  private isReadOnly(inst: GitLabInstance): boolean {
    return (this.ctx.globalState.get<string[]>('canopy.gitlab.readOnly') ?? []).includes(normalizeInstanceUrl(inst.url));
  }

  private client(inst: GitLabInstance): GitLabClient | undefined {
    const token = this.tokens.get(normalizeInstanceUrl(inst.url));
    return token ? new GitLabClient(inst.url, token) : undefined;
  }

  /** Finds which remote of `repo` lives on a configured instance (the primary remote wins). */
  match(repo: Repo): (RemoteMatch & { remoteName: string }) | undefined {
    const instances = this.instances();
    const remotes = [...repo.remotes.entries()];
    const primary = repo.primaryRemote?.name;
    remotes.sort(([a], [b]) => (a === primary ? -1 : b === primary ? 1 : 0));
    for (const [name, url] of remotes) {
      const m = matchRemote(url, instances);
      if (m) return { ...m, remoteName: name };
    }
    return undefined;
  }

  state(repo: Repo): ForgeState {
    const m = this.match(repo);
    if (m) {
      if (!this.isConnected(m.instance)) return { kind: 'disconnected', provider: 'gitlab', host: instanceHost(m.instance) };
      return { kind: 'connected', provider: 'gitlab', info: this.infos.get(repo.key), readOnly: this.isReadOnly(m.instance) };
    }
    const suggested = suggestHosts([...repo.remotes.values()], this.instances());
    const host = [...suggested.keys()][0];
    return host ? { kind: 'disconnected', provider: 'gitlab', host } : { kind: 'none' };
  }

  info(repo: Repo): ForgeInfo | undefined {
    const m = this.match(repo);
    return m && this.isConnected(m.instance) ? this.infos.get(repo.key) : undefined;
  }

  // --- refreshing ---------------------------------------------------------------

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    const minutes = Math.max(1, vscode.workspace.getConfiguration('canopy').get<number>('gitlab.refreshMinutes', 3));
    this.timer = setInterval(() => {
      if (vscode.window.state.focused) this.refreshVisible(false);
    }, minutes * 60_000);
  }

  private stateKeyOf(repo: Repo): string {
    return [repo.branch, repo.status?.oid, repo.upstream, repo.ahead, repo.lastFetch].join('|');
  }

  private onRepoChanged(repo: Repo): void {
    const prev = this.infos.get(repo.key);
    if (!prev || prev.stateKey !== this.stateKeyOf(repo)) void this.refresh(repo);
  }

  refreshVisible(force: boolean): void {
    const maxAge = Math.max(1, vscode.workspace.getConfiguration('canopy').get<number>('gitlab.refreshMinutes', 3)) * 60_000;
    for (const r of this.visibleRepos()) {
      const prev = this.infos.get(r.key);
      if (force || !prev || Date.now() - prev.fetchedAt > maxAge) void this.refresh(r);
    }
  }

  async refresh(repo: Repo): Promise<ForgeInfo | undefined> {
    const m = this.match(repo);
    if (!m || !this.isConnected(m.instance) || !repo.loaded) return undefined;
    const client = this.client(m.instance)!;
    return this.limiter.run(async () => {
      const info: ForgeInfo = {
        provider: 'gitlab',
        instanceUrl: m.instance.url,
        host: instanceHost(m.instance),
        projectPath: m.projectPath,
        remoteName: m.remoteName,
        fetchedAt: Date.now(),
        stateKey: this.stateKeyOf(repo)
      };
      try {
        const projKey = m.instance.url + '|' + m.projectPath;
        let proj = this.projects.get(projKey);
        if (!proj || Date.now() - proj.at > 30 * 60_000) {
          const p = await client.project(m.projectPath);
          proj = { id: p.id, webUrl: p.web_url, defaultBranch: p.default_branch, at: Date.now() };
          this.projects.set(projKey, proj);
        }
        info.project = { id: proj.id, webUrl: proj.webUrl, defaultBranch: proj.defaultBranch };
        const branch = repo.branch ?? undefined;
        const [pipe, mr] = await Promise.all([
          client.latestPipeline(proj.id, branch ? { branch } : { sha: repo.status?.oid ?? undefined }).catch(() => undefined),
          branch ? client.openMergeRequest(proj.id, branch).catch(() => undefined) : Promise.resolve(undefined)
        ]);
        if (pipe) info.pipeline = { id: pipe.id, status: pipe.status, sha: pipe.sha, webUrl: pipe.web_url, ref: pipe.ref, isHead: pipe.sha === repo.status?.oid };
        if (mr) {
          const appr = await client.approvals(proj.id, mr.iid);
          info.mr = {
            iid: mr.iid,
            title: mr.title,
            webUrl: mr.web_url,
            draft: !!(mr.draft ?? mr.work_in_progress),
            hasConflicts: mr.has_conflicts,
            status: mr.detailed_merge_status ?? mr.merge_status ?? '',
            targetBranch: mr.target_branch,
            approved: appr?.approved,
            approvalsLeft: appr?.approvals_left,
            approvedBy: appr?.approved_by?.map((a) => a.user.username)
          };
        }
        this.rejected.delete(m.instance.url);
      } catch (e) {
        info.error = (e as Error).message;
        if (e instanceof GitLabError && e.status === 401) this.onRejected(m.instance);
        else this.log.warn(`GitLab ${m.projectPath}: ${info.error}`);
      }
      this.infos.set(repo.key, info);
      this._onDidChange.fire(repo);
      return info;
    });
  }

  private onRejected(inst: GitLabInstance): void {
    if (this.rejected.has(inst.url)) return;
    this.rejected.add(inst.url);
    void vscode.window
      .showWarningMessage(`CANOPY: ${instanceHost(inst)} rejected the saved access token (expired or revoked).`, 'Reconnect…')
      .then((a) => a && this.connect(inst.url));
  }

  // --- connecting -----------------------------------------------------------------

  private schedulePrompt(): void {
    if (this.promptTimer) clearTimeout(this.promptTimer);
    this.promptTimer = setTimeout(() => void this.maybePromptToConnect(), 2500);
  }

  /** Suggests connecting when repos use a GitLab server that has no token yet. */
  async maybePromptToConnect(): Promise<void> {
    if (this.prompting || !vscode.workspace.getConfiguration('canopy').get<boolean>('gitlab.promptToConnect', true)) return;
    const dismissed = new Set(this.ctx.globalState.get<string[]>('canopy.gitlab.dismissed') ?? []);
    const counts = new Map<string, number>();
    for (const r of this.manager.all) {
      const s = this.state(r);
      if (s.kind === 'disconnected') counts.set(s.host, (counts.get(s.host) ?? 0) + 1);
    }
    const host = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h).find((h) => !dismissed.has(h) && !this.snoozed.has(h));
    if (!host) return;
    this.prompting = true;
    try {
      const n = counts.get(host)!;
      const a = await vscode.window.showInformationMessage(
        `${n} of your repositories are on ${host}. Connect CANOPY to see pipelines and merge requests?`,
        'Connect…',
        'Not Now',
        "Don't Ask Again"
      );
      if (a === 'Connect…') await this.connect(host);
      else if (a === "Don't Ask Again") await this.ctx.globalState.update('canopy.gitlab.dismissed', [...dismissed, host]);
      else this.snoozed.add(host);
    } finally {
      this.prompting = false;
    }
  }

  /** Guided setup: choose the server, create a token on it, paste it, verify it, store it securely. */
  async connect(hostOrUrl?: string): Promise<boolean> {
    const url = await this.pickServer(hostOrUrl);
    if (!url) return false;
    const inst: GitLabInstance = this.instances().find((i) => i.url === url) ?? { url };
    const host = instanceHost(inst);

    let open: string | undefined = await vscode.window.showInformationMessage(
      `Connect CANOPY to ${host}`,
      {
        modal: true,
        detail:
          'CANOPY uses a GitLab personal access token to show pipelines and merge requests and to create merge requests.\n\n' +
          '1. Open the token page. CANOPY fills in the name "CANOPY" and the "api" scope.\n' +
          '2. Choose an expiry date and select "Create token".\n' +
          '3. Copy the token and paste it in the next step.\n\n' +
          'Choose the "read_api" scope instead if you only want to see status.\n\n' +
          "The token is kept in VS Code's encrypted secret storage on this computer. It is never written to settings or workspace files, and is only sent to " +
          host +
          '.'
      },
      'Open Token Page',
      'I Already Have a Token'
    );
    if (!open) return false;
    for (;;) {
      if (open === 'Open Token Page') await vscode.env.openExternal(vscode.Uri.parse(tokenPageUrl(inst)));
      const token = await vscode.window.showInputBox({
        title: `Connect to ${host} (step 2 of 2)`,
        prompt: `Paste your ${host} personal access token`,
        placeHolder: 'glpat-…',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length < 10 ? 'That looks too short for an access token.' : /\s/.test(v.trim()) ? 'Tokens do not contain spaces.' : undefined)
      });
      if (!token) return false;
      const client = new GitLabClient(inst.url, token.trim());
      try {
        const [user, info] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking the token with ${host}…` }, () =>
          Promise.all([client.currentUser(), client.tokenInfo()])
        );
        await this.ctx.secrets.store(SECRET_PREFIX + inst.url, token.trim());
        const readOnly = !!info && !info.scopes.includes('api');
        const ro = new Set(this.ctx.globalState.get<string[]>('canopy.gitlab.readOnly') ?? []);
        if (readOnly) ro.add(inst.url);
        else ro.delete(inst.url);
        await this.ctx.globalState.update('canopy.gitlab.readOnly', [...ro]);
        if (!this.instances().some((i) => i.url === inst.url)) {
          const cfg = vscode.workspace.getConfiguration('canopy');
          const current = cfg.inspect<unknown[]>('gitlab.instances')?.globalValue ?? [];
          await cfg.update('gitlab.instances', [...current, { url: inst.url }], vscode.ConfigurationTarget.Global);
        }
        this.rejected.delete(inst.url);
        await this.loadTokens();
        const expires = info?.expires_at ? ` The token expires on ${info.expires_at}.` : '';
        void vscode.window.showInformationMessage(
          `Connected to ${host} as @${user.username}.${readOnly ? ' The token is read-only, so creating merge requests is turned off.' : ''}${expires}`
        );
        this.refreshVisible(true);
        return true;
      } catch (e) {
        const err = e as GitLabError;
        const msg =
          err.status === 0
            ? `${err.message} If ${host} uses a company certificate, make sure your computer trusts it (VS Code setting "http.systemCertificates") and that VS Code's proxy settings are right.`
            : err.message;
        const again = await vscode.window.showErrorMessage(`Could not connect to ${host}: ${msg}`, 'Try Again', 'Open Token Page');
        if (!again) return false;
        open = again;
      }
    }
  }

  private async pickServer(hostOrUrl?: string): Promise<string | undefined> {
    if (hostOrUrl) {
      const url = /^https?:\/\//.test(hostOrUrl) ? normalizeInstanceUrl(hostOrUrl) : `https://${hostOrUrl}`;
      if (!validateInstanceUrl(url)) return url;
    }
    const instances = this.instances();
    const suggested = suggestHosts(this.manager.all.flatMap((r) => [...r.remotes.values()]), instances);
    type Item = vscode.QuickPickItem & { url?: string; other?: boolean };
    const items: Item[] = [];
    for (const [host, n] of [...suggested.entries()].sort((a, b) => b[1] - a[1])) {
      items.push({ label: `$(server) ${host}`, description: `${n} repositor${n === 1 ? 'y uses' : 'ies use'} this server`, url: `https://${host}` });
    }
    for (const i of instances) {
      items.push({ label: `$(server) ${instanceHost(i)}`, description: this.isConnected(i) ? 'connected (replace token)' : 'not connected', url: i.url });
    }
    if (!items.some((i) => i.url === 'https://gitlab.com')) items.push({ label: '$(globe) gitlab.com', url: 'https://gitlab.com' });
    items.push({ label: '$(add) Other GitLab server…', other: true });
    const pick = await vscode.window.showQuickPick(items, { title: 'Connect GitLab (step 1 of 2)', placeHolder: 'Which GitLab server?' });
    if (!pick) return undefined;
    if (!pick.other) return pick.url;
    const typed = await vscode.window.showInputBox({
      title: 'Connect GitLab (step 1 of 2)',
      prompt: 'GitLab server URL',
      placeHolder: 'https://gitlab.example.com',
      ignoreFocusOut: true,
      validateInput: validateInstanceUrl
    });
    return typed ? normalizeInstanceUrl(typed) : undefined;
  }

  async disconnect(): Promise<void> {
    const connected = this.instances().filter((i) => this.isConnected(i));
    if (!connected.length) return void vscode.window.showInformationMessage('No GitLab servers are connected.');
    const pick = await vscode.window.showQuickPick(connected.map((i) => ({ label: instanceHost(i), i })), { placeHolder: 'Disconnect which GitLab server? (its token is deleted from this computer)' });
    if (!pick) return;
    await this.ctx.secrets.delete(SECRET_PREFIX + pick.i.url);
    for (const [k, v] of this.infos) if (v.instanceUrl === pick.i.url) this.infos.delete(k);
    await this.loadTokens();
    this._onDidChange.fire(undefined);
    void vscode.window.showInformationMessage(`Disconnected ${pick.label}. Revoke the token on the server too if you no longer need it.`);
  }

  /** For tests: store a token without the interactive flow. */
  async setToken(url: string, token: string): Promise<void> {
    await this.ctx.secrets.store(SECRET_PREFIX + normalizeInstanceUrl(url), token);
    await this.loadTokens();
  }

  // --- repo actions -----------------------------------------------------------------

  private async requireConnected(repo: Repo): Promise<{ client: GitLabClient; info: ForgeInfo; match: RemoteMatch & { remoteName: string } } | undefined> {
    let m = this.match(repo);
    if (!m || !this.isConnected(m.instance)) {
      const s = this.state(repo);
      if (s.kind === 'none') {
        void vscode.window.showInformationMessage(`${repo.name} has no remote on a GitLab server CANOPY knows about.`, 'Connect GitLab…').then((a) => a && this.connect());
        return undefined;
      }
      const host = s.kind === 'disconnected' ? s.host : undefined;
      if (!(await this.connect(host))) return undefined;
      m = this.match(repo);
      if (!m) return undefined;
    }
    const info = (await this.refresh(repo)) ?? this.infos.get(repo.key);
    if (!info?.project) {
      void vscode.window.showErrorMessage(`CANOPY could not load ${m.projectPath} from ${instanceHost(m.instance)}${info?.error ? `: ${info.error}` : '.'}`);
      return undefined;
    }
    return { client: this.client(m.instance)!, info, match: m };
  }

  createRequest(repo: Repo): Promise<void> {
    return this.createMergeRequest(repo);
  }

  openRequest(repo: Repo): Promise<void> {
    return this.openMergeRequest(repo);
  }

  async openMergeRequest(repo: Repo): Promise<void> {
    const c = await this.requireConnected(repo);
    if (!c) return;
    if (c.info.mr) return void vscode.env.openExternal(vscode.Uri.parse(c.info.mr.webUrl));
    const a = await vscode.window.showInformationMessage(`${repo.branchLabel} has no open merge request.`, 'Create Merge Request…');
    if (a) await this.createMergeRequest(repo);
  }

  async openPipeline(repo: Repo): Promise<void> {
    const c = await this.requireConnected(repo);
    if (!c) return;
    const url = c.info.pipeline?.webUrl ?? `${c.info.project!.webUrl}/-/pipelines`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async openProject(repo: Repo): Promise<void> {
    const c = await this.requireConnected(repo);
    if (c) await vscode.env.openExternal(vscode.Uri.parse(c.info.project!.webUrl));
  }

  async retryPipeline(repo: Repo): Promise<void> {
    const c = await this.requireConnected(repo);
    if (!c) return;
    const p = c.info.pipeline;
    if (!p) return void vscode.window.showInformationMessage(`No pipeline found for ${repo.branchLabel}.`);
    if (RUNNING.includes(p.status)) return void vscode.window.showInformationMessage(`Pipeline #${p.id} is still ${p.status}.`);
    try {
      await c.client.retryPipeline(c.info.project!.id, p.id);
      void vscode.window.setStatusBarMessage(`$(sync) Retrying pipeline #${p.id}`, 4000);
      setTimeout(() => void this.refresh(repo), 3000);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not retry pipeline #${p.id}: ${(e as Error).message}`);
    }
  }

  async createMergeRequest(repo: Repo): Promise<void> {
    const c = await this.requireConnected(repo);
    if (!c) return;
    const inst = c.match.instance;
    if (this.isReadOnly(inst)) {
      const a = await vscode.window.showWarningMessage(`The ${instanceHost(inst)} token is read-only (read_api). Reconnect with an "api" token to create merge requests.`, 'Reconnect…');
      if (a) await this.connect(inst.url);
      return;
    }
    const branch = repo.branch;
    if (!branch) return void vscode.window.showWarningMessage('Check out a branch first.');
    const def = c.info.project!.defaultBranch;
    if (branch === def) {
      const a = await vscode.window.showWarningMessage(`You are on ${def}, the default branch. Create a branch for your change first.`, 'Create Branch…');
      if (a) await vscode.commands.executeCommand('canopy.createBranch', repo);
      return;
    }
    if (c.info.mr) {
      const a = await vscode.window.showInformationMessage(`${branch} already has merge request !${c.info.mr.iid}.`, 'Open');
      if (a) await vscode.env.openExternal(vscode.Uri.parse(c.info.mr.webUrl));
      return;
    }
    const remote = c.match.remoteName;
    const needsPush = !repo.upstream || repo.ahead > 0 || !repo.upstream.startsWith(remote + '/');
    if (needsPush) {
      const a = await vscode.window.showInformationMessage(
        `${branch} ${repo.upstream ? `has ${repo.ahead} unpushed commit(s)` : `is not on ${remote} yet`}. Push it before creating the merge request?`,
        { modal: true },
        'Push'
      );
      if (!a) return;
      if ((await this.ops.exec(repo, ['push', '-u', remote, branch], { title: `Push ${branch}`, notify: true })) === undefined) return;
    }
    const targets = await this.remoteBranches(repo, remote);
    const ordered = [...new Set([def, ...targets].filter((b): b is string => !!b && b !== branch))];
    const target = await vscode.window.showQuickPick(ordered.map((b) => ({ label: b, description: b === def ? 'default branch' : undefined })), { title: 'Create merge request (1/3)', placeHolder: `Merge ${branch} into…` });
    if (!target) return;
    const commits = (await repo.git(['log', '--format=%s', '-n50', `${remote}/${target.label}..HEAD`], { readOnly: true }).catch(() => ''))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const defaultTitle = commits.length === 1 ? commits[0] : humanizeBranch(branch);
    const title = await vscode.window.showInputBox({ title: 'Create merge request (2/3)', prompt: 'Title', value: defaultTitle, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Enter a title') });
    if (!title) return;
    const opts = await vscode.window.showQuickPick(
      [
        { label: 'Mark as draft', key: 'draft', picked: false },
        { label: 'Delete source branch when merged', key: 'remove', picked: true },
        { label: 'Squash commits when merged', key: 'squash', picked: false }
      ],
      { title: 'Create merge request (3/3)', placeHolder: 'Options (press Enter to create)', canPickMany: true }
    );
    if (!opts) return;
    const has = (k: string) => opts.some((o) => o.key === k);
    const mr = await this.createMergeRequestFor(repo, {
      targetBranch: target.label,
      title: title.trim(),
      description: commits.length ? commits.map((s) => `- ${s}`).join('\n') : undefined,
      draft: has('draft'),
      removeSourceBranch: has('remove'),
      squash: has('squash')
    });
    if (!mr) return;
    const a = await vscode.window.showInformationMessage(`Created merge request !${mr.iid}: ${mr.title}`, 'Open in Browser', 'Copy Link');
    if (a === 'Open in Browser') await vscode.env.openExternal(vscode.Uri.parse(mr.webUrl));
    else if (a === 'Copy Link') await vscode.env.clipboard.writeText(mr.webUrl);
  }

  /** Creates the merge request without prompts (the branch must already be pushed). */
  async createMergeRequestFor(repo: Repo, o: { targetBranch: string; title: string; description?: string; draft?: boolean; removeSourceBranch?: boolean; squash?: boolean }): Promise<{ iid: number; title: string; webUrl: string } | undefined> {
    const m = this.match(repo);
    const info = this.infos.get(repo.key) ?? (await this.refresh(repo));
    if (!m || !info?.project || !repo.branch) return undefined;
    try {
      const mr = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creating merge request…' }, () =>
        this.client(m.instance)!.createMergeRequest(info.project!.id, { sourceBranch: repo.branch!, ...o })
      );
      await this.refresh(repo);
      return { iid: mr.iid, title: mr.title, webUrl: mr.web_url };
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not create the merge request: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async remoteBranches(repo: Repo, remote: string): Promise<string[]> {
    const out = await repo.git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)', `refs/remotes/${remote}`], { readOnly: true }).catch(() => '');
    return out
      .split('\n')
      .map((l) => l.trim().replace(`refs/remotes/${remote}/`, ''))
      .filter((b) => b && b !== 'HEAD');
  }

  // --- groups -------------------------------------------------------------------------

  private async pickConnectedInstance(): Promise<GitLabInstance | undefined> {
    let connected = this.instances().filter((i) => this.isConnected(i));
    if (!connected.length) {
      const a = await vscode.window.showInformationMessage('Connect a GitLab server first.', 'Connect GitLab…');
      if (!a || !(await this.connect())) return undefined;
      connected = this.instances().filter((i) => this.isConnected(i));
    }
    if (connected.length === 1) return connected[0];
    const pick = await vscode.window.showQuickPick(connected.map((i) => ({ label: instanceHost(i), i })), { placeHolder: 'Which GitLab server?' });
    return pick?.i;
  }

  private async pickGroup(client: GitLabClient): Promise<string | undefined> {
    type Item = vscode.QuickPickItem & { path: string };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Choose a GitLab group';
    qp.placeholder = 'Type to filter, or type a full group path (e.g. my-org/team)';
    qp.matchOnDescription = true;
    qp.busy = true;
    qp.show();
    let groups: GitLabGroup[] = [];
    const base = (): Item[] => groups.map((g) => ({ label: g.full_path, description: g.full_name !== g.full_path ? g.full_name : undefined, path: g.full_path }));
    client
      .groups()
      .then((g) => {
        groups = g;
        qp.items = base();
      })
      .catch((e) => {
        qp.placeholder = `Could not list groups (${(e as Error).message}). Type a group path.`;
      })
      .finally(() => (qp.busy = false));
    qp.onDidChangeValue((v) => {
      const val = v.trim().replace(/^\/+|\/+$/g, '');
      const items = base();
      if (val && !items.some((i) => i.path.toLowerCase() === val.toLowerCase())) items.unshift({ label: `$(arrow-right) Use "${val}"`, path: val, alwaysShow: true } as Item);
      qp.items = items;
    });
    try {
      return await new Promise<string | undefined>((resolve) => {
        qp.onDidAccept(() => resolve(qp.selectedItems[0]?.path));
        qp.onDidHide(() => resolve(undefined));
      });
    } finally {
      qp.dispose();
    }
  }

  /** Builds a profile from GitLab projects, mirroring subgroups as folders. Pure apart from settings. */
  profileFromProjects(groupPath: string, projects: GitLabProject[]): { profile: Profile; skipped: string[] } {
    const ssh = vscode.workspace.getConfiguration('canopy').get<string>('gitlab.cloneProtocol', 'https') === 'ssh';
    const root = groupPath.split('/').pop()!;
    const skipped: string[] = [];
    const repos = [];
    for (const p of projects) {
      if (!p.default_branch) {
        skipped.push(`${p.path_with_namespace} (empty repository)`);
        continue;
      }
      const rel = p.path_with_namespace.toLowerCase().startsWith(groupPath.toLowerCase() + '/') ? p.path_with_namespace.slice(groupPath.length + 1) : p.path;
      const subgroups = rel.split('/').slice(0, -1);
      repos.push({
        name: p.path,
        remote: ssh ? p.ssh_url_to_repo : p.http_url_to_repo,
        branch: p.default_branch,
        path: `${root}/${rel}`,
        folder: [root, ...subgroups].join('/')
      });
    }
    const profile = parseProfile({ canopyProfile: 1, name: groupPath, mode: 'track', repos, onApply: { cloneMissing: true, stashChanges: false, pullAfter: false, recreateLayout: true } });
    return { profile, skipped };
  }

  /** Clone projects from a GitLab group (mode "clone"), or open them as a profile to review (mode "profile"). */
  async cloneFromGroup(mode: 'clone' | 'profile'): Promise<void> {
    const inst = await this.pickConnectedInstance();
    if (!inst) return;
    const client = this.client(inst)!;
    const groupPath = await this.pickGroup(client);
    if (!groupPath) return;
    let projects: GitLabProject[];
    try {
      projects = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Listing projects in ${groupPath}…` }, () => client.groupProjects(groupPath));
    } catch (e) {
      return void vscode.window.showErrorMessage(`Could not list projects in ${groupPath}: ${(e as Error).message}`);
    }
    projects = projects.filter((p) => !p.archived);
    if (!projects.length) return void vscode.window.showInformationMessage(`${groupPath} has no projects you can access.`);
    const local = new Map<string, Repo>();
    for (const r of this.manager.all) for (const u of r.remotes.values()) local.set(normalizeRemote(u), r);
    const items = projects.map((p) => {
      const existing = local.get(normalizeRemote(p.http_url_to_repo)) ?? local.get(normalizeRemote(p.ssh_url_to_repo));
      const rel = p.path_with_namespace.slice(groupPath.length + 1) || p.path;
      return { label: p.name, description: rel, detail: existing ? `already cloned at ${existing.root}` : p.default_branch ? undefined : 'empty repository, skipped', picked: !existing && !!p.default_branch, p };
    });
    const picks = await vscode.window.showQuickPick(items, {
      title: `${projects.length} projects in ${groupPath}`,
      placeHolder: mode === 'clone' ? 'Check the projects to clone' : 'Check the projects to include in the profile',
      canPickMany: true,
      matchOnDescription: true
    });
    if (!picks?.length) return;
    const { profile, skipped } = this.profileFromProjects(groupPath, picks.map((x) => x.p));
    if (skipped.length) void vscode.window.showInformationMessage(`Skipped: ${skipped.join(', ')}`);
    if (!profile.repos.length) return;
    if (mode === 'profile') {
      await this.profilesPanel.show(profile, 'import');
      return;
    }
    const baseUri = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      defaultUri: this.store.baseDir ? vscode.Uri.file(this.store.baseDir) : undefined,
      openLabel: 'Clone Here',
      title: `Folder to clone ${groupPath} into (a "${groupPath.split('/').pop()}" folder is created inside)`
    });
    if (!baseUri?.length) return;
    const base = baseUri[0].fsPath;
    const { steps, summary } = this.profiles.plan(profile, base);
    const ok = await vscode.window.showInformationMessage(
      `Clone from ${groupPath}?`,
      { modal: true, detail: `${summary}\n\n${steps.map((s) => `${s.kind.toUpperCase().padEnd(8)} ${s.entry.name}: ${s.detail}`).join('\n')}\n\nCANOPY folders are created to match the GitLab subgroups.` },
      'Clone'
    );
    if (ok) await this.profiles.apply(profile, base);
  }
}

function humanizeBranch(branch: string): string {
  const last = branch.split('/').pop() ?? branch;
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

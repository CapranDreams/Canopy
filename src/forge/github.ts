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
import { GhRepo, GitHubClient, GitHubError, aggregateRuns, apiBaseFor, matchGitHubRemote, summarizeReviews } from './githubApi';
import { ForgeInfo, ForgeProvider, ForgeState } from './types';

const SCOPES = ['repo', 'read:org'];
const SECRET_PREFIX = 'canopy.github.token:';

interface Match {
  host: string;
  owner: string;
  repo: string;
  remoteName: string;
}

/**
 * GitHub integration for github.com and GitHub Enterprise Server (the host in VS Code's
 * "github-enterprise.uri" setting). Signs in through VS Code's built-in GitHub accounts, with a
 * personal access token as a fallback where that sign-in is not available.
 */
export class GitHubService implements ForgeProvider {
  readonly kind = 'github' as const;
  readonly label = 'GitHub';
  private readonly _onDidChange = new vscode.EventEmitter<Repo | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private readonly infos = new Map<string, ForgeInfo>();
  /** host → token (from a VS Code session or a stored personal access token) */
  private readonly tokens = new Map<string, string>();
  private readonly clients = new Map<string, GitHubClient>();
  private readonly repos = new Map<string, { id: number; webUrl: string; defaultBranch: string; at: number }>();
  private readonly limiter = new Limiter(4);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly snoozed = new Set<string>();
  private readonly rejected = new Set<string>();
  private testServer: { host: string; apiBase: string } | undefined;
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
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === 'github' || e.provider.id === 'github-enterprise') void this.loadTokens().then(() => this.refreshVisible(true));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('canopy.github') || e.affectsConfiguration('github-enterprise.uri')) {
          this.startTimer();
          void this.loadTokens().then(() => this.refreshVisible(true));
        }
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && this.pollMinutes() > 0) this.refreshVisible(false);
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

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('canopy').get<boolean>('github.enabled', true);
  }

  /** github.com plus the GitHub Enterprise host, if one is configured. */
  hosts(): string[] {
    if (this.testServer) return [this.testServer.host];
    const hosts = ['github.com'];
    const ghe = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
    if (ghe) {
      try {
        hosts.push(new URL(ghe).host.toLowerCase());
      } catch {
        // ignore a malformed setting
      }
    }
    return hosts;
  }

  private providerIdFor(host: string): string {
    return host === 'github.com' ? 'github' : 'github-enterprise';
  }

  private apiBase(host: string): string {
    return this.testServer && host === this.testServer.host ? this.testServer.apiBase : apiBaseFor(host);
  }

  private get signedOutHosts(): string[] {
    return this.ctx.globalState.get<string[]>('canopy.github.signedOut') ?? [];
  }

  /** Picks up existing VS Code GitHub sessions silently (no prompt) and stored tokens. */
  private async loadTokens(): Promise<void> {
    if (this.testServer) return;
    this.tokens.clear();
    this.clients.clear();
    if (this.enabled) {
      for (const host of this.hosts()) {
        if (this.signedOutHosts.includes(host)) continue;
        const pat = await this.ctx.secrets.get(SECRET_PREFIX + host);
        if (pat) {
          this.tokens.set(host, pat);
          continue;
        }
        try {
          const session = await vscode.authentication.getSession(this.providerIdFor(host), SCOPES, { silent: true });
          if (session) this.tokens.set(host, session.accessToken);
        } catch {
          // Provider not available in this editor (e.g. some VS Code forks): token sign-in still works.
        }
      }
    }
    void vscode.commands.executeCommand('setContext', 'canopy.github.connected', this.tokens.size > 0);
    this._onDidChange.fire(undefined);
  }

  private client(host: string): GitHubClient | undefined {
    const token = this.tokens.get(host);
    if (!token) return undefined;
    let c = this.clients.get(host);
    if (!c) {
      c = new GitHubClient(this.apiBase(host), token);
      this.clients.set(host, c);
    }
    return c;
  }

  match(repo: Repo): Match | undefined {
    if (!this.enabled) return undefined;
    const hosts = this.hosts();
    const remotes = [...repo.remotes.entries()];
    const primary = repo.primaryRemote?.name;
    remotes.sort(([a], [b]) => (a === primary ? -1 : b === primary ? 1 : 0));
    for (const [name, url] of remotes) {
      const m = matchGitHubRemote(url, hosts);
      if (m) return { ...m, remoteName: name };
    }
    return undefined;
  }

  state(repo: Repo): ForgeState {
    const m = this.match(repo);
    if (!m) return { kind: 'none' };
    if (!this.tokens.has(m.host)) return { kind: 'disconnected', provider: 'github', host: m.host };
    return { kind: 'connected', provider: 'github', info: this.infos.get(repo.key), readOnly: false };
  }

  info(repo: Repo): ForgeInfo | undefined {
    const m = this.match(repo);
    return m && this.tokens.has(m.host) ? this.infos.get(repo.key) : undefined;
  }

  // --- refreshing -----------------------------------------------------------------

  /** Timed polling interval; 0 (the default) means status refreshes only on Fetch, Refresh, push and branch changes. */
  private pollMinutes(): number {
    return vscode.workspace.getConfiguration('canopy').get<number>('github.refreshMinutes', 0);
  }

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const minutes = this.pollMinutes();
    if (minutes <= 0) return;
    this.timer = setInterval(() => {
      if (vscode.window.state.focused) this.refreshVisible(false);
    }, Math.max(1, minutes) * 60_000);
  }

  /** Changes that make the cached status wrong: another branch, or the branch was published / retargeted. */
  private stateKeyOf(repo: Repo): string {
    return [repo.branch, repo.upstream].join('|');
  }

  private onRepoChanged(repo: Repo): void {
    const prev = this.infos.get(repo.key);
    if (!prev || prev.stateKey !== this.stateKeyOf(repo)) return void this.refresh(repo);
    // A commit, pull or reset only moves HEAD; whether the pipeline is for HEAD is known without asking the server.
    const isHead = !!prev.pipeline && prev.pipeline.sha === repo.status?.oid;
    if (prev.pipeline && prev.pipeline.isHead !== isHead) {
      prev.pipeline.isHead = isHead;
      this._onDidChange.fire(repo);
    }
  }

  refreshVisible(force: boolean): void {
    const maxAge = Math.max(1, this.pollMinutes()) * 60_000;
    for (const r of this.visibleRepos()) {
      const prev = this.infos.get(r.key);
      if (force || !prev || Date.now() - prev.fetchedAt > maxAge) void this.refresh(r);
    }
  }

  async refresh(repo: Repo): Promise<ForgeInfo | undefined> {
    const m = this.match(repo);
    if (!m || !repo.loaded) return undefined;
    const client = this.client(m.host);
    if (!client) return undefined;
    return this.limiter.run(async () => {
      const info: ForgeInfo = {
        provider: 'github',
        instanceUrl: `https://${m.host}`,
        host: m.host,
        projectPath: `${m.owner}/${m.repo}`,
        remoteName: m.remoteName,
        fetchedAt: Date.now(),
        stateKey: this.stateKeyOf(repo)
      };
      try {
        const key = `${m.host}|${m.owner}/${m.repo}`;
        let r = this.repos.get(key);
        if (!r || Date.now() - r.at > 30 * 60_000) {
          const gr = await client.repo(m.owner, m.repo);
          r = { id: gr.id, webUrl: gr.html_url, defaultBranch: gr.default_branch, at: Date.now() };
          this.repos.set(key, r);
        }
        info.project = { id: r.id, webUrl: r.webUrl, defaultBranch: r.defaultBranch };
        const branch = repo.branch ?? undefined;
        const oid = repo.status?.oid ?? undefined;
        const [runs, pr] = await Promise.all([
          client.runs(m.owner, m.repo, branch ? { branch } : { sha: oid }).catch(() => []),
          branch ? client.openPull(m.owner, m.repo, m.owner, branch).catch(() => undefined) : Promise.resolve(undefined)
        ]);
        const agg = aggregateRuns(runs);
        if (agg) {
          info.pipeline = { id: agg.run.id, status: agg.status, sha: agg.sha, webUrl: agg.run.html_url, ref: agg.run.head_branch ?? branch ?? '', isHead: agg.sha === oid };
        } else {
          const cs = await client.combinedStatus(m.owner, m.repo, branch ?? oid ?? 'HEAD');
          if (cs && cs.total > 0) {
            const status = cs.state === 'success' ? 'success' : cs.state === 'pending' ? 'running' : 'failed';
            info.pipeline = { id: 0, status, sha: cs.sha, webUrl: `${r.webUrl}/commit/${cs.sha}`, ref: branch ?? '', isHead: cs.sha === oid };
          }
        }
        if (pr) {
          const [detail, reviews] = await Promise.all([client.pull(m.owner, m.repo, pr.number).catch(() => pr), client.reviews(m.owner, m.repo, pr.number).catch(() => [])]);
          const rv = summarizeReviews(reviews);
          info.mr = {
            iid: pr.number,
            title: pr.title,
            webUrl: pr.html_url,
            draft: !!pr.draft,
            hasConflicts: detail.mergeable_state === 'dirty' || detail.mergeable === false,
            status: detail.mergeable_state ?? '',
            targetBranch: pr.base.ref,
            approved: rv.approved,
            approvedBy: rv.approvedBy,
            changesRequested: rv.changesRequested
          };
        }
        this.rejected.delete(m.host);
      } catch (e) {
        info.error = (e as Error).message;
        if (e instanceof GitHubError && e.status === 401) this.onRejected(m.host);
        else this.log.warn(`GitHub ${m.owner}/${m.repo}: ${info.error}`);
      }
      this.infos.set(repo.key, info);
      this._onDidChange.fire(repo);
      return info;
    });
  }

  private onRejected(host: string): void {
    if (this.rejected.has(host)) return;
    this.rejected.add(host);
    void vscode.window.showWarningMessage(`CANOPY: ${host} rejected the GitHub sign-in (expired or revoked).`, 'Sign In Again…').then((a) => a && this.connect(host));
  }

  // --- signing in ----------------------------------------------------------------------

  private schedulePrompt(): void {
    if (this.promptTimer) clearTimeout(this.promptTimer);
    // A little later than the GitLab prompt so the two never appear at once.
    this.promptTimer = setTimeout(() => void this.maybePromptToConnect(), 6000);
  }

  async maybePromptToConnect(): Promise<void> {
    if (this.prompting || !this.enabled || !vscode.workspace.getConfiguration('canopy').get<boolean>('github.promptToConnect', true)) return;
    const dismissed = new Set(this.ctx.globalState.get<string[]>('canopy.github.dismissed') ?? []);
    const counts = new Map<string, number>();
    for (const r of this.manager.all) {
      const s = this.state(r);
      if (s.kind === 'disconnected') counts.set(s.host, (counts.get(s.host) ?? 0) + 1);
    }
    const host = [...counts.keys()].find((h) => !dismissed.has(h) && !this.snoozed.has(h) && !this.signedOutHosts.includes(h));
    if (!host) return;
    this.prompting = true;
    try {
      const n = counts.get(host)!;
      const a = await vscode.window.showInformationMessage(`${n} of your repositories are on ${host}. Sign in to see checks and pull requests?`, 'Sign In…', 'Not Now', "Don't Ask Again");
      if (a === 'Sign In…') await this.connect(host);
      else if (a === "Don't Ask Again") await this.ctx.globalState.update('canopy.github.dismissed', [...dismissed, host]);
      else this.snoozed.add(host);
    } finally {
      this.prompting = false;
    }
  }

  /** Signs in through VS Code's GitHub accounts; falls back to a personal access token. */
  async connect(hint?: string): Promise<boolean> {
    const hosts = this.hosts();
    let host = hint && hosts.includes(hint) ? hint : hosts[0];
    if (!hint && hosts.length > 1) {
      const pick = await vscode.window.showQuickPick(hosts.map((h) => ({ label: h, description: h === 'github.com' ? 'GitHub' : 'GitHub Enterprise Server' })), { placeHolder: 'Sign in to which GitHub?' });
      if (!pick) return false;
      host = pick.label;
    }
    await this.ctx.globalState.update('canopy.github.signedOut', this.signedOutHosts.filter((h) => h !== host));
    try {
      const session = await vscode.authentication.getSession(this.providerIdFor(host), SCOPES, { createIfNone: true });
      if (session) {
        await this.ctx.secrets.delete(SECRET_PREFIX + host);
        await this.loadTokens();
        void vscode.window.showInformationMessage(`Signed in to ${host} as ${session.account.label}. Checks and pull requests now show in CANOPY.`);
        this.refreshVisible(true);
        return true;
      }
    } catch (e) {
      this.log.warn(`GitHub sign-in through VS Code failed: ${(e as Error).message}`);
      const a = await vscode.window.showWarningMessage(
        `VS Code's GitHub sign-in is not available here (${(e as Error).message}).`,
        { modal: true, detail: 'You can connect with a personal access token instead. It is kept in encrypted secret storage on this computer.' },
        'Use a Token…'
      );
      if (a) return this.connectWithToken(host);
    }
    return false;
  }

  private async connectWithToken(host: string): Promise<boolean> {
    const page = host === 'github.com' ? 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=CANOPY' : `https://${host}/settings/tokens/new?scopes=repo,read:org&description=CANOPY`;
    let open: string | undefined = await vscode.window.showInformationMessage(
      `Connect CANOPY to ${host} with a token`,
      { modal: true, detail: 'CANOPY opens the token page with the name "CANOPY" and the "repo" and "read:org" scopes filled in. Choose an expiry, generate the token, and paste it in the next step.' },
      'Open Token Page',
      'I Already Have a Token'
    );
    if (!open) return false;
    for (;;) {
      if (open === 'Open Token Page') await vscode.env.openExternal(vscode.Uri.parse(page));
      const token = await vscode.window.showInputBox({ prompt: `Paste your ${host} personal access token`, placeHolder: 'ghp_… or github_pat_…', password: true, ignoreFocusOut: true, validateInput: (v) => (v.trim().length < 20 ? 'That looks too short for a GitHub token.' : undefined) });
      if (!token) return false;
      try {
        const { user, scopes } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking the token with ${host}…` }, () => new GitHubClient(this.apiBase(host), token.trim()).user());
        await this.ctx.secrets.store(SECRET_PREFIX + host, token.trim());
        await this.loadTokens();
        const missing = scopes && !scopes.includes('repo') ? ' The token has no "repo" scope, so private repositories and creating pull requests will not work.' : '';
        void vscode.window.showInformationMessage(`Connected to ${host} as @${user.login}.${missing}`);
        this.refreshVisible(true);
        return true;
      } catch (e) {
        const again = await vscode.window.showErrorMessage(`Could not connect to ${host}: ${(e as Error).message}`, 'Try Again', 'Open Token Page');
        if (!again) return false;
        open = again;
      }
    }
  }

  async disconnect(): Promise<void> {
    const connected = [...this.tokens.keys()];
    if (!connected.length) return void vscode.window.showInformationMessage('CANOPY is not signed in to GitHub.');
    const pick = connected.length === 1 ? connected[0] : (await vscode.window.showQuickPick(connected, { placeHolder: 'Stop using which GitHub account in CANOPY?' }));
    if (!pick) return;
    await this.ctx.secrets.delete(SECRET_PREFIX + pick);
    await this.ctx.globalState.update('canopy.github.signedOut', [...new Set([...this.signedOutHosts, pick])]);
    for (const [k, v] of this.infos) if (v.host === pick) this.infos.delete(k);
    await this.loadTokens();
    void vscode.window.showInformationMessage(`CANOPY stopped using ${pick}. To sign out of GitHub in VS Code entirely, use the Accounts menu.`);
  }

  /** For tests: talk to a fake API server for `host` with a fixed token. */
  async useTestServer(host: string, apiBase: string, token: string): Promise<void> {
    this.testServer = { host: host.toLowerCase(), apiBase };
    this.tokens.clear();
    this.clients.clear();
    this.tokens.set(host.toLowerCase(), token);
    this._onDidChange.fire(undefined);
  }

  // --- repo actions --------------------------------------------------------------------

  private async requireConnected(repo: Repo): Promise<{ client: GitHubClient; info: ForgeInfo; match: Match } | undefined> {
    let m = this.match(repo);
    if (!m) {
      void vscode.window.showInformationMessage(`${repo.name} has no GitHub remote.`);
      return undefined;
    }
    if (!this.tokens.has(m.host)) {
      if (!(await this.connect(m.host))) return undefined;
      m = this.match(repo)!;
    }
    const info = (await this.refresh(repo)) ?? this.infos.get(repo.key);
    if (!info?.project) {
      void vscode.window.showErrorMessage(`CANOPY could not load ${m.owner}/${m.repo} from ${m.host}${info?.error ? `: ${info.error}` : '.'}`);
      return undefined;
    }
    return { client: this.client(m.host)!, info, match: m };
  }

  async openRequest(repo: Repo): Promise<void> {
    const c = await this.requireConnected(repo);
    if (!c) return;
    if (c.info.mr) return void vscode.env.openExternal(vscode.Uri.parse(c.info.mr.webUrl));
    const a = await vscode.window.showInformationMessage(`${repo.branchLabel} has no open pull request.`, 'Create Pull Request…');
    if (a) await this.createRequest(repo);
  }

  async openPipeline(repo: Repo): Promise<void> {
    const c = await this.requireConnected(repo);
    if (!c) return;
    const url = c.info.pipeline?.webUrl ?? `${c.info.project!.webUrl}/actions${repo.branch ? `?query=branch%3A${encodeURIComponent(repo.branch)}` : ''}`;
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
    if (!p || !p.id) return void vscode.window.showInformationMessage(`No GitHub Actions run to re-run for ${repo.branchLabel}.`);
    if (p.status === 'running') return void vscode.window.showInformationMessage('The checks are still running.');
    const failedOnly = p.status === 'failed' || p.status === 'canceled';
    try {
      await c.client.rerun(c.match.owner, c.match.repo, p.id, failedOnly);
      void vscode.window.setStatusBarMessage(`$(sync) Re-running ${failedOnly ? 'failed jobs' : 'the workflow'}`, 4000);
      setTimeout(() => void this.refresh(repo), 3000);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not re-run the checks: ${(e as Error).message}`);
    }
  }

  async createRequest(repo: Repo): Promise<void> {
    const c = await this.requireConnected(repo);
    if (!c) return;
    const branch = repo.branch;
    if (!branch) return void vscode.window.showWarningMessage('Check out a branch first.');
    const def = c.info.project!.defaultBranch;
    if (branch === def) {
      const a = await vscode.window.showWarningMessage(`You are on ${def}, the default branch. Create a branch for your change first.`, 'Create Branch…');
      if (a) await vscode.commands.executeCommand('canopy.createBranch', repo);
      return;
    }
    if (c.info.mr) {
      const a = await vscode.window.showInformationMessage(`${branch} already has pull request #${c.info.mr.iid}.`, 'Open');
      if (a) await vscode.env.openExternal(vscode.Uri.parse(c.info.mr.webUrl));
      return;
    }
    const remote = c.match.remoteName;
    if (!repo.upstream || repo.ahead > 0 || !repo.upstream.startsWith(remote + '/')) {
      const a = await vscode.window.showInformationMessage(`${branch} ${repo.upstream ? `has ${repo.ahead} unpushed commit(s)` : `is not on ${remote} yet`}. Push it before creating the pull request?`, { modal: true }, 'Push');
      if (!a) return;
      if ((await this.ops.exec(repo, ['push', '-u', remote, branch], { title: `Push ${branch}`, notify: true })) === undefined) return;
    }
    const out = await repo.git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)', `refs/remotes/${remote}`], { readOnly: true }).catch(() => '');
    const branches = out.split('\n').map((l) => l.trim().replace(`refs/remotes/${remote}/`, '')).filter((b) => b && b !== 'HEAD');
    const ordered = [...new Set([def, ...branches].filter((b): b is string => !!b && b !== branch))];
    const base = await vscode.window.showQuickPick(ordered.map((b) => ({ label: b, description: b === def ? 'default branch' : undefined })), { title: 'Create pull request (1/3)', placeHolder: `Merge ${branch} into…` });
    if (!base) return;
    const commits = (await repo.git(['log', '--format=%s', '-n50', `${remote}/${base.label}..HEAD`], { readOnly: true }).catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean);
    const last = branch.split('/').pop() ?? branch;
    const defaultTitle = commits.length === 1 ? commits[0] : last.replace(/[-_]+/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
    const title = await vscode.window.showInputBox({ title: 'Create pull request (2/3)', prompt: 'Title', value: defaultTitle, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Enter a title') });
    if (!title) return;
    const draft = await vscode.window.showQuickPick([{ label: 'Ready for review', draft: false }, { label: 'Draft', draft: true }], { title: 'Create pull request (3/3)', placeHolder: 'Open as a draft?' });
    if (!draft) return;
    const pr = await this.createRequestFor(repo, { base: base.label, title: title.trim(), body: commits.length ? commits.map((s) => `- ${s}`).join('\n') : undefined, draft: draft.draft });
    if (!pr) return;
    const a = await vscode.window.showInformationMessage(`Created pull request #${pr.number}: ${pr.title}`, 'Open in Browser', 'Copy Link');
    if (a === 'Open in Browser') await vscode.env.openExternal(vscode.Uri.parse(pr.webUrl));
    else if (a === 'Copy Link') await vscode.env.clipboard.writeText(pr.webUrl);
  }

  /** Creates the pull request without prompts (the branch must already be pushed). */
  async createRequestFor(repo: Repo, o: { base: string; title: string; body?: string; draft?: boolean }): Promise<{ number: number; title: string; webUrl: string } | undefined> {
    const m = this.match(repo);
    const client = m ? this.client(m.host) : undefined;
    if (!m || !client || !repo.branch) return undefined;
    try {
      const pr = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creating pull request…' }, () =>
        client.createPull(m.owner, m.repo, { title: o.title, head: repo.branch!, base: o.base, body: o.body, draft: o.draft })
      );
      await this.refresh(repo);
      return { number: pr.number, title: pr.title, webUrl: pr.html_url };
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not create the pull request: ${(e as Error).message}`);
      return undefined;
    }
  }

  // --- organizations ---------------------------------------------------------------------

  /** Builds a profile from GitHub repositories; the organization (or user) becomes the folder. */
  profileFromRepos(owner: string, repos: GhRepo[]): { profile: Profile; skipped: string[] } {
    const ssh = vscode.workspace.getConfiguration('canopy').get<string>('github.cloneProtocol', 'https') === 'ssh';
    const skipped: string[] = [];
    const entries = [];
    for (const r of repos) {
      if (r.archived) continue;
      if (r.size === 0) {
        skipped.push(`${r.full_name} (empty repository)`);
        continue;
      }
      entries.push({ name: r.name, remote: ssh ? r.ssh_url : r.clone_url, branch: r.default_branch || 'main', path: `${owner}/${r.name}`, folder: owner });
    }
    const profile = parseProfile({ canopyProfile: 1, name: owner, mode: 'track', repos: entries, onApply: { cloneMissing: true, stashChanges: false, pullAfter: false, recreateLayout: true } });
    return { profile, skipped };
  }

  async cloneFromGroup(mode: 'clone' | 'profile'): Promise<void> {
    let host = [...this.tokens.keys()][0];
    if (!host) {
      const a = await vscode.window.showInformationMessage('Sign in to GitHub first.', 'Sign In…');
      if (!a || !(await this.connect())) return;
      host = [...this.tokens.keys()][0];
    }
    if (this.tokens.size > 1) {
      const pick = await vscode.window.showQuickPick([...this.tokens.keys()], { placeHolder: 'Which GitHub?' });
      if (!pick) return;
      host = pick;
    }
    const client = this.client(host)!;
    type Item = vscode.QuickPickItem & { owner: string; personal: boolean };
    let owners: Item[];
    try {
      owners = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Listing your GitHub organizations…' }, async () => {
        const [{ user }, orgs] = await Promise.all([client.user(), client.orgs().catch(() => [])]);
        return [{ label: `$(account) ${user.login}`, description: 'your repositories', owner: user.login, personal: true }, ...orgs.map((o) => ({ label: `$(organization) ${o.login}`, description: o.description ?? undefined, owner: o.login, personal: false }))] as Item[];
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not list GitHub organizations: ${(e as Error).message}`);
      return;
    }
    const owner = await vscode.window.showQuickPick(owners, { title: 'Clone from GitHub', placeHolder: 'Choose an organization or your own account' });
    if (!owner) return;
    let repos: GhRepo[];
    try {
      repos = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Listing repositories in ${owner.owner}…` }, () => (owner.personal ? client.userRepos() : client.orgRepos(owner.owner)));
    } catch (e) {
      return void vscode.window.showErrorMessage(`Could not list repositories: ${(e as Error).message}`);
    }
    repos = repos.filter((r) => !r.archived);
    if (!repos.length) return void vscode.window.showInformationMessage(`${owner.owner} has no repositories you can access.`);
    const local = new Set(this.manager.all.flatMap((r) => [...r.remotes.values()].map(normalizeRemote)));
    const items = repos.map((r) => {
      const have = local.has(normalizeRemote(r.clone_url));
      return { label: r.name, description: r.default_branch, detail: have ? 'already cloned' : r.size === 0 ? 'empty repository, skipped' : undefined, picked: !have && r.size !== 0, r };
    });
    const picks = await vscode.window.showQuickPick(items, { title: `${repos.length} repositories in ${owner.owner}`, placeHolder: mode === 'clone' ? 'Check the repositories to clone' : 'Check the repositories to include in the profile', canPickMany: true, matchOnDescription: true });
    if (!picks?.length) return;
    const { profile, skipped } = this.profileFromRepos(owner.owner, picks.map((p) => p.r));
    if (skipped.length) void vscode.window.showInformationMessage(`Skipped: ${skipped.join(', ')}`);
    if (!profile.repos.length) return;
    if (mode === 'profile') return this.profilesPanel.show(profile, 'import');
    const baseUri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: this.store.baseDir ? vscode.Uri.file(this.store.baseDir) : undefined, openLabel: 'Clone Here', title: `Folder to clone into (a "${owner.owner}" folder is created inside)` });
    if (!baseUri?.length) return;
    const base = baseUri[0].fsPath;
    const { steps, summary } = this.profiles.plan(profile, base);
    const ok = await vscode.window.showInformationMessage(`Clone from ${owner.owner}?`, { modal: true, detail: `${summary}\n\n${steps.map((s) => `${s.kind.toUpperCase().padEnd(8)} ${s.entry.name}: ${s.detail}`).join('\n')}` }, 'Clone');
    if (ok) await this.profiles.apply(profile, base);
  }
}

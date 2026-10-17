/** Minimal GitHub REST client plus pure helpers. No vscode imports; `fetch` is injectable for tests. */
import { remoteHostPath } from '../util/remote';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GhUser {
  login: string;
  name: string | null;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  archived?: boolean;
  size?: number;
  owner: { login: string };
}

export interface GhRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  head_branch: string | null;
}

export interface GhPull {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  base: { ref: string };
  head: { ref: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
}

export interface GhReview {
  user: { login: string } | null;
  state: string;
}

export interface GhOrg {
  login: string;
  description?: string | null;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type Query = Record<string, string | number | boolean | undefined>;
const enc = encodeURIComponent;

/** REST API base for a GitHub host: api.github.com for github.com, /api/v3 for GitHub Enterprise Server. */
export function apiBaseFor(host: string): string {
  return host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

/** Finds owner/repo for a remote on one of `hosts` (e.g. ["github.com", "github.example.com"]). */
export function matchGitHubRemote(url: string, hosts: readonly string[]): { host: string; owner: string; repo: string } | undefined {
  const known = hosts.map((h) => h.toLowerCase());
  let host: string | undefined;
  let p: string | undefined;
  if (/^https?:\/\//i.test(url.trim())) {
    try {
      const u = new URL(url.trim());
      host = u.host.toLowerCase();
      p = decodeURIComponent(u.pathname);
    } catch {
      return undefined;
    }
  } else {
    const hp = remoteHostPath(url);
    if (!hp) return undefined;
    host = hp.host.toLowerCase();
    if (host === 'ssh.github.com') host = 'github.com';
    p = hp.path;
  }
  if (!known.includes(host)) return undefined;
  const parts = p.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { host, owner: parts[0], repo: parts[1] };
}

/** Maps a workflow run to the status words CANOPY uses for pipelines. */
export function runStatus(run: Pick<GhRun, 'status' | 'conclusion'>): string {
  if (run.status !== 'completed') return 'running';
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    case 'action_required':
      return 'manual';
    default:
      return 'skipped';
  }
}

const STATUS_RANK = ['failed', 'running', 'canceled', 'manual', 'success', 'skipped'];

/**
 * Rolls the runs for the newest commit in `runs` (newest first) into one status. Returns the run
 * to link to and retry: the first failed one, else the newest.
 */
export function aggregateRuns(runs: readonly GhRun[]): { status: string; sha: string; run: GhRun } | undefined {
  if (!runs.length) return undefined;
  const sha = runs[0].head_sha;
  const group = runs.filter((r) => r.head_sha === sha);
  const statuses = group.map(runStatus);
  const status = STATUS_RANK.find((s) => statuses.includes(s)) ?? 'skipped';
  const run = group.find((r) => runStatus(r) === 'failed') ?? group[0];
  return { status, sha, run };
}

/** Latest review per reviewer decides approval. */
export function summarizeReviews(reviews: readonly GhReview[]): { approved: boolean; changesRequested: boolean; approvedBy: string[] } {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (!r.user || r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    latest.set(r.user.login, r.state);
  }
  const approvedBy = [...latest].filter(([, s]) => s === 'APPROVED').map(([u]) => u);
  const changesRequested = [...latest.values()].includes('CHANGES_REQUESTED');
  return { approved: approvedBy.length > 0 && !changesRequested, changesRequested, approvedBy };
}

export class GitHubClient {
  private readonly cache = new Map<string, { etag: string; body: unknown }>();

  constructor(
    readonly apiBase: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
    private readonly timeoutMs = 20_000
  ) {}

  private url(path: string, query?: Query): string {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
          .join('&')
      : '';
    return this.apiBase.replace(/\/+$/, '') + path + (qs ? '?' + qs : '');
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    if (!url.startsWith(this.apiBase)) throw new GitHubError(`Refusing to send the token to ${url}.`, 0);
    const cached = method === 'GET' ? this.cache.get(url) : undefined;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CANOPY-VSCode',
          ...(cached ? { 'If-None-Match': cached.etag } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      throw new GitHubError(`Could not reach ${new URL(this.apiBase).host} (${err.cause?.code ?? err.cause?.message ?? err.message}).`, 0);
    }
    // A 304 answer is free: it doesn't count against the rate limit.
    if (res.status === 304 && cached) return { data: cached.body as T, headers: res.headers };
    if (res.status >= 300 && res.status < 400) throw new GitHubError(`GitHub redirected to ${res.headers.get('location') ?? 'another address'}.`, res.status);
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { message?: string; errors?: Array<{ message?: string }> };
        detail = [j.message, ...(j.errors ?? []).map((x) => x.message)].filter(Boolean).join(' ');
      } catch {
        // not JSON
      }
      const remaining = res.headers.get('x-ratelimit-remaining');
      const hint =
        res.status === 401
          ? 'The GitHub sign-in or token is invalid, expired or revoked.'
          : res.status === 403 && remaining === '0'
            ? 'GitHub API rate limit reached; status will refresh later.'
            : res.status === 403
              ? 'GitHub denied access (check the token scopes or organization SSO authorization).'
              : res.status === 404
                ? 'Not found (or no access).'
                : `HTTP ${res.status}`;
      throw new GitHubError(detail ? `${hint} ${detail}` : hint, res.status);
    }
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    const etag = res.headers.get('etag');
    if (method === 'GET' && etag) this.cache.set(url, { etag, body: data });
    return { data, headers: res.headers };
  }

  private async get<T>(path: string, query?: Query): Promise<T> {
    return (await this.request<T>('GET', this.url(path, query))).data;
  }

  /** Follows the Link: rel="next" header (same API host only). */
  async paginate<T>(path: string, query: Query = {}, max = 1000): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = this.url(path, { ...query, per_page: 100 });
    while (next && out.length < max) {
      const { data, headers }: { data: T[]; headers: Headers } = await this.request<T[]>('GET', next);
      out.push(...data);
      const m = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '');
      next = m && m[1].startsWith(this.apiBase) ? m[1] : undefined;
    }
    return out.slice(0, max);
  }

  async user(): Promise<{ user: GhUser; scopes: string[] | undefined }> {
    const { data, headers } = await this.request<GhUser>('GET', this.url('/user'));
    const raw = headers.get('x-oauth-scopes');
    return { user: data, scopes: raw === null ? undefined : raw.split(',').map((s) => s.trim()).filter(Boolean) };
  }

  repo(owner: string, repo: string): Promise<GhRepo> {
    return this.get(`/repos/${enc(owner)}/${enc(repo)}`);
  }

  async runs(owner: string, repo: string, ref: { branch?: string; sha?: string }): Promise<GhRun[]> {
    const r = await this.get<{ workflow_runs: GhRun[] }>(`/repos/${enc(owner)}/${enc(repo)}/actions/runs`, { per_page: 20, branch: ref.branch, head_sha: ref.branch ? undefined : ref.sha, exclude_pull_requests: true });
    return r.workflow_runs ?? [];
  }

  /** Classic commit statuses (CI systems other than Actions). */
  async combinedStatus(owner: string, repo: string, ref: string): Promise<{ state: string; sha: string; total: number } | undefined> {
    try {
      const r = await this.get<{ state: string; sha: string; total_count: number }>(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/status`);
      return { state: r.state, sha: r.sha, total: r.total_count };
    } catch {
      return undefined;
    }
  }

  async openPull(owner: string, repo: string, headOwner: string, branch: string): Promise<GhPull | undefined> {
    const list = await this.get<GhPull[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls`, { state: 'open', head: `${headOwner}:${branch}`, per_page: 5 });
    return list[0];
  }

  pull(owner: string, repo: string, n: number): Promise<GhPull> {
    return this.get(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`);
  }

  reviews(owner: string, repo: string, n: number): Promise<GhReview[]> {
    return this.get(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/reviews`, { per_page: 100 });
  }

  async createPull(owner: string, repo: string, pr: { title: string; head: string; base: string; body?: string; draft?: boolean }): Promise<GhPull> {
    return (await this.request<GhPull>('POST', this.url(`/repos/${enc(owner)}/${enc(repo)}/pulls`), { ...pr, maintainer_can_modify: true })).data;
  }

  async rerun(owner: string, repo: string, runId: number, failedOnly: boolean): Promise<void> {
    await this.request('POST', this.url(`/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`), {});
  }

  orgs(): Promise<GhOrg[]> {
    return this.paginate<GhOrg>('/user/orgs');
  }

  orgRepos(org: string): Promise<GhRepo[]> {
    return this.paginate<GhRepo>(`/orgs/${enc(org)}/repos`, { type: 'all', sort: 'full_name' }, 2000);
  }

  userRepos(): Promise<GhRepo[]> {
    return this.paginate<GhRepo>('/user/repos', { affiliation: 'owner', sort: 'full_name' }, 2000);
  }
}

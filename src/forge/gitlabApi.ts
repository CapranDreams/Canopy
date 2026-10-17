/** Minimal GitLab REST v4 client. No vscode imports; `fetch` is injectable for tests. */

export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GitLabError';
  }
}

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  default_branch: string | null;
  web_url: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  archived?: boolean;
  namespace?: { full_path: string };
}

export interface GitLabPipeline {
  id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  updated_at?: string;
}

export interface GitLabMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  draft?: boolean;
  work_in_progress?: boolean;
  has_conflicts: boolean;
  detailed_merge_status?: string;
  merge_status?: string;
  source_branch: string;
  target_branch: string;
  state: string;
  author?: { username: string };
}

export interface GitLabApprovals {
  approved: boolean;
  approvals_left?: number;
  approved_by?: Array<{ user: { username: string } }>;
}

export interface GitLabGroup {
  id: number;
  name: string;
  full_path: string;
  full_name: string;
}

export interface TokenInfo {
  name: string;
  scopes: string[];
  expires_at: string | null;
}

export interface NewMergeRequest {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  draft?: boolean;
  removeSourceBranch?: boolean;
  squash?: boolean;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const enc = (p: string | number) => encodeURIComponent(String(p));

export class GitLabClient {
  readonly apiBase: string;

  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
    private readonly timeoutMs = 20_000
  ) {
    this.apiBase = baseUrl.replace(/\/+$/, '') + '/api/v4';
  }

  private async request<T>(method: string, path: string, query?: Record<string, string | number | boolean | undefined>, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const qs = query
      ? '?' +
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
          .join('&')
      : '';
    let res: Response;
    try {
      res = await this.fetchFn(this.apiBase + path + qs, {
        method,
        // A bearer token is dropped by fetch on cross-origin redirects; manual redirects make that explicit.
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const cause = err.cause?.code ?? err.cause?.message ?? err.message;
      throw new GitLabError(`Could not reach ${this.baseUrl} (${cause}).`, 0);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new GitLabError(`${this.baseUrl} redirected to ${res.headers.get('location') ?? 'another address'}. Check the server URL.`, res.status);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { message?: unknown; error?: unknown; error_description?: unknown };
        detail = String(j.message ?? j.error_description ?? j.error ?? '');
        if (detail.startsWith('{') || detail.startsWith('[')) detail = JSON.stringify(j.message);
      } catch {
        // not JSON
      }
      const hint = res.status === 401 ? 'The access token is invalid, expired or revoked.' : res.status === 403 ? 'The access token does not have permission for this.' : res.status === 404 ? 'Not found (or no access).' : `HTTP ${res.status}`;
      throw new GitLabError(detail ? `${hint} ${detail}` : hint, res.status);
    }
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    return { data, headers: res.headers };
  }

  private async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return (await this.request<T>('GET', path, query)).data;
  }

  /** Follows GitLab's x-next-page header. */
  async paginate<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}, max = 2000): Promise<T[]> {
    const out: T[] = [];
    let page: string | null = '1';
    while (page && out.length < max) {
      const { data, headers }: { data: T[]; headers: Headers } = await this.request<T[]>('GET', path, { ...query, per_page: 100, page });
      out.push(...data);
      page = headers.get('x-next-page') || null;
    }
    return out.slice(0, max);
  }

  currentUser(): Promise<GitLabUser> {
    return this.get('/user');
  }

  /** Scopes of the token in use (GitLab 15.5+). Undefined when the server does not support it. */
  async tokenInfo(): Promise<TokenInfo | undefined> {
    try {
      return await this.get<TokenInfo>('/personal_access_tokens/self');
    } catch {
      return undefined;
    }
  }

  project(pathOrId: string | number): Promise<GitLabProject> {
    return this.get(`/projects/${enc(pathOrId)}`);
  }

  async latestPipeline(project: number, ref: { branch?: string; sha?: string }): Promise<GitLabPipeline | undefined> {
    const list = await this.get<GitLabPipeline[]>(`/projects/${project}/pipelines`, { per_page: 1, order_by: 'id', sort: 'desc', ref: ref.branch, sha: ref.branch ? undefined : ref.sha });
    return list[0];
  }

  retryPipeline(project: number, pipelineId: number): Promise<GitLabPipeline> {
    return this.request<GitLabPipeline>('POST', `/projects/${project}/pipelines/${pipelineId}/retry`).then((r) => r.data);
  }

  async openMergeRequest(project: number, sourceBranch: string): Promise<GitLabMergeRequest | undefined> {
    const list = await this.get<GitLabMergeRequest[]>(`/projects/${project}/merge_requests`, { state: 'opened', source_branch: sourceBranch, per_page: 5 });
    return list[0];
  }

  async approvals(project: number, iid: number): Promise<GitLabApprovals | undefined> {
    try {
      return await this.get<GitLabApprovals>(`/projects/${project}/merge_requests/${iid}/approvals`);
    } catch {
      return undefined;
    }
  }

  createMergeRequest(project: number, mr: NewMergeRequest): Promise<GitLabMergeRequest> {
    const title = mr.draft && !/^(draft:|\[draft\])/i.test(mr.title) ? `Draft: ${mr.title}` : mr.title;
    return this.request<GitLabMergeRequest>('POST', `/projects/${project}/merge_requests`, undefined, {
      source_branch: mr.sourceBranch,
      target_branch: mr.targetBranch,
      title,
      description: mr.description,
      remove_source_branch: mr.removeSourceBranch ?? true,
      squash: mr.squash ?? false
    }).then((r) => r.data);
  }

  groups(search?: string): Promise<GitLabGroup[]> {
    return this.paginate<GitLabGroup>('/groups', { min_access_level: 10, order_by: 'path', sort: 'asc', all_available: false, search }, 1000);
  }

  groupProjects(group: string | number): Promise<GitLabProject[]> {
    return this.paginate<GitLabProject>(`/groups/${enc(group)}/projects`, { include_subgroups: true, archived: false, order_by: 'path', sort: 'asc', with_shared: false }, 2000);
  }
}

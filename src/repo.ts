import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitError, GitRunner, RunOptions } from './git/runner';
import { FileEntry, StatusInfo, changedPathCount, parseRemotes, parseStatusV2 } from './git/parse';
import { OperationKind, RepoFacts } from './model/types';

/** One tracked Git repository and its last-read state. */
export class Repo {
  readonly name: string;
  gitDir: string | undefined;
  commonDir: string | undefined;
  status: StatusInfo | undefined;
  operation: OperationKind | null = null;
  lastCommitTime = 0;
  remotes = new Map<string, string>();
  error: string | null = null;
  loaded = false;
  fetching = false;
  lastFetch = 0;
  private signature = '';

  constructor(
    readonly root: string,
    public key: string,
    private readonly runner: GitRunner
  ) {
    this.name = path.basename(root) || root;
  }

  git(args: readonly string[], opts: Partial<RunOptions> = {}): Promise<string> {
    return this.runner.run(args, { cwd: this.root, ...opts });
  }

  get branch(): string | null {
    return this.status?.branch ?? null;
  }
  get detached(): boolean {
    return this.status?.detached ?? false;
  }
  get headShort(): string | null {
    return this.status?.oid ? this.status.oid.slice(0, 8) : null;
  }
  get upstream(): string | null {
    return this.status?.upstream ?? null;
  }
  get ahead(): number {
    return this.status?.ahead ?? 0;
  }
  get behind(): number {
    return this.status?.behind ?? 0;
  }
  get staged(): FileEntry[] {
    return this.status?.staged ?? [];
  }
  get unstaged(): FileEntry[] {
    return this.status?.unstaged ?? [];
  }
  get conflicts(): FileEntry[] {
    return this.status?.conflicts ?? [];
  }
  get changed(): number {
    return this.status ? changedPathCount(this.status) : 0;
  }
  get branchLabel(): string {
    if (this.branch) return this.branch;
    if (this.detached) return `${this.headShort ?? 'HEAD'} (detached)`;
    return this.loaded ? 'no commits' : '…';
  }

  /** Remote that the upstream points to, else origin, else the first remote. */
  get primaryRemote(): { name: string; url: string } | undefined {
    const upRemote = this.upstream ? [...this.remotes.keys()].find((r) => this.upstream!.startsWith(r + '/')) : undefined;
    const name = upRemote ?? (this.remotes.has('origin') ? 'origin' : [...this.remotes.keys()][0]);
    return name ? { name, url: this.remotes.get(name)! } : undefined;
  }

  facts(folderNames: string[] = []): RepoFacts {
    return {
      key: this.key,
      name: this.name,
      root: this.root,
      branch: this.branch,
      detached: this.detached,
      headShort: this.headShort,
      upstream: this.upstream,
      ahead: this.ahead,
      behind: this.behind,
      changed: this.changed,
      staged: this.staged.length,
      conflicts: this.conflicts.length,
      operation: this.operation,
      lastCommitTime: this.lastCommitTime,
      remoteUrls: [...this.remotes.values()],
      folderNames,
      error: this.error,
      loaded: this.loaded,
      ci: null,
      mr: null,
      mrConflicts: false
    };
  }

  /** Re-reads status. Returns true when anything visible changed. */
  async refresh(): Promise<boolean> {
    try {
      if (!this.gitDir) {
        const out = await this.git(['rev-parse', '--absolute-git-dir', '--git-common-dir'], { readOnly: true });
        const [gitDir, common] = out.split(/\r?\n/);
        this.gitDir = gitDir.trim();
        this.commonDir = path.resolve(this.root, common.trim());
      }
      const [statusOut, logOut, remoteOut] = await Promise.all([
        this.git(['status', '--porcelain=v2', '--branch', '-z'], { readOnly: true }),
        this.git(['log', '-1', '--format=%ct'], { readOnly: true }).catch(() => ''),
        this.git(['remote', '-v'], { readOnly: true }).catch(() => '')
      ]);
      this.status = parseStatusV2(statusOut);
      this.lastCommitTime = Number(logOut.trim()) || 0;
      this.remotes = parseRemotes(remoteOut);
      this.operation = this.detectOperation();
      this.lastFetch = Math.max(this.lastFetch, this.fetchHeadTime());
      this.error = null;
    } catch (e) {
      this.error = e instanceof GitError ? e.message : String(e);
    }
    this.loaded = true;
    const sig = JSON.stringify([this.status, this.operation, this.error, this.lastCommitTime, [...this.remotes], this.fetching]);
    const changed = sig !== this.signature;
    this.signature = sig;
    return changed;
  }

  private detectOperation(): OperationKind | null {
    const dir = this.gitDir;
    if (!dir) return null;
    const has = (name: string) => fs.existsSync(path.join(dir, name));
    if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
    if (has('MERGE_HEAD')) return 'merge';
    if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (has('REVERT_HEAD')) return 'revert';
    if (has('BISECT_LOG')) return 'bisect';
    return null;
  }

  private fetchHeadTime(): number {
    try {
      return fs.statSync(path.join(this.commonDir ?? this.gitDir ?? path.join(this.root, '.git'), 'FETCH_HEAD')).mtimeMs;
    } catch {
      return 0;
    }
  }
}

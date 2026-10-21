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
  /** Network operations running right now (innermost last), e.g. "Pushing"; shown as a spinner in the tree. */
  readonly activity: string[] = [];
  lastFetch = 0;
  /** Working tree of the repository this one is a submodule of, if any. */
  superRoot: string | undefined;
  /**
   * Key of the repository whose .gitmodules declared this one, when it was found that way (not by scanning).
   * Such submodules are opt-in rows: not in Fetch All, totals or profiles.
   */
  declaredBy: string | undefined;
  /** Not read yet: a declared submodule stays unloaded (no git, no watchers) until its parent is expanded. */
  lazy = false;
  /** Submodule paths from .gitmodules, and that file's mtime when read. */
  submodulePaths: string[] = [];
  gitmodulesTime = 0;
  private signature = '';
  /** mtime of the repository's config file when remotes were last read. */
  private configTime = 0;

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

  /**
   * Re-reads status. Returns true when anything visible changed. `priority` skips the status queue (use it for
   * refreshes the user is waiting on, e.g. right after their own command). Usually one git process: the last
   * commit time is re-read only when HEAD moved, and remotes only when the repository's config file changed.
   * `provided` (status and remotes from VS Code's built-in Git) replaces `git status` and `git remote`, so a
   * refresh then usually runs no git process at all.
   */
  async refresh(priority = false, provided?: { status: StatusInfo; remotes: Map<string, string> }): Promise<boolean> {
    const ro = { readOnly: true, priority };
    try {
      if (!this.gitDir) await this.locateGitDir(ro);
      const gitDir = this.gitDir!;
      const configTime = await mtime(path.join(this.commonDir ?? gitDir, 'config'));
      const [statusOut, remoteOut, operation, fetchHead] = await Promise.all([
        provided ? Promise.resolve('') : this.git(['status', '--porcelain=v2', '--branch', '-z'], ro),
        provided || (configTime === this.configTime && configTime) ? Promise.resolve(undefined) : this.git(['remote', '-v'], ro).catch(() => undefined),
        this.detectOperation(),
        this.fetchHeadTime()
      ]);
      const status = provided ? provided.status : parseStatusV2(statusOut);
      if (status.oid !== this.status?.oid || !this.lastCommitTime) {
        this.lastCommitTime = status.oid ? Number((await this.git(['log', '-1', '--format=%ct'], ro).catch(() => '')).trim()) || 0 : 0;
      }
      this.status = status;
      if (provided) {
        // Remotes as of this config file; CANOPY's own next read reruns `git remote` only if the file changes.
        this.remotes = provided.remotes;
        this.configTime = configTime;
      } else if (remoteOut !== undefined) {
        this.remotes = parseRemotes(remoteOut);
        this.configTime = configTime;
      }
      this.operation = operation;
      this.lastFetch = Math.max(this.lastFetch, fetchHead);
      this.error = null;
    } catch (e) {
      this.error = e instanceof GitError ? e.message : String(e);
    }
    this.loaded = true;
    const sig = JSON.stringify([this.status, this.operation, this.error, this.lastCommitTime, [...this.remotes], this.superRoot]);
    const changed = sig !== this.signature;
    this.signature = sig;
    return changed;
  }

  /**
   * Finds the git directory. An ordinary repository (a `.git` folder) needs no git process; a `.git` file
   * (submodule or worktree) is resolved by one `rev-parse`, which also names the superproject.
   */
  private async locateGitDir(ro: Partial<RunOptions>): Promise<void> {
    const dotGit = path.join(this.root, '.git');
    const isDir = await fs.promises.stat(dotGit).then((s) => s.isDirectory(), () => false);
    if (isDir && !(await exists(path.join(dotGit, 'commondir')))) {
      this.gitDir = dotGit;
      this.commonDir = dotGit;
      return;
    }
    // The superproject line is printed only inside a submodule.
    const out = await this.git(['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-superproject-working-tree'], ro);
    const [gitDir, common, sup] = out.split(/\r?\n/).map((l) => l.trim());
    this.gitDir = gitDir;
    this.commonDir = path.resolve(this.root, common);
    this.superRoot = sup ? path.resolve(sup) : undefined;
  }

  private async detectOperation(): Promise<OperationKind | null> {
    const dir = this.gitDir;
    if (!dir) return null;
    const names = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
    const [rebaseMerge, rebaseApply, merge, cherry, revert, bisect] = await Promise.all(names.map((n) => exists(path.join(dir, n))));
    if (rebaseMerge || rebaseApply) return 'rebase';
    if (merge) return 'merge';
    if (cherry) return 'cherry-pick';
    if (revert) return 'revert';
    if (bisect) return 'bisect';
    return null;
  }

  private fetchHeadTime(): Promise<number> {
    return mtime(path.join(this.commonDir ?? this.gitDir ?? path.join(this.root, '.git'), 'FETCH_HEAD'));
  }
}

async function mtime(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

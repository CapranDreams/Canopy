import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitError } from '../git/runner';
import { Log } from '../log';
import { RepoManager } from '../manager';
import { Repo } from '../repo';
import { openCommitFileDiff, openMergeEditor } from '../gitContent';
import { parseNameStatusZ, parseNumstatZ, withLineStats } from '../git/parse';
import { timeAgo } from '../tree';
import { askRefName, listBranches, listStashes, listTags, listWorktrees, pickBranch, pickCommit, pickRemote, pickRemoteBranch, pickStash } from '../pickers';
import { validateCloneUrl } from '../util/remote';
import { mapLimit } from '../util/limit';

/** How the views describe a running git command (the tree's spinner text and the details panel's busy button). */
const ACTIVITY: Record<string, string> = {
  pull: 'Pulling',
  push: 'Pushing',
  fetch: 'Fetching',
  commit: 'Committing',
  stash: 'Stashing',
  switch: 'Switching branch',
  checkout: 'Switching branch',
  branch: 'Updating branches',
  tag: 'Tagging',
  merge: 'Merging',
  rebase: 'Rebasing',
  'cherry-pick': 'Cherry-picking',
  revert: 'Reverting',
  reset: 'Resetting',
  clean: 'Cleaning',
  worktree: 'Updating worktrees',
  remote: 'Updating remotes',
  submodule: 'Updating submodules'
};
/** Staging commands finish instantly; a spinner for them would only flicker. */
const NO_ACTIVITY = new Set(['add', 'restore', 'rm']);

export interface ExecOptions {
  title?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Show a notification with progress (long-running network operations). */
  notify?: boolean;
  /** Don't show an error message on failure (caller handles it). */
  quiet?: boolean;
  timeoutMs?: number;
  /** When git exits with an error, return true if the work was in fact done (the failure was only git's cleanup). */
  succeededAnyway?: () => Promise<boolean>;
}

type RepoHandler = (repos: Repo[], arg?: unknown) => Promise<unknown>;

/** Implements every Git operation CANOPY exposes. Handlers receive the target repos. */
export class GitOps {
  constructor(
    private readonly manager: RepoManager,
    private readonly log: Log
  ) {}

  // --- execution helpers ----------------------------------------------------

  async exec(repo: Repo, args: string[], opts: ExecOptions = {}): Promise<string | undefined> {
    const title = opts.title ?? `git ${args[0]}`;
    const run = () => repo.git(args, { input: opts.input, env: opts.env, priority: true, timeoutMs: opts.timeoutMs ?? 10 * 60_000 });
    const activity = NO_ACTIVITY.has(args[0]) ? undefined : (ACTIVITY[args[0]] ?? 'Working');
    if (activity) this.manager.beginActivity(repo, activity);
    try {
      const out = opts.notify
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${repo.name}: ${title}…` }, run)
        : await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title }, () =>
            vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${repo.name}: ${title}` }, run)
          );
      return out;
    } catch (e) {
      if (opts.succeededAnyway && (await opts.succeededAnyway().catch(() => false))) {
        this.log.info(`${repo.name}: ${title}: git reported an error, but the change was made; treating it as done.`);
        return '';
      }
      if (!opts.quiet) await this.reportError(repo, e, title);
      return undefined;
    } finally {
      if (activity) this.manager.endActivity(repo, activity);
      await this.manager.refresh(repo);
    }
  }

  async reportError(repo: Repo, e: unknown, title: string): Promise<void> {
    const msg = e instanceof GitError ? e.message : String(e);
    await this.manager.refresh(repo);
    if (repo.conflicts.length) {
      const a = await vscode.window.showWarningMessage(`${repo.name}: ${title} stopped with ${repo.conflicts.length} conflicted file(s).`, 'Open Conflicts', 'Abort', 'Show Output');
      if (a === 'Open Conflicts') await this.openConflicts([repo]);
      else if (a === 'Abort') await this.abortOperation([repo]);
      else if (a) this.log.show();
      return;
    }
    const a = await vscode.window.showErrorMessage(`${repo.name}: ${title} failed: ${msg}`, 'Show Output', 'Open in Terminal');
    if (a === 'Show Output') this.log.show();
    else if (a === 'Open in Terminal') this.openInTerminal([repo]);
  }

  private async confirm(message: string, detail: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  }

  private async forEachRepo(repos: Repo[], title: string, fn: (r: Repo) => Promise<boolean>): Promise<void> {
    if (repos.length === 1) {
      await fn(repos[0]);
      return;
    }
    const failed: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${title} in ${repos.length} repositories`, cancellable: false }, async (progress) => {
      let done = 0;
      await mapLimit(repos, 4, async (r) => {
        if (!(await fn(r))) failed.push(r.name);
        progress.report({ increment: 100 / repos.length, message: `${++done}/${repos.length}` });
      });
    });
    if (failed.length) {
      const a = await vscode.window.showWarningMessage(`${title}: ${repos.length - failed.length} succeeded, failed in ${failed.join(', ')}.`, 'Show Output');
      if (a) this.log.show();
    } else {
      void vscode.window.setStatusBarMessage(`$(check) ${title}: ${repos.length} repositories`, 4000);
    }
  }

  /** Handlers by command id (without the "canopy." prefix). `multi` handlers accept many repos. */
  handlers(): Record<string, { run: RepoHandler; multi?: boolean }> {
    const one = (fn: (r: Repo, arg?: unknown) => Promise<unknown>) => ({ run: (repos: Repo[], arg?: unknown) => fn(repos[0], arg) });
    const many = (fn: RepoHandler) => ({ run: fn, multi: true });
    return {
      sync: many((rs) => this.sync(rs)),
      pull: many((rs) => this.pull(rs, rs.length > 1 ? this.bulkPullMode() : 'default')),
      pullRebase: many((rs) => this.pull(rs, 'rebase')),
      pullFfOnly: many((rs) => this.pull(rs, 'ff-only')),
      pullFrom: one((r) => this.pullFrom(r)),
      pullSubmodules: many((rs) =>
        this.forEachRepo(rs, 'Pull with submodules', async (r) => {
          const quiet = rs.length > 1;
          // pull --recurse-submodules moves initialized submodules; update --init also fetches ones never cloned.
          if ((await this.exec(r, ['pull', '--recurse-submodules'], { title: 'Pull with submodules', notify: !quiet, quiet })) === undefined) return false;
          return (await this.exec(r, ['submodule', 'update', '--init', '--recursive'], { title: 'Update submodules', notify: !quiet, quiet })) !== undefined;
        })
      ),
      push: many((rs) => this.push(rs)),
      pushTo: one((r) => this.pushTo(r)),
      publishBranch: one((r) => this.publish(r)),
      pushTags: many((rs) => this.forEachRepo(rs, 'Push tags', async (r) => (await this.exec(r, ['push', '--tags'], { title: 'Push tags', notify: rs.length === 1, quiet: rs.length > 1 })) !== undefined)),
      forcePushWithLease: one((r) => this.forcePush(r)),
      forcePush: one((r) => this.forcePush(r, true)),
      fetch: many((rs) => this.fetch(rs, {})),
      fetchPrune: many((rs) => this.fetch(rs, { prune: true })),
      fetchAllRemotes: many((rs) => this.fetch(rs, { allRemotes: true })),
      checkout: one((r) => this.checkout(r)),
      switchBranch: one((r) => this.checkout(r)),
      createBranch: one((r) => this.createBranch(r)),
      createBranchFrom: one((r) => this.createBranchFrom(r)),
      renameBranch: one((r) => this.renameBranch(r)),
      deleteBranch: one((r) => this.deleteBranch(r)),
      deleteRemoteBranch: one((r) => this.deleteRemoteBranch(r)),
      pruneMergedBranches: one((r) => this.pruneMerged(r)),
      pruneRemoteBranches: many((rs) => this.forEachRepo(rs, 'Prune remote branches', (r) => this.pruneRemotes(r, rs.length === 1))),
      pruneGoneBranches: one((r) => this.pruneLocal(r, { gone: true, merged: false })),
      pruneAll: one((r) => this.pruneLocal(r, { gone: true, merged: true })),
      pruneWorktrees: one(async (r) => {
        if ((await this.exec(r, ['worktree', 'prune', '--verbose'], { title: 'Prune worktrees' })) !== undefined) void vscode.window.setStatusBarMessage(`$(check) ${r.name}: stale worktree records removed`, 4000);
      }),
      setUpstream: one((r) => this.setUpstream(r)),
      merge: one((r) => this.merge(r, [])),
      mergeNoFf: one((r) => this.merge(r, ['--no-ff'])),
      mergeSquash: one((r) => this.merge(r, ['--squash'])),
      rebaseOntoUpstream: one((r) => this.rebaseOntoUpstream(r)),
      rebaseOnto: one((r) => this.rebaseOnto(r)),
      rebaseInteractive: one((r) => this.rebaseInteractive(r)),
      continueOperation: one((r) => this.continueOperation(r)),
      skipOperation: one((r) => this.skipOperation(r)),
      abortOperation: many((rs) => this.abortOperation(rs)),
      openConflicts: many((rs) => this.openConflicts(rs)),
      openMergeTool: one(async (r) => this.runInTerminal(r, 'git mergetool', 'merge tool')),
      acceptAllCurrent: one((r) => this.acceptAll(r, 'ours')),
      acceptAllIncoming: one((r) => this.acceptAll(r, 'theirs')),
      stash: many((rs) => this.stash(rs, [])),
      stashIncludeUntracked: many((rs) => this.stash(rs, ['--include-untracked'])),
      stashStaged: many((rs) => this.stash(rs, ['--staged'])),
      stashApplyLatest: one((r) => this.exec(r, ['stash', 'apply'], { title: 'Apply stash' })),
      stashPopLatest: one((r) => this.exec(r, ['stash', 'pop'], { title: 'Pop stash' })),
      stashApply: one((r) => this.stashPick(r, 'apply')),
      stashPop: one((r) => this.stashPick(r, 'pop')),
      stashDrop: one((r) => this.stashPick(r, 'drop')),
      stashView: one((r) => this.stashView(r)),
      stashClear: one((r) => this.stashClear(r)),
      commit: one((r, arg) => this.commit(r, typeof arg === 'string' ? arg : undefined, [])),
      commitAll: one((r) => this.commitAll(r)),
      commitAmend: one((r) => this.commitAmend(r)),
      undoLastCommit: one((r) => this.undoLastCommit(r)),
      stageAll: many((rs) => this.forEachRepo(rs, 'Stage all', async (r) => (await this.exec(r, ['add', '-A'], { title: 'Stage all' })) !== undefined)),
      unstageAll: many((rs) => this.forEachRepo(rs, 'Unstage all', async (r) => (await this.unstage(r, [])) !== undefined)),
      discardAll: one((r) => this.discard(r, undefined)),
      cleanUntracked: one((r) => this.cleanUntracked(r)),
      cherryPick: one((r) => this.cherryPick(r)),
      revertCommit: one((r) => this.revert(r)),
      resetTo: one((r) => this.resetTo(r)),
      createTag: one((r) => this.createTag(r)),
      deleteTag: one((r) => this.deleteTag(r)),
      addRemote: one((r) => this.addRemote(r)),
      removeRemote: one((r) => this.removeRemote(r)),
      worktreeAdd: one((r) => this.worktreeAdd(r)),
      worktreeOpen: one((r) => this.worktreeOpen(r)),
      worktreeRemove: one((r) => this.worktreeRemove(r)),
      submoduleUpdate: many((rs) => this.forEachRepo(rs, 'Update submodules', async (r) => (await this.exec(r, ['submodule', 'update', '--init', '--recursive'], { title: 'Update submodules', notify: rs.length === 1 })) !== undefined)),
      openInTerminal: many(async (rs) => this.openInTerminal(rs)),
      revealInOS: one(async (r) => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.root))),
      openInNewWindow: one(async (r) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(r.root), { forceNewWindow: true })),
      addToWorkspace: many(async (rs) => {
        const existing = vscode.workspace.workspaceFolders ?? [];
        const add = rs.filter((r) => !existing.some((f) => f.uri.fsPath.toLowerCase() === r.root.toLowerCase())).map((r) => ({ uri: vscode.Uri.file(r.root), name: r.name }));
        if (add.length) vscode.workspace.updateWorkspaceFolders(existing.length, 0, ...add);
      }),
      copyPath: many(async (rs) => vscode.env.clipboard.writeText(rs.map((r) => r.root).join('\n')))
    };
  }

  // --- pull / push / fetch ----------------------------------------------------

  private bulkPullMode(): 'ff-only' | 'rebase' | 'default' {
    const mode = vscode.workspace.getConfiguration('canopy').get<string>('bulkPullMode', 'ff-only');
    return mode === 'rebase' ? 'rebase' : mode === 'merge' ? 'default' : 'ff-only';
  }

  async pull(repos: Repo[], mode: 'default' | 'rebase' | 'ff-only'): Promise<void> {
    const args = ['pull', ...(mode === 'rebase' ? ['--rebase', '--autostash'] : mode === 'ff-only' ? ['--ff-only'] : [])];
    const label = mode === 'rebase' ? 'Pull (rebase)' : mode === 'ff-only' ? 'Pull (fast-forward)' : 'Pull';
    const skipped: string[] = [];
    const targets = repos.filter((r) => {
      if (repos.length > 1 && (r.operation || r.conflicts.length || !r.upstream)) {
        skipped.push(`${r.name} (${r.operation ? r.operation + ' in progress' : r.conflicts.length ? 'conflicts' : 'no upstream'})`);
        return false;
      }
      return true;
    });
    if (repos.length === 1 && !repos[0].upstream) {
      const r = repos[0];
      const a = await vscode.window.showWarningMessage(`${r.branchLabel} in ${r.name} has no upstream branch.`, 'Pull from…', 'Publish Branch');
      if (a === 'Pull from…') await this.pullFrom(r);
      else if (a === 'Publish Branch') await this.publish(r);
      return;
    }
    await this.forEachRepo(targets, label, async (r) => (await this.exec(r, args, { title: label, notify: targets.length === 1, quiet: targets.length > 1 })) !== undefined);
    if (skipped.length) void vscode.window.showInformationMessage(`Skipped: ${skipped.join(', ')}`);
  }

  private async pullFrom(r: Repo): Promise<void> {
    const remote = await pickRemote(r, 'Pull from which remote?');
    if (!remote) return;
    await this.manager.fetch(r, {});
    const branch = await pickRemoteBranch(r, remote, `Pull which branch from ${remote}?`);
    if (branch) await this.exec(r, ['pull', remote, branch], { title: `Pull ${remote}/${branch}`, notify: true });
  }

  async push(repos: Repo[]): Promise<void> {
    if (repos.length === 1 && !repos[0].upstream && repos[0].branch) {
      await this.publish(repos[0]);
      return;
    }
    const targets = repos.filter((r) => r.upstream);
    await this.forEachRepo(targets, 'Push', async (r) => (await this.exec(r, ['push'], { title: 'Push', notify: targets.length === 1, quiet: targets.length > 1 })) !== undefined);
  }

  private async pushTo(r: Repo): Promise<void> {
    if (!r.branch) return void vscode.window.showWarningMessage('Check out a branch first.');
    const remote = await pickRemote(r, 'Push to which remote?');
    if (remote) await this.exec(r, ['push', remote, r.branch], { title: `Push to ${remote}`, notify: true });
  }

  async publish(r: Repo): Promise<void> {
    if (!r.branch) return void vscode.window.showWarningMessage('Check out a branch first.');
    const remote = await pickRemote(r, `Publish ${r.branch} to which remote?`);
    if (remote) await this.exec(r, ['push', '-u', remote, r.branch], { title: `Publish ${r.branch}`, notify: true });
  }

  private async forcePush(r: Repo, unconditional = false): Promise<void> {
    const detail = unconditional
      ? 'This overwrites the remote branch even if someone else pushed commits you do not have; their commits are lost. Prefer Force Push (With Lease) unless you are sure.'
      : 'This overwrites the remote branch. --force-with-lease refuses if someone else pushed since your last fetch.';
    if (!(await this.confirm(`Force push ${r.branchLabel} in ${r.name}?`, detail, unconditional ? 'Force Push Anyway' : 'Force Push'))) return;
    await this.exec(r, ['push', unconditional ? '--force' : '--force-with-lease'], { title: 'Force push', notify: true });
  }

  async sync(repos: Repo[]): Promise<void> {
    const rebase = vscode.workspace.getConfiguration('git').get<boolean>('rebaseWhenSync', false);
    await this.forEachRepo(repos, 'Sync', async (r) => {
      if (!r.upstream) {
        if (repos.length === 1 && r.branch) await this.publish(r);
        return repos.length === 1;
      }
      this.manager.beginActivity(r, 'Syncing');
      try {
        if (r.behind > 0 || repos.length > 1) {
          if ((await this.exec(r, ['pull', ...(rebase ? ['--rebase', '--autostash'] : [])], { title: 'Pull', quiet: repos.length > 1 })) === undefined) return false;
        }
        if (r.ahead > 0) return (await this.exec(r, ['push'], { title: 'Push', quiet: repos.length > 1 })) !== undefined;
        return true;
      } finally {
        this.manager.endActivity(r, 'Syncing');
      }
    });
  }

  private async fetch(repos: Repo[], opts: { prune?: boolean; allRemotes?: boolean }): Promise<void> {
    if (repos.length === 1) {
      await this.manager.fetch(repos[0], opts);
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Fetching ${repos.length} repositories` }, () => this.manager.fetchAll(repos, opts));
  }

  // --- branches ---------------------------------------------------------------

  private async checkout(r: Repo): Promise<void> {
    const pick = await pickBranch(r, { placeHolder: `Switch branch in ${r.name} (now on ${r.branchLabel})`, excludeCurrent: true, allowCreate: true, tags: true });
    if (!pick) return;
    if (pick.kind === 'create') return this.createBranch(r);
    await this.switchTo(r, pick.kind, pick.name);
  }

  async switchTo(r: Repo, kind: 'local' | 'remote' | 'tag', name: string): Promise<boolean> {
    let args: string[];
    if (kind === 'local') args = ['switch', name];
    else if (kind === 'tag') args = ['switch', '--detach', name];
    else {
      const local = name.split('/').slice(1).join('/');
      const branches = await listBranches(r);
      args = branches.some((b) => !b.remote && b.name === local) ? ['switch', local] : ['switch', '--track', name];
    }
    const out = await this.exec(r, args, { title: `Checkout ${name}`, quiet: true });
    if (out !== undefined) return true;
    const a = await vscode.window.showWarningMessage(`Could not check out ${name} in ${r.name}. Local changes may conflict.`, 'Stash & Checkout', 'Show Output');
    if (a === 'Stash & Checkout') {
      if ((await this.exec(r, ['stash', 'push', '--include-untracked', '-m', `CANOPY: before checkout ${name}`], { title: 'Stash' })) === undefined) return false;
      return (await this.exec(r, args, { title: `Checkout ${name}` })) !== undefined;
    }
    if (a) this.log.show();
    return false;
  }

  private async createBranch(r: Repo, from?: string): Promise<void> {
    const name = await askRefName(from ? `New branch from ${from}` : `New branch in ${r.name}`, '', 'feature/my-change');
    if (name) await this.exec(r, ['switch', '-c', name, ...(from ? [from] : [])], { title: `Create branch ${name}` });
  }

  private async createBranchFrom(r: Repo): Promise<void> {
    const pick = await pickBranch(r, { placeHolder: 'Create the new branch from…', tags: true });
    if (pick && pick.kind !== 'create') await this.createBranch(r, pick.name);
  }

  async createBranchAt(r: Repo, sha: string): Promise<void> {
    return this.createBranch(r, sha);
  }

  private async renameBranch(r: Repo): Promise<void> {
    if (!r.branch) return void vscode.window.showWarningMessage('Check out a branch first.');
    const name = await askRefName(`Rename ${r.branch} to`, r.branch);
    if (name && name !== r.branch) await this.exec(r, ['branch', '-m', name], { title: `Rename to ${name}` });
  }

  private async deleteBranch(r: Repo): Promise<void> {
    const pick = await pickBranch(r, { placeHolder: 'Delete which branch?', remote: false, excludeCurrent: true });
    if (!pick || pick.kind !== 'local') return;
    if ((await this.exec(r, ['branch', '-d', pick.name], { title: `Delete ${pick.name}`, quiet: true })) !== undefined) return;
    if (await this.confirm(`${pick.name} is not fully merged.`, 'Deleting it loses commits that are not on another branch.', 'Delete Anyway')) {
      await this.exec(r, ['branch', '-D', pick.name], { title: `Delete ${pick.name}` });
    }
  }

  private async deleteRemoteBranch(r: Repo): Promise<void> {
    const pick = await pickBranch(r, { placeHolder: 'Delete which remote branch?', local: false });
    if (!pick || pick.kind !== 'remote') return;
    const [remote, ...rest] = pick.name.split('/');
    const branch = rest.join('/');
    if (await this.confirm(`Delete ${pick.name} from ${remote}?`, 'This removes the branch on the server for everyone.', 'Delete Remote Branch')) {
      await this.exec(r, ['push', remote, '--delete', branch], { title: `Delete ${pick.name}`, notify: true });
    }
  }

  /** Local branches merged into the upstream (or current branch), minus long-lived ones and the current branch. */
  private async mergedBranches(r: Repo): Promise<{ base: string; names: string[] }> {
    const base = r.upstream ?? r.branch ?? 'HEAD';
    const out = await r.git(['branch', '--merged', base, '--format=%(refname:short)'], { readOnly: true });
    const keep = new Set(['main', 'master', 'develop', 'dev', 'trunk', r.branch ?? '']);
    return { base, names: out.split('\n').map((s) => s.trim()).filter((b) => b && !keep.has(b)) };
  }

  /** `git remote prune` on every remote: drops remote-tracking branches (origin/x) deleted on the server. */
  private async pruneRemotes(r: Repo, report: boolean): Promise<boolean> {
    if (!r.remotes.size) {
      if (report) void vscode.window.showInformationMessage(`${r.name} has no remotes.`);
      return true;
    }
    const pruned: string[] = [];
    for (const remote of r.remotes.keys()) {
      const out = await this.exec(r, ['remote', 'prune', remote], { title: `Prune ${remote}`, quiet: !report });
      if (out === undefined) return false;
      for (const m of out.matchAll(/\[pruned\]\s+(\S+)/g)) pruned.push(m[1]);
    }
    if (report) {
      void vscode.window.showInformationMessage(
        pruned.length
          ? `${r.name}: removed ${pruned.length} remote branch${pruned.length === 1 ? '' : 'es'} deleted on the server: ${pruned.join(', ')}`
          : `${r.name}: no remote branches to prune.`
      );
    }
    return true;
  }

  /** Local branches whose upstream no longer exists (run after pruning remotes). */
  private async goneBranches(r: Repo): Promise<string[]> {
    const out = await r.git(['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads'], { readOnly: true });
    return out
      .split('\n')
      .map((l) => l.split('\t'))
      .filter(([name, track]) => name && track === '[gone]')
      .map(([name]) => name);
  }

  /**
   * Prunes remote-tracking branches, then offers local branches to delete: those whose remote branch
   * is gone and/or those already merged. Unmerged ones need a second confirmation to force-delete.
   */
  private async pruneLocal(r: Repo, kinds: { gone: boolean; merged: boolean }): Promise<void> {
    if (kinds.gone && !(await this.pruneRemotes(r, false))) return;
    const gone = kinds.gone ? await this.goneBranches(r) : [];
    const merged = kinds.merged ? await this.mergedBranches(r) : { base: '', names: [] };
    const reasons = new Map<string, string[]>();
    for (const b of gone) reasons.set(b, ['deleted on remote']);
    for (const b of merged.names) reasons.set(b, [...(reasons.get(b) ?? []), `merged into ${merged.base}`]);
    const current = r.branch && reasons.has(r.branch) ? r.branch : undefined;
    if (current) reasons.delete(current);
    const what = kinds.merged ? 'gone on the remote or merged' : 'whose remote branch was deleted';
    const skipped = current ? ` The current branch ${current} qualifies too; switch away from it to delete it.` : '';
    if (!reasons.size) return void vscode.window.showInformationMessage(`${r.name}: no local branches ${what}.${skipped}`);
    const picks = await vscode.window.showQuickPick(
      [...reasons].map(([label, why]) => ({ label, description: why.join(' · '), picked: true })),
      { canPickMany: true, placeHolder: `${r.name}: local branches ${what}. Delete the checked ones.${skipped}` }
    );
    if (!picks?.length) return;
    const unmerged: string[] = [];
    for (const p of picks) {
      if ((await this.exec(r, ['branch', '-d', p.label], { title: `Delete ${p.label}`, quiet: true })) === undefined) unmerged.push(p.label);
    }
    const deleted = picks.length - unmerged.length;
    if (unmerged.length) {
      const force = await this.confirm(
        `${unmerged.length} branch${unmerged.length === 1 ? ' is' : 'es are'} not fully merged: ${unmerged.join(', ')}`,
        'Branches squash- or rebase-merged on the server often look unmerged locally. Force-deleting loses any commits that are not on another branch.',
        'Force Delete'
      );
      if (force) await this.exec(r, ['branch', '-D', ...unmerged], { title: `Force delete ${unmerged.length} branches` });
      else if (deleted) void vscode.window.showInformationMessage(`${r.name}: deleted ${deleted} branch${deleted === 1 ? '' : 'es'}; kept ${unmerged.join(', ')}.`);
      return;
    }
    void vscode.window.setStatusBarMessage(`$(check) ${r.name}: deleted ${deleted} branch${deleted === 1 ? '' : 'es'}`, 4000);
  }

  private async pruneMerged(r: Repo): Promise<void> {
    const { base, names: merged } = await this.mergedBranches(r);
    if (!merged.length) return void vscode.window.showInformationMessage(`No merged branches to prune in ${r.name}.`);
    const picks = await vscode.window.showQuickPick(merged.map((b) => ({ label: b, picked: true })), { canPickMany: true, placeHolder: `Branches merged into ${base}: delete the checked ones` });
    if (!picks?.length) return;
    await this.exec(r, ['branch', '-d', ...picks.map((p) => p.label)], { title: `Prune ${picks.length} branches` });
  }

  private async setUpstream(r: Repo): Promise<void> {
    if (!r.branch) return void vscode.window.showWarningMessage('Check out a branch first.');
    const pick = await pickBranch(r, { placeHolder: `Upstream for ${r.branch}`, local: false });
    if (pick && pick.kind === 'remote') await this.exec(r, ['branch', `--set-upstream-to=${pick.name}`], { title: 'Set upstream' });
  }

  // --- merge / rebase -----------------------------------------------------------

  private async merge(r: Repo, flags: string[]): Promise<void> {
    const pick = await pickBranch(r, { placeHolder: `Merge into ${r.branchLabel}`, excludeCurrent: true, tags: true });
    if (pick && pick.kind !== 'create') await this.mergeRef(r, pick.name, flags);
  }

  async mergeRef(r: Repo, ref: string, flags: string[] = []): Promise<void> {
    const out = await this.exec(r, ['merge', ...flags, '--no-edit', ref], { title: `Merge ${ref}` });
    if (out !== undefined && flags.includes('--squash')) {
      void vscode.window.showInformationMessage(`Squashed ${ref} into the index. Review and commit when ready.`);
    }
  }

  private async rebaseOntoUpstream(r: Repo): Promise<void> {
    if (!r.upstream) return void vscode.window.showWarningMessage(`${r.branchLabel} has no upstream.`);
    await this.exec(r, ['rebase', '--autostash', r.upstream], { title: `Rebase onto ${r.upstream}` });
  }

  private async rebaseOnto(r: Repo): Promise<void> {
    const pick = await pickBranch(r, { placeHolder: `Rebase ${r.branchLabel} onto…`, excludeCurrent: true, tags: true });
    if (pick && pick.kind !== 'create') await this.rebaseOntoRef(r, pick.name);
  }

  async rebaseOntoRef(r: Repo, ref: string): Promise<void> {
    await this.exec(r, ['rebase', '--autostash', ref], { title: `Rebase onto ${ref}` });
  }

  private async rebaseInteractive(r: Repo): Promise<void> {
    const pick = await pickCommit(r, 'Rebase the commits after which commit?', ['HEAD'], 100);
    if (pick) await this.interactiveRebaseFrom(r, pick.hash);
  }

  async interactiveRebaseFrom(r: Repo, sha: string): Promise<void> {
    const editor = codeEditorCommand();
    this.runInTerminal(r, `git rebase -i --autostash ${sha}`, 'interactive rebase', { GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: editor });
  }

  private operationVerb(r: Repo): string | undefined {
    return r.operation === 'bisect' ? undefined : r.operation ?? (r.conflicts.length ? 'merge' : undefined);
  }

  private async continueOperation(r: Repo): Promise<void> {
    await this.manager.refresh(r);
    const op = this.operationVerb(r);
    if (!op) return void vscode.window.showInformationMessage(`No merge, rebase or cherry-pick in progress in ${r.name}.`);
    if (r.conflicts.length) {
      const stillMarked = r.conflicts.filter((f) => hasConflictMarkers(path.join(r.root, f.path)));
      if (stillMarked.length) {
        const a = await vscode.window.showWarningMessage(`${stillMarked.length} file(s) still contain conflict markers.`, 'Open Conflicts');
        if (a) await this.openConflicts([r]);
        return;
      }
      const a = await vscode.window.showInformationMessage(`${r.conflicts.length} resolved file(s) are not staged yet.`, 'Stage & Continue');
      if (!a) return;
      if ((await this.exec(r, ['add', '--', ...r.conflicts.map((f) => f.path)], { title: 'Stage resolved files' })) === undefined) return;
    }
    const env = { GIT_EDITOR: 'true' };
    const args = op === 'merge' ? ['commit', '--no-edit'] : [op, '--continue'];
    await this.exec(r, args, { title: `Continue ${op}`, env });
  }

  private async skipOperation(r: Repo): Promise<void> {
    if (r.operation !== 'rebase' && r.operation !== 'cherry-pick') return void vscode.window.showInformationMessage('Only a rebase or cherry-pick can skip a commit.');
    await this.exec(r, [r.operation, '--skip'], { title: `Skip (${r.operation})`, env: { GIT_EDITOR: 'true' } });
  }

  async abortOperation(repos: Repo[]): Promise<void> {
    for (const r of repos) {
      await this.manager.refresh(r);
      const op = r.operation;
      if (!op) {
        void vscode.window.showInformationMessage(`Nothing to abort in ${r.name}.`);
        continue;
      }
      if (!(await this.confirm(`Abort the ${op} in ${r.name}?`, 'The repository returns to the state before the operation started.', 'Abort'))) continue;
      await this.exec(r, op === 'bisect' ? ['bisect', 'reset'] : [op, '--abort'], { title: `Abort ${op}` });
    }
  }

  async openConflicts(repos: Repo[]): Promise<void> {
    for (const r of repos) {
      if (!r.conflicts.length) continue;
      for (const f of r.conflicts) await openMergeEditor(r, f.path);
    }
  }

  private async acceptAll(r: Repo, side: 'ours' | 'theirs'): Promise<void> {
    const files = r.conflicts.map((f) => f.path);
    if (!files.length) return void vscode.window.showInformationMessage(`No conflicted files in ${r.name}.`);
    const label = side === 'ours' ? 'current' : 'incoming';
    if (!(await this.confirm(`Resolve ${files.length} file(s) in ${r.name} with the ${label} side?`, files.join('\n'), `Accept All ${label[0].toUpperCase() + label.slice(1)}`))) return;
    if ((await this.exec(r, ['checkout', `--${side}`, '--', ...files], { title: `Accept ${label}` })) === undefined) return;
    await this.exec(r, ['add', '--', ...files], { title: 'Stage resolved files' });
  }

  // --- stash -----------------------------------------------------------------------

  private async stash(repos: Repo[], flags: string[]): Promise<void> {
    let message = '';
    if (repos.length === 1) {
      const m = await vscode.window.showInputBox({ prompt: `Stash message for ${repos[0].name} (optional)`, placeHolder: 'Press Enter to stash without a message' });
      if (m === undefined) return;
      message = m.trim();
    }
    await this.forEachRepo(repos.filter((r) => r.changed > 0), 'Stash', async (r) => (await this.exec(r, ['stash', 'push', ...flags, ...(message ? ['-m', message] : [])], { title: 'Stash', quiet: repos.length > 1 })) !== undefined);
  }

  private async stashPick(r: Repo, action: 'apply' | 'pop' | 'drop'): Promise<void> {
    const s = await pickStash(r, `${action[0].toUpperCase() + action.slice(1)} which stash?`);
    if (!s) return;
    if (action === 'drop' && !(await this.confirm(`Drop ${s.ref}?`, s.message, 'Drop'))) return;
    await this.exec(r, ['stash', action, s.ref], { title: `${action} ${s.ref}` });
  }

  /** Lists stashes; picking one shows its files (click for a diff) plus Apply / Pop / Drop. */
  private async stashView(r: Repo): Promise<void> {
    const stashes = await listStashes(r);
    if (!stashes.length) return void vscode.window.showInformationMessage(`${r.name} has no stashes.`);
    const pick = await vscode.window.showQuickPick(
      stashes.map((s) => ({ label: s.ref, description: s.message, detail: s.time ? `stashed ${timeAgo(s.time * 1000)}` : undefined, s })),
      { title: `Stashes in ${r.name}`, placeHolder: 'Pick a stash to see its files and actions', matchOnDescription: true }
    );
    if (!pick) return;
    const s = pick.s;
    const hash = (await r.git(['rev-parse', s.ref], { readOnly: true })).trim();
    const listFiles = async (rev: string, extra: string[], status?: string) => {
      const diff = (fmt: string) => r.git(['diff-tree', '-r', '-z', '--no-commit-id', fmt, '-M', ...extra, rev, '--'], { readOnly: true });
      const [names, stats] = await Promise.all([diff('--name-status'), diff('--numstat').catch(() => '')]);
      return withLineStats(parseNameStatusZ(names), parseNumstatZ(stats)).map((f) => ({ ...f, status: status ?? f.status, rev }));
    };
    // The stash commit diffs its first parent (tracked changes); a third parent holds untracked files.
    const hasUntracked = (await r.git(['rev-parse', '--verify', '-q', `${hash}^3`], { readOnly: true }).catch(() => '')).trim() !== '';
    const files = [...(await listFiles(hash, ['--diff-merges=first-parent'])), ...(hasUntracked ? await listFiles(`${hash}^3`, ['--root'], 'A') : [])];
    type Item = vscode.QuickPickItem & { action?: 'apply' | 'pop' | 'drop'; file?: (typeof files)[number] };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `${s.ref}: ${s.message}`;
    qp.placeholder = 'Pick a file to see its diff, or an action';
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;
    qp.items = [
      { label: '$(check) Apply', description: 'restore these changes and keep the stash', action: 'apply' },
      { label: '$(arrow-up) Pop', description: 'restore these changes and delete the stash', action: 'pop' },
      { label: '$(trash) Drop…', description: 'delete the stash', action: 'drop' },
      { label: `Files · ${files.length}`, kind: vscode.QuickPickItemKind.Separator },
      ...files.map((f) => ({
        label: f.path,
        description: [f.status, typeof f.added === 'number' ? `+${f.added} −${f.deleted}` : '', f.rev.endsWith('^3') ? 'untracked' : ''].filter(Boolean).join('  '),
        file: f
      }))
    ];
    qp.onDidAccept(async () => {
      const item = qp.selectedItems[0];
      if (!item) return;
      if (item.file) {
        await openCommitFileDiff(r, item.file.path, item.file.rev, item.file.status, item.file.origPath);
        return;
      }
      qp.hide();
      if (item.action === 'drop' && !(await this.confirm(`Drop ${s.ref}?`, s.message, 'Drop'))) return;
      if (item.action) await this.exec(r, ['stash', item.action, s.ref], { title: `${item.action} ${s.ref}` });
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  private async stashClear(r: Repo): Promise<void> {
    if (await this.confirm(`Drop all stashes in ${r.name}?`, 'Dropped stashes can only be recovered with git fsck.', 'Drop All')) {
      await this.exec(r, ['stash', 'clear'], { title: 'Drop all stashes' });
    }
  }

  // --- commit / changes ---------------------------------------------------------------

  async commit(r: Repo, message: string | undefined, flags: string[], after?: 'push' | 'sync'): Promise<boolean> {
    if (!r.staged.length && !flags.includes('--amend')) {
      if (!r.changed) {
        void vscode.window.showInformationMessage(`Nothing to commit in ${r.name}.`);
        return false;
      }
      const a = await vscode.window.showInformationMessage(`There are no staged changes in ${r.name}. Stage all changes and commit them?`, { modal: true }, 'Stage All & Commit');
      if (!a) return false;
      if ((await this.exec(r, ['add', '-A'], { title: 'Stage all' })) === undefined) return false;
    }
    const msg = message?.trim() || (await vscode.window.showInputBox({ prompt: `Commit message (${r.name} on ${r.branchLabel})`, ignoreFocusOut: true }))?.trim();
    if (!msg) return false;
    const ok = (await this.exec(r, ['commit', ...flags, '-F', '-'], { title: 'Commit', input: msg })) !== undefined;
    if (ok && after === 'push') await this.push([r]);
    if (ok && after === 'sync') await this.sync([r]);
    return ok;
  }

  private async commitAll(r: Repo): Promise<void> {
    if ((await this.exec(r, ['add', '-A'], { title: 'Stage all' })) === undefined) return;
    await this.commit(r, undefined, []);
  }

  private async commitAmend(r: Repo): Promise<void> {
    const last = (await r.git(['log', '-1', '--format=%B'], { readOnly: true }).catch(() => '')).trim();
    const msg = await vscode.window.showInputBox({ prompt: 'Amend last commit: message', value: last, ignoreFocusOut: true });
    if (msg?.trim()) await this.exec(r, ['commit', '--amend', '-F', '-'], { title: 'Amend', input: msg.trim() });
  }

  private async undoLastCommit(r: Repo): Promise<void> {
    if (r.upstream && r.ahead === 0) {
      if (!(await this.confirm('The last commit is already pushed.', 'Undoing it rewrites history that others may have. Its changes stay staged.', 'Undo Anyway'))) return;
    }
    await this.exec(r, ['reset', '--soft', 'HEAD~1'], { title: 'Undo last commit' });
  }

  async stage(r: Repo, paths: string[]): Promise<void> {
    await this.exec(r, ['add', '-A', '--', ...paths], { title: 'Stage' });
  }

  async unstage(r: Repo, paths: string[]): Promise<string | undefined> {
    const spec = paths.length ? paths : ['.'];
    const out = await this.exec(r, ['restore', '--staged', '--', ...spec], { title: 'Unstage', quiet: true });
    if (out !== undefined) return out;
    // No HEAD yet (initial commit): fall back to removing from the index.
    return this.exec(r, ['rm', '--cached', '-r', '-q', '--', ...spec], { title: 'Unstage' });
  }

  /**
   * Discards unstaged changes (all when `paths` is undefined). With the safety-stash setting on, the
   * changes go into a stash instead of being thrown away, so the discard can be undone.
   */
  async discard(r: Repo, paths: string[] | undefined, confirmed = false): Promise<boolean> {
    const files = r.unstaged.filter((f) => !paths || paths.includes(f.path));
    if (!files.length) {
      void vscode.window.showInformationMessage(`No unstaged changes to discard in ${r.name}.`);
      return false;
    }
    const safety = vscode.workspace.getConfiguration('canopy').get<boolean>('discard.safetyStash', true);
    if (!confirmed) {
      const what = files.length === 1 ? files[0].path : `${files.length} files`;
      const detail = safety ? 'A safety stash is saved first, so you can restore them from Stash › Apply.' : 'This cannot be undone.';
      if (!(await this.confirm(`Discard changes in ${what}?`, detail + (files.length > 1 ? '\n\n' + files.map((f) => `${f.status}  ${f.path}`).slice(0, 15).join('\n') : ''), files.length === 1 ? 'Discard File' : `Discard ${files.length} Files`))) return false;
    }
    const spec = files.map((f) => f.path);
    if (safety) {
      const msg = `CANOPY safety stash: discarded ${files.length === 1 ? spec[0] : files.length + ' files'}`;
      // With --keep-index, --include-untracked and an untracked path, git saves the stash and removes the file but
      // then exits 1 ("pathspec ... did not match"). A new stash entry means the discard worked.
      const topStash = () => r.git(['rev-parse', '-q', '--verify', 'refs/stash'], { readOnly: true }).then((s) => s.trim(), () => '');
      const before = await topStash();
      return (await this.exec(r, ['stash', 'push', '--keep-index', '--include-untracked', '-m', msg, '--', ...spec], { title: 'Discard', succeededAnyway: async () => (await topStash()) !== before })) !== undefined;
    }
    const tracked = files.filter((f) => f.status !== 'U').map((f) => f.path);
    const untracked = files.filter((f) => f.status === 'U').map((f) => f.path);
    if (tracked.length && (await this.exec(r, ['restore', '--worktree', '--', ...tracked], { title: 'Discard' })) === undefined) return false;
    for (const u of untracked) {
      await vscode.workspace.fs.delete(vscode.Uri.file(path.join(r.root, u)), { recursive: true, useTrash: true });
    }
    await this.manager.refresh(r);
    return true;
  }

  private async cleanUntracked(r: Repo): Promise<void> {
    const preview = (await r.git(['clean', '-nd'], { readOnly: true })).trim();
    if (!preview) return void vscode.window.showInformationMessage(`No untracked files in ${r.name}.`);
    const list = preview.split('\n').map((l) => l.replace(/^Would remove /, ''));
    if (await this.confirm(`Delete ${list.length} untracked item(s) in ${r.name}?`, list.slice(0, 20).join('\n') + (list.length > 20 ? '\n…' : ''), 'Delete')) {
      await this.exec(r, ['clean', '-fd'], { title: 'Clean untracked' });
    }
  }

  // --- history ---------------------------------------------------------------------------

  private async cherryPick(r: Repo): Promise<void> {
    const branch = await pickBranch(r, { placeHolder: 'Cherry-pick from which branch?', excludeCurrent: true });
    if (!branch || branch.kind === 'create') return;
    const commit = await pickCommit(r, `Commits on ${branch.name} not on ${r.branchLabel}`, [`HEAD..${branch.name}`]);
    if (commit) await this.cherryPickSha(r, commit.hash);
  }

  async cherryPickSha(r: Repo, sha: string): Promise<void> {
    await this.exec(r, ['cherry-pick', sha], { title: `Cherry-pick ${sha.slice(0, 8)}` });
  }

  private async revert(r: Repo): Promise<void> {
    const commit = await pickCommit(r, 'Revert which commit?');
    if (commit) await this.revertSha(r, commit.hash);
  }

  async revertSha(r: Repo, sha: string): Promise<void> {
    await this.exec(r, ['revert', '--no-edit', sha], { title: `Revert ${sha.slice(0, 8)}` });
  }

  private async resetTo(r: Repo): Promise<void> {
    const commit = await pickCommit(r, `Reset ${r.branchLabel} to which commit?`);
    if (!commit) return;
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: 'keep changes staged', mode: 'soft' as const },
        { label: 'Mixed', description: 'keep changes, unstaged', mode: 'mixed' as const },
        { label: 'Hard', description: 'discard all changes', mode: 'hard' as const }
      ],
      { placeHolder: `Reset to ${commit.hash.slice(0, 8)} ${commit.subject}` }
    );
    if (mode) await this.resetSha(r, commit.hash, mode.mode);
  }

  async resetSha(r: Repo, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    if (mode === 'hard' && !(await this.confirm(`Hard reset ${r.branchLabel} to ${sha.slice(0, 8)}?`, 'All uncommitted changes and later commits on this branch are discarded.', 'Hard Reset'))) return;
    await this.exec(r, ['reset', `--${mode}`, sha], { title: `Reset (${mode})` });
  }

  async checkoutDetached(r: Repo, sha: string): Promise<void> {
    if (!(await this.confirm(`Check out ${sha.slice(0, 8)} in ${r.name}?`, 'You will be in detached HEAD state. Create a branch to keep any new commits.', 'Checkout'))) return;
    await this.exec(r, ['switch', '--detach', sha], { title: `Checkout ${sha.slice(0, 8)}` });
  }

  // --- tags / remotes / worktrees --------------------------------------------------------------

  async createTag(r: Repo, at?: string): Promise<void> {
    const name = await askRefName(`Tag name${at ? ` for ${at.slice(0, 8)}` : ''}`, '', 'v1.2.3');
    if (!name) return;
    const message = await vscode.window.showInputBox({ prompt: 'Tag message (leave empty for a lightweight tag)' });
    if (message === undefined) return;
    const args = message.trim() ? ['tag', '-a', name, '-m', message.trim()] : ['tag', name];
    await this.exec(r, [...args, ...(at ? [at] : [])], { title: `Tag ${name}` });
  }

  private async deleteTag(r: Repo): Promise<void> {
    const tags = await listTags(r);
    const pick = await vscode.window.showQuickPick(tags, { placeHolder: 'Delete which tag?' });
    if (!pick) return;
    if ((await this.exec(r, ['tag', '-d', pick], { title: `Delete tag ${pick}` })) === undefined) return;
    const remote = r.primaryRemote?.name;
    if (remote && (await vscode.window.showInformationMessage(`Also delete ${pick} from ${remote}?`, 'Delete on Remote'))) {
      await this.exec(r, ['push', remote, '--delete', `refs/tags/${pick}`], { title: `Delete remote tag ${pick}`, notify: true });
    }
  }

  private async addRemote(r: Repo): Promise<void> {
    const name = await askRefName('Remote name', r.remotes.size ? '' : 'origin');
    if (!name) return;
    const url = await vscode.window.showInputBox({ prompt: `URL for ${name}`, validateInput: validateCloneUrl, ignoreFocusOut: true });
    if (url) await this.exec(r, ['remote', 'add', name, url.trim()], { title: `Add remote ${name}` });
  }

  private async removeRemote(r: Repo): Promise<void> {
    const name = await pickRemote(r, 'Remove which remote?');
    if (name && (await this.confirm(`Remove remote ${name}?`, r.remotes.get(name) ?? '', 'Remove'))) {
      await this.exec(r, ['remote', 'remove', name], { title: `Remove remote ${name}` });
    }
  }

  private async worktreeAdd(r: Repo): Promise<void> {
    const pick = await pickBranch(r, { placeHolder: 'Worktree for which branch?', excludeCurrent: true, allowCreate: true });
    if (!pick) return;
    let branchArgs: string[];
    let label: string;
    if (pick.kind === 'create') {
      const name = await askRefName('New branch for the worktree');
      if (!name) return;
      branchArgs = ['-b', name];
      label = name;
    } else {
      label = pick.kind === 'remote' ? pick.name.split('/').slice(1).join('/') : pick.name;
      branchArgs = pick.kind === 'remote' ? ['-b', label, pick.name] : [pick.name];
    }
    const defaultPath = path.join(path.dirname(r.root), `${r.name}-${label.replace(/[\\/]/g, '-')}`);
    const target = await vscode.window.showInputBox({ prompt: 'Folder for the new worktree', value: defaultPath, ignoreFocusOut: true });
    if (!target) return;
    const args = pick.kind === 'create' ? ['worktree', 'add', ...branchArgs, target] : pick.kind === 'remote' ? ['worktree', 'add', '-b', label, target, pick.name] : ['worktree', 'add', target, pick.name];
    if ((await this.exec(r, args, { title: `Create worktree ${label}`, notify: true })) === undefined) return;
    const a = await vscode.window.showInformationMessage(`Created worktree at ${target}.`, 'Open in New Window', 'Add to CANOPY');
    if (a === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    else if (a === 'Add to CANOPY') await this.manager.addRepositories([target]);
  }

  private async worktreeOpen(r: Repo): Promise<void> {
    const list = (await listWorktrees(r)).filter((w) => path.resolve(w.path).toLowerCase() !== r.root.toLowerCase());
    if (!list.length) return void vscode.window.showInformationMessage(`${r.name} has no other worktrees.`);
    const pick = await vscode.window.showQuickPick(list.map((w) => ({ label: w.branch ?? w.head?.slice(0, 8) ?? '?', description: w.path, w })), { placeHolder: 'Open which worktree?' });
    if (pick) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(pick.w.path), { forceNewWindow: true });
  }

  private async worktreeRemove(r: Repo): Promise<void> {
    const list = (await listWorktrees(r)).filter((w) => path.resolve(w.path).toLowerCase() !== r.root.toLowerCase() && !w.bare);
    if (!list.length) return void vscode.window.showInformationMessage(`${r.name} has no other worktrees.`);
    const pick = await vscode.window.showQuickPick(list.map((w) => ({ label: w.branch ?? w.head?.slice(0, 8) ?? '?', description: w.path, w })), { placeHolder: 'Remove which worktree?' });
    if (!pick || !(await this.confirm(`Remove the worktree at ${pick.w.path}?`, 'The folder is deleted. The branch is kept.', 'Remove'))) return;
    if ((await this.exec(r, ['worktree', 'remove', pick.w.path], { title: 'Remove worktree', quiet: true })) !== undefined) return;
    if (await this.confirm('The worktree has local changes.', 'Remove it anyway and lose those changes?', 'Force Remove')) {
      await this.exec(r, ['worktree', 'remove', '--force', pick.w.path], { title: 'Remove worktree' });
    }
  }

  // --- terminals ----------------------------------------------------------------------------------

  openInTerminal(repos: Repo[]): void {
    for (const r of repos) vscode.window.createTerminal({ name: r.name, cwd: r.root }).show();
  }

  runInTerminal(r: Repo, command: string, label: string, env?: Record<string, string>): void {
    const term = vscode.window.createTerminal({ name: `${r.name}: ${label}`, cwd: r.root, env });
    term.show();
    term.sendText(command, true);
  }
}

function hasConflictMarkers(file: string): boolean {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
  } catch {
    return false;
  }
}

/** A `code --wait` command line usable as GIT_EDITOR, preferring the CLI of the running VS Code. */
function codeEditorCommand(): string {
  const appRoot = vscode.env.appRoot;
  const candidates =
    process.platform === 'win32'
      ? [path.join(appRoot, '..', '..', 'bin')]
      : process.platform === 'darwin'
        ? [path.join(appRoot, 'bin')]
        : [path.join(appRoot, '..', '..', 'bin'), path.join(appRoot, 'bin')];
  for (const dir of candidates) {
    try {
      const file = fs.readdirSync(dir).find((f) => /^code(-insiders)?(\.cmd)?$/.test(f) && (process.platform !== 'win32' || f.endsWith('.cmd')));
      if (file) return `"${path.join(dir, file).replace(/\\/g, '/')}" --wait`;
    } catch {
      // try next
    }
  }
  return 'code --wait';
}


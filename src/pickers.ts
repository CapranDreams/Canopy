import * as vscode from 'vscode';
import { BRANCH_FORMAT, BranchInfo, LOG_FORMAT, StashEntry, Worktree, parseBranches, parseLog, parseStashes, parseWorktrees } from './git/parse';
import { Repo } from './repo';
import { timeAgo } from './tree';
import { validateRefName } from './util/remote';

export async function listBranches(repo: Repo): Promise<BranchInfo[]> {
  const out = await repo.git(['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], { readOnly: true });
  return parseBranches(out);
}

export async function listTags(repo: Repo): Promise<string[]> {
  const out = await repo.git(['tag', '--sort=-creatordate'], { readOnly: true });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function listStashes(repo: Repo): Promise<StashEntry[]> {
  const out = await repo.git(['stash', 'list', '--format=%gd%x00%ct%x00%gs'], { readOnly: true });
  return parseStashes(out);
}

export async function listWorktrees(repo: Repo): Promise<Worktree[]> {
  return parseWorktrees(await repo.git(['worktree', 'list', '--porcelain'], { readOnly: true }));
}

interface BranchPickOptions {
  placeHolder: string;
  local?: boolean;
  remote?: boolean;
  tags?: boolean;
  excludeCurrent?: boolean;
  allowCreate?: boolean;
}

export type BranchPick = { kind: 'local' | 'remote' | 'tag'; name: string } | { kind: 'create' };

export async function pickBranch(repo: Repo, opts: BranchPickOptions): Promise<BranchPick | undefined> {
  type Item = vscode.QuickPickItem & { pick?: BranchPick };
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = opts.placeHolder;
  qp.matchOnDescription = true;
  qp.busy = true;
  qp.show();
  try {
    const [branches, tags] = await Promise.all([listBranches(repo), opts.tags ? listTags(repo) : Promise.resolve([])]);
    const items: Item[] = [];
    if (opts.allowCreate) items.push({ label: '$(plus) Create new branch…', alwaysShow: true, pick: { kind: 'create' } });
    const local = branches.filter((b) => !b.remote && !(opts.excludeCurrent && b.current));
    const remote = branches.filter((b) => b.remote);
    if (opts.local !== false && local.length) {
      items.push({ label: 'Branches', kind: vscode.QuickPickItemKind.Separator });
      for (const b of local) {
        items.push({ label: `$(git-branch) ${b.name}`, description: [b.current ? 'current' : '', b.upstream ? `→ ${b.upstream}` : ''].filter(Boolean).join(' · '), detail: `${b.hash} ${b.subject} · ${timeAgo(b.time * 1000)}`, pick: { kind: 'local', name: b.name } });
      }
    }
    if (opts.remote !== false && remote.length) {
      items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
      for (const b of remote) items.push({ label: `$(cloud) ${b.name}`, detail: `${b.hash} ${b.subject} · ${timeAgo(b.time * 1000)}`, pick: { kind: 'remote', name: b.name } });
    }
    if (tags.length) {
      items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator });
      for (const t of tags.slice(0, 200)) items.push({ label: `$(tag) ${t}`, pick: { kind: 'tag', name: t } });
    }
    qp.items = items;
    qp.busy = false;
    return await new Promise<BranchPick | undefined>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0]?.pick));
      qp.onDidHide(() => resolve(undefined));
    });
  } finally {
    qp.dispose();
  }
}

export async function pickRemote(repo: Repo, placeHolder: string): Promise<string | undefined> {
  const names = [...repo.remotes.keys()];
  if (!names.length) {
    void vscode.window.showWarningMessage(`${repo.name} has no remotes.`);
    return undefined;
  }
  if (names.length === 1) return names[0];
  const pick = await vscode.window.showQuickPick(
    names.map((n) => ({ label: n, description: repo.remotes.get(n) })),
    { placeHolder }
  );
  return pick?.label;
}

export async function pickRemoteBranch(repo: Repo, remote: string, placeHolder: string): Promise<string | undefined> {
  const branches = (await listBranches(repo)).filter((b) => b.remote && b.name.startsWith(remote + '/'));
  const pick = await vscode.window.showQuickPick(
    branches.map((b) => ({ label: b.name.slice(remote.length + 1), description: b.hash, detail: b.subject })),
    { placeHolder }
  );
  return pick?.label;
}

export interface CommitPick {
  hash: string;
  subject: string;
}

export async function pickCommit(repo: Repo, placeHolder: string, range: string[] = ['HEAD'], max = 200): Promise<CommitPick | undefined> {
  const out = await repo.git(['log', `-n${max}`, `--format=${LOG_FORMAT}`, ...range, '--'], { readOnly: true });
  const commits = parseLog(out, [...repo.remotes.keys()]);
  if (!commits.length) {
    void vscode.window.showInformationMessage('No commits to choose from.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    commits.map((c) => ({
      label: c.subject || '(no message)',
      description: `${c.hash.slice(0, 8)} · ${c.author} · ${timeAgo(c.time * 1000)}`,
      detail: c.refs.length ? c.refs.map((r) => r.name).join(', ') : undefined,
      hash: c.hash
    })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true }
  );
  return pick ? { hash: pick.hash, subject: pick.label } : undefined;
}

export async function pickStash(repo: Repo, placeHolder: string): Promise<StashEntry | undefined> {
  const stashes = await listStashes(repo);
  if (!stashes.length) {
    void vscode.window.showInformationMessage(`${repo.name} has no stashes.`);
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    stashes.map((s) => ({ label: s.message || s.ref, description: `${s.ref} · ${timeAgo(s.time * 1000)}`, stash: s })),
    { placeHolder }
  );
  return pick?.stash;
}

export async function askRefName(prompt: string, value = '', placeHolder?: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    prompt,
    value,
    placeHolder,
    validateInput: (v) => validateRefName(v.trim().replace(/\s+/g, '-'))
  });
  return name?.trim().replace(/\s+/g, '-') || undefined;
}

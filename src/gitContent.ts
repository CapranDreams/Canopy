import * as path from 'node:path';
import * as vscode from 'vscode';
import { FileEntry } from './git/parse';
import { Repo } from './repo';
import { RepoManager } from './manager';

export const SCHEME = 'canopy-git';

/**
 * Serves file contents at a git ref: `ref` is a commit-ish, '' for the index, ':1'/':2'/':3' for
 * merge stages, or '~empty' for an empty document.
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly manager: RepoManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref, rel } = parseUri(uri);
    if (ref === '~empty') return '';
    const repo = this.manager.findByRoot(root);
    const spec = ref === '' ? `:${rel}` : ref.startsWith(':') ? `${ref}:${rel}` : `${ref}:${rel}`;
    try {
      return await (repo ? repo.git(['show', spec], { readOnly: true }) : Promise.resolve(''));
    } catch {
      return '';
    }
  }
}

export function gitUri(repo: Repo, relPath: string, ref: string): vscode.Uri {
  const abs = path.join(repo.root, relPath);
  return vscode.Uri.file(abs).with({ scheme: SCHEME, query: JSON.stringify({ root: repo.root, ref, rel: relPath.replace(/\\/g, '/') }) });
}

function parseUri(uri: vscode.Uri): { root: string; ref: string; rel: string } {
  return JSON.parse(uri.query);
}

const beside = (preserveFocus = false): vscode.TextDocumentShowOptions => ({ viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus });

/** Opens the change for a file in the editor group beside the current one, like the built-in SCM view. */
export async function openChange(repo: Repo, file: FileEntry, staged: boolean): Promise<void> {
  const name = path.basename(file.path);
  const workUri = vscode.Uri.file(path.join(repo.root, file.path));
  if (file.status === 'C') return openMergeEditor(repo, file.path);
  if (!staged) {
    if (file.status === 'U' || file.status === 'A') return void vscode.commands.executeCommand('vscode.open', workUri, beside());
    if (file.status === 'D') return void vscode.commands.executeCommand('vscode.diff', gitUri(repo, file.path, ''), gitUri(repo, file.path, '~empty'), `${name} (Deleted)`, beside());
    return void vscode.commands.executeCommand('vscode.diff', gitUri(repo, file.path, ''), workUri, `${name} (Working Tree)`, beside());
  }
  if (file.status === 'A') return void vscode.commands.executeCommand('vscode.diff', gitUri(repo, file.path, '~empty'), gitUri(repo, file.path, ''), `${name} (Index, added)`, beside());
  if (file.status === 'D') return void vscode.commands.executeCommand('vscode.diff', gitUri(repo, file.path, 'HEAD'), gitUri(repo, file.path, '~empty'), `${name} (Index, deleted)`, beside());
  const left = gitUri(repo, file.origPath ?? file.path, 'HEAD');
  return void vscode.commands.executeCommand('vscode.diff', left, gitUri(repo, file.path, ''), `${name} (Index)`, beside());
}

export async function openFile(repo: Repo, relPath: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(repo.root, relPath)), beside());
}

/** Opens VS Code's 3-way merge editor for a conflicted file, falling back to the plain file. */
export async function openMergeEditor(repo: Repo, relPath: string): Promise<void> {
  const output = vscode.Uri.file(path.join(repo.root, relPath));
  try {
    await vscode.commands.executeCommand('_open.mergeEditor', {
      base: gitUri(repo, relPath, ':1'),
      input1: { uri: gitUri(repo, relPath, ':2'), title: 'Current', description: repo.branchLabel },
      input2: { uri: gitUri(repo, relPath, ':3'), title: 'Incoming', description: repo.operation ?? 'merge' },
      output
    });
  } catch {
    await vscode.commands.executeCommand('vscode.open', output, beside());
  }
}

/** Diffs a file at `ref` against the working tree. */
export async function openRefDiff(repo: Repo, relPath: string, ref: string, label: string): Promise<void> {
  const name = path.basename(relPath);
  await vscode.commands.executeCommand('vscode.diff', gitUri(repo, relPath, ref), vscode.Uri.file(path.join(repo.root, relPath)), `${name} (${label} ↔ Working Tree)`, beside());
}

/** Diffs a file between a commit and its first parent. */
export async function openCommitFileDiff(repo: Repo, relPath: string, sha: string, status: string): Promise<void> {
  const name = path.basename(relPath);
  const left = status === 'A' ? gitUri(repo, relPath, '~empty') : gitUri(repo, relPath, `${sha}^`);
  const right = status === 'D' ? gitUri(repo, relPath, '~empty') : gitUri(repo, relPath, sha);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${sha.slice(0, 8)})`, beside());
}

export function registerGitContent(manager: RepoManager): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider(manager));
}

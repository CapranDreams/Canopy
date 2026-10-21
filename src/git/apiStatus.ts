/**
 * Converts a repository state published by VS Code's built-in Git extension (its `vscode.git` API, version 1)
 * into CANOPY's StatusInfo, so repositories that extension already tracks need no `git status` of their own.
 * Structural types only, no vscode import; unit tested.
 */
import * as path from 'node:path';
import { FileEntry, StatusInfo } from './parse';

/** The API's Status enum (extensions/git/src/api/git.d.ts); stable since the API's first version. */
export const ApiStatus = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18
} as const;

interface ApiUri {
  readonly fsPath: string;
}
export interface ApiChange {
  readonly uri: ApiUri;
  readonly originalUri: ApiUri;
  readonly renameUri?: ApiUri;
  readonly status: number;
}
export interface ApiBranch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { readonly remote: string; readonly name: string };
  readonly ahead?: number;
  readonly behind?: number;
}
export interface ApiRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}
export interface ApiRepoState {
  readonly HEAD: ApiBranch | undefined;
  readonly remotes: readonly ApiRemote[];
  readonly mergeChanges: readonly ApiChange[];
  readonly indexChanges: readonly ApiChange[];
  readonly workingTreeChanges: readonly ApiChange[];
  /** Present in newer VS Code versions; filled when git.untrackedChanges is "separate". */
  readonly untrackedChanges?: readonly ApiChange[];
}

const INDEX: Record<number, string> = {
  [ApiStatus.INDEX_MODIFIED]: 'M',
  [ApiStatus.INDEX_ADDED]: 'A',
  [ApiStatus.INDEX_DELETED]: 'D',
  [ApiStatus.INDEX_RENAMED]: 'R',
  [ApiStatus.INDEX_COPIED]: 'C',
  [ApiStatus.TYPE_CHANGED]: 'T'
};
const WORKING: Record<number, string> = {
  [ApiStatus.MODIFIED]: 'M',
  [ApiStatus.DELETED]: 'D',
  [ApiStatus.UNTRACKED]: 'U',
  [ApiStatus.INTENT_TO_ADD]: 'A',
  [ApiStatus.INTENT_TO_RENAME]: 'R',
  [ApiStatus.TYPE_CHANGED]: 'T'
};

/**
 * The state as StatusInfo, or undefined when it cannot stand in for `git status`: not read yet (no HEAD), or
 * the change list may be cut off (the extension stops listing at git.statusLimit).
 */
export function statusFromApi(root: string, s: ApiRepoState, statusLimit = 10_000): StatusInfo | undefined {
  const head = s.HEAD;
  if (!head) return undefined;
  const untracked = s.untrackedChanges ?? [];
  if (statusLimit > 0 && s.workingTreeChanges.length + untracked.length >= statusLimit) return undefined;
  const rel = (u: ApiUri) => path.relative(root, u.fsPath).split(path.sep).join('/');
  const info: StatusInfo = {
    oid: head.commit ?? null,
    branch: head.name ?? null,
    detached: !head.name && !!head.commit,
    upstream: head.upstream ? `${head.upstream.remote}/${head.upstream.name}` : null,
    ahead: head.upstream ? (head.ahead ?? 0) : 0,
    behind: head.upstream ? (head.behind ?? 0) : 0,
    staged: [],
    unstaged: [],
    conflicts: [],
    submodules: {}
  };
  for (const c of s.indexChanges) {
    const status = INDEX[c.status];
    if (!status) continue;
    const renamed = c.status === ApiStatus.INDEX_RENAMED || c.status === ApiStatus.INDEX_COPIED;
    const entry: FileEntry = { path: rel(renamed && c.renameUri ? c.renameUri : c.uri), status };
    if (renamed) entry.origPath = rel(c.originalUri);
    info.staged.push(entry);
  }
  for (const c of [...s.workingTreeChanges, ...untracked]) {
    const status = WORKING[c.status];
    if (status) info.unstaged.push({ path: rel(c.status === ApiStatus.INTENT_TO_RENAME && c.renameUri ? c.renameUri : c.uri), status });
  }
  for (const c of s.mergeChanges) info.conflicts.push({ path: rel(c.uri), status: 'C' });
  return info;
}

/** Remote name → fetch URL, as `git remote -v` gives it. */
export function remotesFromApi(s: ApiRepoState): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of s.remotes) {
    const url = r.fetchUrl ?? r.pushUrl;
    if (url) map.set(r.name, url);
  }
  return map;
}

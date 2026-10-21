/** Shared, vscode-free types for repository state. */

export type OperationKind = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect';

export interface RepoFacts {
  key: string;
  name: string;
  root: string;
  branch: string | null;
  detached: boolean;
  headShort: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
  staged: number;
  conflicts: number;
  operation: OperationKind | null;
  lastCommitTime: number;
  remoteUrls: string[];
  folderNames: string[];
  error: string | null;
  loaded: boolean;
  /** Latest GitLab pipeline status for the current branch, when connected. */
  ci: string | null;
  /** Open merge request for the current branch, when connected. */
  mr: 'open' | 'draft' | null;
  mrConflicts: boolean;
  /** Submodule checked out at a different commit than its parent repository records. */
  submoduleMoved?: boolean;
}

export type Attention = 'conflict' | 'error' | 'diverged' | 'behind' | 'changes' | 'ahead' | 'unpublished' | 'clean';

export const ATTENTION_ORDER: readonly Attention[] = ['conflict', 'error', 'diverged', 'behind', 'changes', 'ahead', 'unpublished', 'clean'];

export const ATTENTION_LABEL: Record<Attention, string> = {
  conflict: 'Conflicts & operations in progress',
  error: 'Errors',
  diverged: 'Diverged',
  behind: 'Incoming',
  changes: 'Local changes',
  ahead: 'Unpushed',
  unpublished: 'Not published',
  clean: 'Clean'
};

export function attentionOf(r: RepoFacts): Attention {
  if (r.conflicts > 0 || r.operation) return 'conflict';
  if (r.error) return 'error';
  if (r.behind > 0 && r.ahead > 0) return 'diverged';
  if (r.behind > 0) return 'behind';
  if (r.changed > 0) return 'changes';
  if (r.ahead > 0) return 'ahead';
  if (!r.detached && r.branch && !r.upstream && r.remoteUrls.length > 0) return 'unpublished';
  return 'clean';
}

export function needsAttention(r: RepoFacts): boolean {
  const a = attentionOf(r);
  return a !== 'clean' && a !== 'unpublished' && a !== 'ahead';
}

export type SortMode = 'attention' | 'name' | 'recent' | 'changes' | 'manual';

export const SORT_MODES: ReadonlyArray<{ mode: SortMode; label: string; description: string }> = [
  { mode: 'attention', label: 'Attention', description: 'conflicts, then incoming, changes, unpushed, clean' },
  { mode: 'recent', label: 'Recent activity', description: 'latest commit first' },
  { mode: 'changes', label: 'Most changes', description: 'most changed files first' },
  { mode: 'name', label: 'Alphabetical', description: 'A to Z' },
  { mode: 'manual', label: 'Manual', description: 'the order you drag them into' }
];

export function compareRepos(mode: SortMode, manualOrder?: readonly string[]): (a: RepoFacts, b: RepoFacts) => number {
  const byName = (a: RepoFacts, b: RepoFacts) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  switch (mode) {
    case 'name':
      return byName;
    case 'recent':
      return (a, b) => b.lastCommitTime - a.lastCommitTime || byName(a, b);
    case 'changes':
      return (a, b) => b.changed - a.changed || b.conflicts - a.conflicts || b.ahead + b.behind - (a.ahead + a.behind) || byName(a, b);
    case 'manual': {
      const pos = new Map((manualOrder ?? []).map((k, i) => [k, i]));
      return (a, b) => (pos.get(a.key) ?? 1e9) - (pos.get(b.key) ?? 1e9) || byName(a, b);
    }
    default:
      return (a, b) => {
        const d = ATTENTION_ORDER.indexOf(attentionOf(a)) - ATTENTION_ORDER.indexOf(attentionOf(b));
        if (d) return d;
        const w = (r: RepoFacts) => r.conflicts * 100 + r.behind + r.changed + r.ahead;
        return w(b) - w(a) || byName(a, b);
      };
  }
}

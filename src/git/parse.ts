/** Parsers for git plumbing output. Pure functions: no vscode imports, unit tested. */

export interface FileEntry {
  path: string;
  origPath?: string;
  /** One-letter status as shown in the UI: M A D R C(onflict) U(ntracked) T. */
  status: string;
}

export interface StatusInfo {
  oid: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileEntry[];
  unstaged: FileEntry[];
  conflicts: FileEntry[];
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string): StatusInfo {
  const info: StatusInfo = { oid: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [] };
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const type = rec[0];
    if (type === '#') {
      const [, key, ...rest] = rec.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') info.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        info.detached = value === '(detached)';
        info.branch = info.detached ? null : value;
      } else if (key === 'branch.upstream') info.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          info.ahead = Number(m[1]);
          info.behind = Number(m[2]);
        }
      }
    } else if (type === '1' || type === '2') {
      const fields = splitFields(rec, type === '1' ? 8 : 9);
      const xy = fields[1];
      const path = fields[fields.length - 1];
      let origPath: string | undefined;
      if (type === '2') origPath = records[++i];
      addXY(info, xy, path, origPath);
    } else if (type === 'u') {
      const fields = splitFields(rec, 10);
      info.conflicts.push({ path: fields[fields.length - 1], status: 'C' });
    } else if (type === '?') {
      info.unstaged.push({ path: rec.slice(2), status: 'U' });
    }
  }
  return info;
}

/** Splits `rec` into `fixed` space-separated fields followed by the rest (a path that may contain spaces). */
function splitFields(rec: string, fixed: number): string[] {
  const fields: string[] = [];
  let pos = 0;
  for (let n = 0; n < fixed; n++) {
    const next = rec.indexOf(' ', pos);
    if (next < 0) break;
    fields.push(rec.slice(pos, next));
    pos = next + 1;
  }
  fields.push(rec.slice(pos));
  return fields;
}

function addXY(info: StatusInfo, xy: string, path: string, origPath?: string): void {
  const [x, y] = xy;
  if (x !== '.') info.staged.push({ path, origPath, status: x === '?' ? 'A' : x });
  if (y !== '.') info.unstaged.push({ path, origPath: undefined, status: y });
}

export function changedPathCount(s: StatusInfo): number {
  const paths = new Set<string>();
  for (const f of s.staged) paths.add(f.path);
  for (const f of s.unstaged) paths.add(f.path);
  for (const f of s.conflicts) paths.add(f.path);
  return paths.size;
}

export type RefType = 'head' | 'local' | 'remote' | 'tag';
export interface Ref {
  name: string;
  type: RefType;
}

export interface Commit {
  hash: string;
  parents: string[];
  refs: Ref[];
  author: string;
  time: number;
  subject: string;
}

export const LOG_FORMAT = '%H%x00%P%x00%D%x00%an%x00%at%x00%s%x1e';

/** Parses `git log --format=LOG_FORMAT`. `remotes` are remote names, used to tell remote refs from local ones. */
export function parseLog(out: string, remotes: readonly string[]): Commit[] {
  const commits: Commit[] = [];
  for (const raw of out.split('\x1e')) {
    const rec = raw.replace(/^\r?\n/, '');
    if (!rec) continue;
    const [hash, parents, decor, author, time, ...subject] = rec.split('\0');
    if (!hash) continue;
    commits.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: parseDecorations(decor ?? '', remotes),
      author: author ?? '',
      time: Number(time) || 0,
      subject: subject.join('\0')
    });
  }
  return commits;
}

export function parseDecorations(decor: string, remotes: readonly string[]): Ref[] {
  const refs: Ref[] = [];
  for (const part of decor.split(', ').map((p) => p.trim()).filter(Boolean)) {
    if (part.startsWith('HEAD -> ')) {
      refs.push({ name: part.slice(8), type: 'head' });
    } else if (part === 'HEAD') {
      refs.push({ name: 'HEAD', type: 'head' });
    } else if (part.startsWith('tag: ')) {
      refs.push({ name: part.slice(5), type: 'tag' });
    } else if (remotes.some((r) => part.startsWith(r + '/'))) {
      if (!part.endsWith('/HEAD')) refs.push({ name: part, type: 'remote' });
    } else {
      refs.push({ name: part, type: 'local' });
    }
  }
  return refs;
}

export interface BranchInfo {
  name: string;
  remote: boolean;
  upstream?: string;
  current: boolean;
  hash: string;
  subject: string;
  time: number;
}

export const BRANCH_FORMAT = '%(refname)%00%(upstream:short)%00%(HEAD)%00%(objectname:short)%00%(committerdate:unix)%00%(contents:subject)';

/** Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`. */
export function parseBranches(out: string): BranchInfo[] {
  const result: BranchInfo[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, upstream, head, hash, time, ...subject] = line.split('\0');
    if (ref.startsWith('refs/heads/')) {
      result.push({ name: ref.slice(11), remote: false, upstream: upstream || undefined, current: head === '*', hash, time: Number(time) || 0, subject: subject.join('\0') });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13);
      if (name.endsWith('/HEAD')) continue;
      result.push({ name, remote: true, current: false, hash, time: Number(time) || 0, subject: subject.join('\0') });
    }
  }
  return result;
}

export interface StashEntry {
  ref: string;
  index: number;
  message: string;
  time: number;
}

/** Parses `git stash list --format=%gd%x00%ct%x00%gs`. */
export function parseStashes(out: string): StashEntry[] {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const [ref, time, ...msg] = line.split('\0');
      const m = /\{(\d+)\}/.exec(ref);
      return { ref, index: m ? Number(m[1]) : 0, time: Number(time) || 0, message: msg.join('\0') };
    });
}

export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), bare: false, detached: false };
      list.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line === 'bare') cur.bare = true;
    else if (cur && line === 'detached') cur.detached = true;
  }
  return list;
}

/** Parses `git remote -v` into name → fetch URL. */
export function parseRemotes(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line.trim());
    if (m && (m[3] === 'fetch' || !map.has(m[1]))) map.set(m[1], m[2]);
  }
  return map;
}

/** Parses `git diff-tree -r -z --name-status` (renames and copies carry the old path first). */
export function parseNameStatusZ(out: string): FileEntry[] {
  const parts = out.split('\0');
  const files: FileEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (!st) continue;
    const letter = st[0];
    if (letter === 'R' || letter === 'C') {
      const origPath = parts[++i];
      const path = parts[++i];
      if (path !== undefined) files.push({ status: letter === 'C' ? 'A' : 'R', path, origPath });
    } else {
      const path = parts[++i];
      if (path !== undefined) files.push({ status: letter, path });
    }
  }
  return files;
}

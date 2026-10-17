/** Clone/switch profiles: the portable file format, validation and plan computation. Pure. */
import { normalizeRemote, validateCloneUrl, validateRefName, validateRelativePath } from '../util/remote';
import { OperationKind } from './types';

export type ProfileMode = 'track' | 'pin';

export interface ProfileRepo {
  name: string;
  remote: string;
  branch: string;
  /** Folder to clone into, relative to the base folder. */
  path: string;
  commit?: string;
  /** Virtual folder name (slash-separated for nesting) to file the repo under. */
  folder?: string;
}

export interface ApplyOptions {
  cloneMissing: boolean;
  stashChanges: boolean;
  pullAfter: boolean;
  recreateLayout: boolean;
}

export interface Profile {
  id: string;
  name: string;
  description?: string;
  mode: ProfileMode;
  repos: ProfileRepo[];
  onApply: ApplyOptions;
  createdBy?: string;
  savedAt?: string;
}

export const DEFAULT_APPLY: ApplyOptions = { cloneMissing: true, stashChanges: true, pullAfter: true, recreateLayout: false };

export const PROFILE_FILE_VERSION = 1;

export interface ProfileFile {
  canopyProfile: number;
  name: string;
  description?: string;
  mode: ProfileMode;
  createdBy?: string;
  onApply?: Partial<ApplyOptions>;
  repos: ProfileRepo[];
}

export function toProfileFile(p: Profile): ProfileFile {
  return {
    canopyProfile: PROFILE_FILE_VERSION,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    mode: p.mode,
    ...(p.createdBy ? { createdBy: p.createdBy } : {}),
    onApply: p.onApply,
    repos: p.repos.map((r) => ({ ...r }))
  };
}

export class ProfileValidationError extends Error {}

/** Parses and validates an untrusted profile (file, link or settings). Throws ProfileValidationError. */
export function parseProfile(raw: unknown, id?: string): Profile {
  if (!raw || typeof raw !== 'object') throw new ProfileValidationError('Profile is not a JSON object.');
  const o = raw as Record<string, unknown>;
  const version = o.canopyProfile ?? PROFILE_FILE_VERSION;
  if (typeof version !== 'number' || version > PROFILE_FILE_VERSION) throw new ProfileValidationError('This profile was made by a newer version of CANOPY.');
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : 'Imported profile';
  const mode: ProfileMode = o.mode === 'pin' || o.mode === 'pinned-commits' ? 'pin' : 'track';
  if (!Array.isArray(o.repos)) throw new ProfileValidationError('Profile has no "repos" list.');
  if (o.repos.length > 500) throw new ProfileValidationError('Profile lists too many repositories.');
  const usedPaths = new Set<string>();
  const repos = o.repos.map((r, i): ProfileRepo => {
    if (!r || typeof r !== 'object') throw new ProfileValidationError(`Repository #${i + 1} is not an object.`);
    const e = r as Record<string, unknown>;
    const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string).trim() : '');
    const remote = str('remote');
    const branch = str('branch');
    const path = str('path').replace(/\\/g, '/');
    const label = str('name') || `#${i + 1}`;
    const err = validateCloneUrl(remote) ?? validateRefName(branch) ?? validateRelativePath(path);
    if (err) throw new ProfileValidationError(`${label}: ${err}`);
    const key = path.toLowerCase();
    if (usedPaths.has(key)) throw new ProfileValidationError(`${label}: path "${path}" is used twice.`);
    usedPaths.add(key);
    const out: ProfileRepo = { name: str('name') || path.split('/').pop()!, remote, branch, path };
    const commit = str('commit');
    if (commit) {
      if (!/^[0-9a-f]{4,64}$/i.test(commit)) throw new ProfileValidationError(`${label}: commit "${commit}" is not a hash.`);
      out.commit = commit;
    }
    const folder = str('folder');
    if (folder) out.folder = folder.slice(0, 200);
    return out;
  });
  const a = (o.onApply && typeof o.onApply === 'object' ? o.onApply : {}) as Record<string, unknown>;
  const bool = (k: keyof ApplyOptions) => (typeof a[k] === 'boolean' ? (a[k] as boolean) : DEFAULT_APPLY[k]);
  return {
    id: id ?? (typeof o.id === 'string' && o.id ? o.id : 'p' + Date.now().toString(36)),
    name,
    description: typeof o.description === 'string' ? o.description.slice(0, 500) : undefined,
    mode,
    repos,
    onApply: { cloneMissing: bool('cloneMissing'), stashChanges: bool('stashChanges'), pullAfter: bool('pullAfter'), recreateLayout: bool('recreateLayout') },
    createdBy: typeof o.createdBy === 'string' ? o.createdBy.slice(0, 120) : undefined,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : undefined
  };
}

/** What CANOPY knows about a local repo when planning. */
export interface LocalRepoState {
  key: string;
  root: string;
  remoteUrls: string[];
  branch: string | null;
  headHash: string | null;
  changed: number;
  behind: number;
  conflicts: number;
  operation: OperationKind | null;
}

export type StepKind = 'clone' | 'switch' | 'stash-switch' | 'pull' | 'pin' | 'ok' | 'blocked' | 'skip';

export interface PlanStep {
  kind: StepKind;
  entry: ProfileRepo;
  local?: LocalRepoState;
  detail: string;
}

/** Finds the local repo for a profile entry: same remote first, then same path under the base folder. */
export function matchLocal(entry: ProfileRepo, locals: readonly LocalRepoState[], baseFolder: string): LocalRepoState | undefined {
  const want = normalizeRemote(entry.remote);
  const byRemote = locals.filter((l) => l.remoteUrls.some((u) => normalizeRemote(u) === want));
  if (byRemote.length === 1) return byRemote[0];
  const wantPath = joinPath(baseFolder, entry.path).toLowerCase();
  const byPath = locals.find((l) => l.root.replace(/\\/g, '/').toLowerCase() === wantPath);
  return byPath ?? byRemote[0];
}

export function joinPath(base: string, rel: string): string {
  return (base.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + rel.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/\/+/g, '/');
}

export function planProfile(profile: Profile, locals: readonly LocalRepoState[], baseFolder: string, opts: ApplyOptions = profile.onApply): PlanStep[] {
  return profile.repos.map((entry): PlanStep => {
    const local = matchLocal(entry, locals, baseFolder);
    if (!local) {
      return opts.cloneMissing
        ? { kind: 'clone', entry, detail: `clone ${entry.branch} into ${joinPath(baseFolder, entry.path)}` }
        : { kind: 'skip', entry, detail: 'not cloned here (cloning is turned off)' };
    }
    if (local.operation || local.conflicts) {
      return { kind: 'blocked', entry, local, detail: `${local.operation ?? 'merge'} in progress: finish or abort it first` };
    }
    if (profile.mode === 'pin' && entry.commit) {
      if (local.headHash && local.headHash.startsWith(entry.commit)) return { kind: 'ok', entry, local, detail: `already at ${entry.commit.slice(0, 8)}` };
      if (local.changed && !opts.stashChanges) return { kind: 'blocked', entry, local, detail: `${local.changed} local changes (stashing is off)` };
      return { kind: 'pin', entry, local, detail: `${local.changed ? `stash ${local.changed} changes, ` : ''}check out ${entry.commit.slice(0, 8)} (detached)` };
    }
    if (local.branch === entry.branch) {
      if (local.behind && opts.pullAfter) return { kind: 'pull', entry, local, detail: `on ${entry.branch}, pull ${local.behind} commit${local.behind === 1 ? '' : 's'}` };
      return { kind: 'ok', entry, local, detail: `already on ${entry.branch}` };
    }
    if (local.changed) {
      return opts.stashChanges
        ? { kind: 'stash-switch', entry, local, detail: `stash ${local.changed} changes, switch ${local.branch ?? 'HEAD'} → ${entry.branch}` }
        : { kind: 'blocked', entry, local, detail: `${local.changed} local changes (stashing is off)` };
    }
    return { kind: 'switch', entry, local, detail: `switch ${local.branch ?? 'HEAD'} → ${entry.branch}${opts.pullAfter ? ', then pull' : ''}` };
  });
}

export function summarizePlan(steps: readonly PlanStep[]): string {
  const count = (k: StepKind[]) => steps.filter((s) => k.includes(s.kind)).length;
  const parts: string[] = [];
  const clone = count(['clone']);
  const sw = count(['switch', 'stash-switch', 'pin']);
  const pull = count(['pull']);
  const blocked = count(['blocked']);
  if (clone) parts.push(`${clone} to clone`);
  if (sw) parts.push(`${sw} to switch`);
  if (pull) parts.push(`${pull} to pull`);
  if (blocked) parts.push(`${blocked} blocked`);
  return `${steps.length} repos · ${parts.join(' · ') || 'nothing to do'}`;
}

/** URL-safe base64 for share links (no padding). */
export function encodeShareData(file: ProfileFile): string {
  return Buffer.from(JSON.stringify(file), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShareData(data: string): unknown {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

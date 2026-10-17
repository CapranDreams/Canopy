/**
 * The virtual folder layout. Repos are referenced by key (a path relative to the workspace,
 * or absolute when outside it). All functions return a new layout; inputs are not mutated.
 */

export interface LayoutFolder {
  id: string;
  name: string;
  /** Repo keys, in manual order. Empty for smart folders. */
  repos: string[];
  children: LayoutFolder[];
  /** Smart folders list every repo matching this query instead of `repos`. */
  query?: string;
}

export interface Layout {
  version: 1;
  folders: LayoutFolder[];
  hidden: string[];
  /** Manual order of repos that are in no folder. */
  unsorted: string[];
}

export const EMPTY_LAYOUT: Layout = { version: 1, folders: [], hidden: [], unsorted: [] };

export function newFolderId(): string {
  return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Validates and fills in a layout read from settings (which a user may have hand-edited). */
export function normalizeLayout(raw: unknown): Layout {
  if (!raw || typeof raw !== 'object') return clone(EMPTY_LAYOUT);
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const folder = (f: unknown): LayoutFolder | undefined => {
    if (!f || typeof f !== 'object') return undefined;
    const o = f as Record<string, unknown>;
    let id = typeof o.id === 'string' && o.id ? o.id : newFolderId();
    while (seen.has(id)) id = newFolderId();
    seen.add(id);
    const out: LayoutFolder = {
      id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name : 'Folder',
      repos: strings(o.repos),
      children: Array.isArray(o.children) ? (o.children.map(folder).filter(Boolean) as LayoutFolder[]) : []
    };
    if (typeof o.query === 'string' && o.query.trim()) {
      out.query = o.query;
      out.repos = [];
    }
    return out;
  };
  return {
    version: 1,
    folders: Array.isArray(r.folders) ? (r.folders.map(folder).filter(Boolean) as LayoutFolder[]) : [],
    hidden: strings(r.hidden),
    unsorted: strings(r.unsorted)
  };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function* walkFolders(folders: LayoutFolder[], parent: LayoutFolder | null = null): Generator<{ folder: LayoutFolder; parent: LayoutFolder | null }> {
  for (const f of folders) {
    yield { folder: f, parent };
    yield* walkFolders(f.children, f);
  }
}

export function findFolder(layout: Layout, id: string): LayoutFolder | undefined {
  for (const { folder } of walkFolders(layout.folders)) if (folder.id === id) return folder;
  return undefined;
}

/** The manual folder that holds `key`, if any. */
export function folderOfRepo(layout: Layout, key: string): LayoutFolder | undefined {
  for (const { folder } of walkFolders(layout.folders)) if (!folder.query && folder.repos.includes(key)) return folder;
  return undefined;
}

/** Folder names from the root down to `id` (used for folder: queries and breadcrumbs). */
export function folderPath(layout: Layout, id: string): string[] {
  const path: string[] = [];
  const visit = (folders: LayoutFolder[]): boolean => {
    for (const f of folders) {
      path.push(f.name);
      if (f.id === id || visit(f.children)) return true;
      path.pop();
    }
    return false;
  };
  return visit(layout.folders) ? path : [];
}

function stripRepos(layout: Layout, keys: Set<string>): void {
  for (const { folder } of walkFolders(layout.folders)) folder.repos = folder.repos.filter((k) => !keys.has(k));
  layout.unsorted = layout.unsorted.filter((k) => !keys.has(k));
}

/**
 * Moves repos into a manual folder (or out of all folders when `folderId` is null),
 * inserting before `beforeKey` when given.
 */
export function moveRepos(layout: Layout, keys: readonly string[], folderId: string | null, beforeKey?: string): Layout {
  const next = clone(layout);
  const moving = new Set(keys);
  stripRepos(next, moving);
  const list = folderId ? findFolder(next, folderId) : undefined;
  if (folderId && (!list || list.query)) return layout;
  const target = list ? list.repos : next.unsorted;
  const at = beforeKey && !moving.has(beforeKey) ? target.indexOf(beforeKey) : -1;
  target.splice(at < 0 ? target.length : at, 0, ...keys);
  return next;
}

export function addFolder(layout: Layout, name: string, parentId?: string | null, query?: string): { layout: Layout; id: string } {
  const next = clone(layout);
  const id = newFolderId();
  const folder: LayoutFolder = { id, name, repos: [], children: [] };
  if (query) folder.query = query;
  const parent = parentId ? findFolder(next, parentId) : undefined;
  (parent ? parent.children : next.folders).push(folder);
  return { layout: next, id };
}

export function updateFolder(layout: Layout, id: string, patch: { name?: string; query?: string }): Layout {
  const next = clone(layout);
  const f = findFolder(next, id);
  if (!f) return layout;
  if (patch.name !== undefined) f.name = patch.name;
  if (patch.query !== undefined && f.query !== undefined) f.query = patch.query;
  return next;
}

/** Deletes a folder. Its repos and subfolders move up to the parent (or the top level / Unsorted). */
export function deleteFolder(layout: Layout, id: string): Layout {
  const next = clone(layout);
  const remove = (folders: LayoutFolder[], parent: LayoutFolder | null): boolean => {
    const i = folders.findIndex((f) => f.id === id);
    if (i >= 0) {
      const [gone] = folders.splice(i, 1, ...folders[i].children);
      if (!gone.query) {
        if (parent) parent.repos.push(...gone.repos.filter((k) => !parent.repos.includes(k)));
        else next.unsorted.push(...gone.repos.filter((k) => !next.unsorted.includes(k)));
      }
      return true;
    }
    return folders.some((f) => remove(f.children, f));
  };
  remove(next.folders, null);
  return next;
}

/** Moves a folder under `parentId` (null = top level), before sibling `beforeId` when given. Refuses cycles. */
export function moveFolder(layout: Layout, id: string, parentId: string | null, beforeId?: string): Layout {
  if (id === parentId) return layout;
  const moving = findFolder(layout, id);
  if (!moving) return layout;
  if (parentId) {
    for (const { folder } of walkFolders(moving.children)) if (folder.id === parentId) return layout;
    const p = findFolder(layout, parentId);
    if (!p || p.query) return layout;
  }
  const next = clone(layout);
  let taken: LayoutFolder | undefined;
  const take = (folders: LayoutFolder[]): boolean => {
    const i = folders.findIndex((f) => f.id === id);
    if (i >= 0) {
      [taken] = folders.splice(i, 1);
      return true;
    }
    return folders.some((f) => take(f.children));
  };
  take(next.folders);
  if (!taken) return layout;
  const siblings = parentId ? findFolder(next, parentId)!.children : next.folders;
  const at = beforeId ? siblings.findIndex((f) => f.id === beforeId) : -1;
  siblings.splice(at < 0 ? siblings.length : at, 0, taken);
  return next;
}

export function setHidden(layout: Layout, keys: readonly string[], hidden: boolean): Layout {
  const next = clone(layout);
  const set = new Set(next.hidden);
  for (const k of keys) {
    if (hidden) set.add(k);
    else set.delete(k);
  }
  next.hidden = [...set];
  return next;
}

/** Rewrites repo keys (e.g. after the workspace base folder changes). */
export function renameKeys(layout: Layout, map: Map<string, string>): Layout {
  const next = clone(layout);
  const m = (k: string) => map.get(k) ?? k;
  for (const { folder } of walkFolders(next.folders)) folder.repos = folder.repos.map(m);
  next.hidden = next.hidden.map(m);
  next.unsorted = next.unsorted.map(m);
  return next;
}

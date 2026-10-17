/** Remote URL helpers and validation for untrusted profile input. Pure, unit tested. */

function isLocalPath(u: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('/') || u.startsWith('\\\\') || u.startsWith('file://');
}

/** Splits a network remote into host and path (original casing, no credentials, port or `.git`). */
export function remoteHostPath(url: string): { host: string; path: string } | undefined {
  return parseRemote(url);
}

function parseRemote(url: string): { host: string; path: string } | undefined {
  const u = url.trim();
  if (!u || isLocalPath(u)) return undefined;
  const proto = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u);
  const m = proto ?? scp;
  if (!m) return undefined;
  let host = m[1].toLowerCase();
  let path = m[2].replace(/\/+$/, '').replace(/\.git$/, '');
  // Azure DevOps SSH (ssh.dev.azure.com:v3/org/project/repo) ↔ HTTPS (dev.azure.com/org/project/_git/repo)
  if (host === 'ssh.dev.azure.com') {
    const a = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (a) {
      host = 'dev.azure.com';
      path = `${a[1]}/${a[2]}/_git/${a[3]}`;
    }
  } else if (host.endsWith('.visualstudio.com')) {
    const a = /^(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)$/i.exec(path);
    if (a) {
      path = `${host.split('.')[0]}/${a[1]}/_git/${a[2]}`;
      host = 'dev.azure.com';
    }
  }
  return { host, path };
}

/** Reduces a remote URL to `host/path` (lower case, no credentials, port or `.git`) so different spellings compare equal. */
export function normalizeRemote(url: string): string {
  const u = url.trim();
  if (!u) return '';
  if (isLocalPath(u)) {
    return u.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
  }
  const p = parseRemote(u);
  return p ? `${p.host}/${p.path}`.toLowerCase() : u.toLowerCase();
}

/** Best-effort browser URL for a remote, optionally pointing at a branch. */
export function webUrlForRemote(url: string, branch?: string): string | undefined {
  const p = parseRemote(url);
  if (!p) return undefined;
  const base = `https://${p.host}/${p.path}`;
  if (!branch) return base;
  const b = encodeURIComponent(branch).replace(/%2F/g, '/');
  if (p.host === 'github.com') return `${base}/tree/${b}`;
  if (p.host === 'gitlab.com') return `${base}/-/tree/${b}`;
  if (p.host === 'bitbucket.org') return `${base}/src/${b}`;
  if (p.host === 'dev.azure.com') return `${base}?version=GB${encodeURIComponent(branch)}`;
  return base;
}

/** Returns an error message when `url` is not safe to pass to `git clone`. */
export function validateCloneUrl(url: string): string | undefined {
  const u = url.trim();
  if (!u) return 'Remote URL is empty.';
  if (/[\0-\x1f\x7f]/.test(u)) return 'Remote URL contains control characters.';
  if (u.startsWith('-')) return 'Remote URL cannot start with "-".';
  // Transport helpers such as ext:: can run arbitrary commands.
  if (u.includes('::')) return 'Remote helper URLs ("transport::address") are not allowed.';
  if (/^(https?|ssh|git|file):\/\//i.test(u)) return undefined;
  if (/^[^@\s/]+@[^:\s/]+:[^\s]+$/.test(u)) return undefined; // scp-like user@host:path
  if (/^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('/') || u.startsWith('\\\\')) return undefined; // local path
  return `Unsupported remote URL: ${u}`;
}

/** Returns an error message when `p` is not a safe relative folder path inside a base folder. */
export function validateRelativePath(p: string): string | undefined {
  const s = p.trim();
  if (!s) return 'Path is empty.';
  if (/[\0-\x1f\x7f<>"|?*]/.test(s)) return 'Path contains characters that are not allowed.';
  if (s.startsWith('/') || s.startsWith('\\') || /^[a-zA-Z]:/.test(s) || s.includes(':')) return 'Path must be relative.';
  if (s.split(/[\\/]+/).some((seg) => seg === '..')) return 'Path cannot contain "..".';
  return undefined;
}

/** Returns an error message when `name` is not an acceptable branch, tag or commit name. */
export function validateRefName(name: string): string | undefined {
  const s = name.trim();
  if (!s) return 'Name is empty.';
  if (s.startsWith('-')) return 'Name cannot start with "-".';
  if (/[\0-\x20\x7f~^:?*[\\]/.test(s)) return 'Name contains characters git does not allow.';
  if (s.includes('..') || s.includes('@{') || s.includes('//')) return 'Name contains a sequence git does not allow.';
  if (s.startsWith('/') || s.endsWith('/') || s.endsWith('.') || s.endsWith('.lock')) return 'Name has an invalid start or end.';
  return undefined;
}

export function repoNameFromUrl(url: string): string {
  const norm = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/, '');
  const last = norm.split(/[\\/:]/).pop() ?? '';
  return last || 'repo';
}

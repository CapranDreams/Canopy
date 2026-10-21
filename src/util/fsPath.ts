import * as path from 'node:path';

/** Absolute path with forward slashes and no trailing slash; lower case where the file system ignores case. */
export function normalizeFsPath(p: string): string {
  const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

import { normalizeFsPath } from './fsPath';

/**
 * How many of `roots` VS Code's Git opens by itself: with git.autoRepositoryDetection on, it opens each
 * workspace folder and the folders up to git.repositoryScanMaxDepth levels below it (-1 = no limit). Pure.
 */
export function countAutoDetected(roots: readonly string[], workspaceFolders: readonly string[], maxDepth: number): number {
  const bases = workspaceFolders.map(normalizeFsPath);
  return roots.filter((root) => {
    const norm = normalizeFsPath(root);
    return bases.some((base) => {
      if (norm === base) return true;
      if (!norm.startsWith(base + '/')) return false;
      const levels = norm.slice(base.length + 1).split('/').length;
      return maxDepth < 0 || levels <= maxDepth;
    });
  }).length;
}

/**
 * End-to-end test launcher: builds a scratch workspace with real git repositories, then starts a
 * downloaded VS Code with CANOPY loaded and runs ./suite inside it.  Run: npm run test:e2e
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runTests } from '@vscode/test-electron';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}

function makeFixture(): { workspaceFile: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-e2e-'));
  const remotes = path.join(root, 'remotes');
  const work = path.join(root, 'work');
  fs.mkdirSync(remotes);
  fs.mkdirSync(work);

  // alpha: has an origin, is behind by one commit and has a local change.
  git(remotes, 'init', '-q', '--bare', '-b', 'main', 'alpha.git');
  git(work, 'clone', '-q', path.join(remotes, 'alpha.git'), 'alpha');
  const alpha = path.join(work, 'alpha');
  git(alpha, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(alpha, 'readme.md'), '# alpha\n');
  git(alpha, 'add', '.');
  git(alpha, 'commit', '-q', '-m', 'first');
  git(alpha, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'clone', '-q', path.join(remotes, 'alpha.git'), 'alpha-other');
  const other = path.join(work, 'alpha-other');
  fs.writeFileSync(path.join(other, 'other.txt'), 'from elsewhere\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'remote work');
  git(other, 'push', '-q');
  fs.rmSync(other, { recursive: true, force: true });
  fs.writeFileSync(path.join(alpha, 'readme.md'), '# alpha\nlocal edit\n');
  fs.writeFileSync(path.join(alpha, 'scratch.txt'), 'untracked\n');

  // beta: no remote, a feature branch.
  const beta = path.join(work, 'nested', 'beta');
  fs.mkdirSync(beta, { recursive: true });
  git(beta, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(beta, 'a.txt'), 'a\n');
  git(beta, 'add', '.');
  git(beta, 'commit', '-q', '-m', 'beta first');
  git(beta, 'checkout', '-q', '-b', 'feature/x');

  // gamma: exists only as a remote; a profile clones it.
  git(remotes, 'init', '-q', '--bare', '-b', 'main', 'gamma.git');
  const seed = path.join(root, 'seed');
  git(root, 'clone', '-q', path.join(remotes, 'gamma.git'), 'seed');
  git(seed, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'g.txt'), 'g\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'gamma first');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  fs.rmSync(seed, { recursive: true, force: true });

  // delta: a project in a fake GitLab group, cloned by "clone from group".
  git(remotes, 'init', '-q', '--bare', '-b', 'main', 'delta.git');
  const seed2 = path.join(root, 'seed2');
  git(root, 'clone', '-q', path.join(remotes, 'delta.git'), 'seed2');
  git(seed2, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed2, 'd.txt'), 'd\n');
  git(seed2, 'add', '.');
  git(seed2, 'commit', '-q', '-m', 'delta first');
  git(seed2, 'push', '-q', '-u', 'origin', 'main');
  fs.rmSync(seed2, { recursive: true, force: true });

  // epsilon: a repository in a fake GitHub organization, cloned by "clone from organization".
  git(remotes, 'init', '-q', '--bare', '-b', 'main', 'epsilon.git');
  const seed3 = path.join(root, 'seed3');
  git(root, 'clone', '-q', path.join(remotes, 'epsilon.git'), 'seed3');
  git(seed3, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed3, 'e.txt'), 'e\n');
  git(seed3, 'add', '.');
  git(seed3, 'commit', '-q', '-m', 'epsilon first');
  git(seed3, 'push', '-q', '-u', 'origin', 'main');
  fs.rmSync(seed3, { recursive: true, force: true });

  const workspaceFile = path.join(work, 'test.code-workspace');
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: '.' }], settings: { 'canopy.autoFetch.intervalMinutes': 0, 'git.enabled': false } }, null, 2));
  return { workspaceFile, root };
}

async function main(): Promise<void> {
  const { workspaceFile, root } = makeFixture();
  process.env.CANOPY_E2E_ROOT = root;
  // Launched from inside VS Code this is set and would start the test instance as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
      extensionTestsPath: path.resolve(__dirname, './suite'),
      launchArgs: [workspaceFile, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { CANOPY_E2E_ROOT: root }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Benchmark: how many git processes CANOPY and VS Code's built-in Git start for N repositories, under several
 * configurations (see CONFIGS). Builds N small repositories (each with a local remote) directly inside the
 * workspace folder, where VS Code's Git opens them by itself, then runs ./bench inside VS Code once per configuration.
 * Every git process is counted through GIT_TRACE2_EVENT. Run: npm run bench [-- <repos> [default,openEditors,builtin]]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runTests } from '@vscode/test-electron';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Bench', '-c', 'user.email=bench@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' });
}

function makeFixture(count: number, root: string): string {
  const work = path.join(root, 'work');
  const remotes = path.join(root, 'remotes');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(remotes, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const name = `repo${String(i).padStart(3, '0')}`;
    const dir = path.join(work, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    for (let f = 1; f <= 40; f++) fs.writeFileSync(path.join(dir, 'src', `file${f}.txt`), `line ${f}\n`);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    git(remotes, 'clone', '-q', '--bare', dir, `${name}.git`);
    git(dir, 'remote', 'add', 'origin', path.join(remotes, `${name}.git`));
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    // Some state to compare: a modified file, a staged file and an untracked folder.
    fs.appendFileSync(path.join(dir, 'src', 'file1.txt'), 'changed\n');
    fs.appendFileSync(path.join(dir, 'src', 'file2.txt'), 'staged\n');
    git(dir, 'add', 'src/file2.txt');
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', 'todo.md'), 'todo\n');
  }
  return work;
}

interface Config {
  label: string;
  settings: Record<string, unknown>;
}

/** What each run changes; everything else stays at CANOPY's and VS Code's defaults. */
const CONFIGS: Record<string, Config> = {
  default: { label: 'Defaults (VS Code Git opens every repo)', settings: {} },
  openEditors: { label: 'git.autoRepositoryDetection: openEditors', settings: { 'git.autoRepositoryDetection': 'openEditors' } },
  builtin: { label: 'canopy.useBuiltinGit: true', settings: { 'canopy.useBuiltinGit': true } }
};

type Result = Record<'startup' | 'saves' | 'fetchAll', { canopy: number; all: number; ms?: number }> & { parity: { compared: number; mismatches: string[] }; fromBuiltin: number };

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 90);
  const names = (process.argv[3] ?? 'default,openEditors').split(',');
  const configs = names.map((n) => {
    const c = CONFIGS[n];
    if (!c) throw new Error(`Unknown configuration "${n}" (known: ${Object.keys(CONFIGS).join(', ')})`);
    return [n, c] as const;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-bench-'));
  delete process.env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const work = makeFixture(count, root);
  console.log(`Fixture: ${count} repositories in ${Math.round((Date.now() - started) / 1000)} s`);
  const results: Array<{ name: string; label: string; result: Result }> = [];
  try {
    for (const [name, config] of configs) {
      // Warm the file system cache, so the first configuration is not measured cold.
      for (const d of fs.readdirSync(work)) execFileSync('git', ['status', '--porcelain'], { cwd: path.join(work, d), stdio: 'pipe' });
      const trace = path.join(root, `trace-${name}`);
      fs.mkdirSync(trace);
      const out = path.join(root, `result-${name}.json`);
      const workspaceFile = path.join(root, `bench-${name}.code-workspace`);
      const settings = { 'canopy.autoFetch.intervalMinutes': 0, 'git.autofetch': false, 'git.openRepositoryInParentFolders': 'never', ...config.settings };
      fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: work }], settings }, null, 2));
      await runTests({
        extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
        extensionTestsPath: path.resolve(__dirname, './bench'),
        launchArgs: [workspaceFile, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(root, `user-${name}`)}`],
        extensionTestsEnv: { CANOPY_BENCH_OUT: out, CANOPY_BENCH_COUNT: String(count), CANOPY_BENCH_TRACE: trace, GIT_TRACE2_EVENT: trace }
      });
      results.push({ name, label: config.label, result: JSON.parse(fs.readFileSync(out, 'utf8')) as Result });
    }
    console.log(`\nGit processes for ${count} repositories. CANOPY = started by CANOPY; all = CANOPY + VS Code's Git.\n`);
    console.log(`| Scenario | ${results.map((r) => `${r.label}: CANOPY / all`).join(' | ')} |`);
    console.log(`|---|${results.map(() => '---').join('|')}|`);
    const cell = (r: Result, k: 'startup' | 'saves' | 'fetchAll') => `${r[k].canopy} / ${r[k].all}${r[k].ms !== undefined ? ` (${(r[k].ms! / 1000).toFixed(1)} s)` : ''}`;
    for (const [k, label] of [['startup', 'Startup until every row is loaded'], ['saves', '20 file saves'], ['fetchAll', 'Fetch All']] as const) {
      console.log(`| ${label} | ${results.map((r) => cell(r.result, k)).join(' | ')} |`);
    }
    for (const r of results) {
      if (r.result.parity.compared) console.log(`\nParity for "${r.label}": ${r.result.parity.compared} compared, ${r.result.parity.mismatches.length} mismatches${r.result.parity.mismatches.length ? ':\n  ' + r.result.parity.mismatches.slice(0, 5).join('\n  ') : ''}`);
    }
    fs.writeFileSync(path.resolve(__dirname, '../../../bench-results.json'), JSON.stringify({ count, results }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

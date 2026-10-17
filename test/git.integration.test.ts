import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitRunner } from '../src/git/runner';
import { LOG_FORMAT, parseLog, parseStatusV2 } from '../src/git/parse';
import { layoutGraph } from '../src/git/graph';

/** Exercises the runner and parsers against real git repositories in a temp folder. */
test('real git: status, ahead/behind, conflicts and graph', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-test-'));
  const git = new GitRunner('git', 4);
  const run = (cwd: string, ...args: string[]) => git.run(args, { cwd });
  const env = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  const commit = (cwd: string, msg: string) => git.run([...env, 'commit', '-q', '-m', msg], { cwd });
  try {
    const origin = path.join(tmp, 'origin.git');
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    await run(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    await run(tmp, 'clone', '-q', origin, a);
    await run(a, 'checkout', '-q', '-b', 'main');
    fs.writeFileSync(path.join(a, 'file.txt'), 'one\n');
    await run(a, 'add', '.');
    await commit(a, 'first');
    await run(a, 'push', '-q', '-u', 'origin', 'main');
    await run(tmp, 'clone', '-q', origin, b);

    // b moves ahead on the remote; a gets local changes and a local commit.
    fs.writeFileSync(path.join(b, 'file.txt'), 'two from b\n');
    await run(b, 'add', '.');
    await commit(b, 'b change');
    await run(b, 'push', '-q');
    fs.writeFileSync(path.join(a, 'file.txt'), 'two from a\n');
    await run(a, 'add', '.');
    await commit(a, 'a change');
    fs.writeFileSync(path.join(a, 'new file.md'), 'x');
    await run(a, 'fetch', '-q');

    let s = parseStatusV2(await git.run(['status', '--porcelain=v2', '--branch', '-z'], { cwd: a, readOnly: true }));
    assert.equal(s.branch, 'main');
    assert.equal(s.upstream, 'origin/main');
    assert.equal(s.ahead, 1);
    assert.equal(s.behind, 1);
    assert.deepEqual(s.unstaged.map((f) => [f.status, f.path]), [['U', 'new file.md']]);

    // Graph over both branches: a diverged history needs two lanes.
    const log = parseLog(await git.run(['log', '--topo-order', `--format=${LOG_FORMAT}`, '--all'], { cwd: a, readOnly: true }), ['origin']);
    assert.equal(log.length, 3);
    assert.equal(layoutGraph(log).width, 2);
    assert.ok(log.some((c) => c.refs.some((r) => r.type === 'head' && r.name === 'main')));
    assert.ok(log.some((c) => c.refs.some((r) => r.type === 'remote' && r.name === 'origin/main')));

    // Merging produces a conflict that the parser reports.
    await git.run([...env, 'merge', 'origin/main'], { cwd: a }).catch(() => undefined);
    s = parseStatusV2(await git.run(['status', '--porcelain=v2', '--branch', '-z'], { cwd: a, readOnly: true }));
    assert.deepEqual(s.conflicts.map((f) => f.path), ['file.txt']);
    assert.ok(fs.existsSync(path.join(a, '.git', 'MERGE_HEAD')));
    await run(a, 'merge', '--abort');

    // Errors carry git's message.
    await assert.rejects(git.run(['switch', 'does-not-exist'], { cwd: a }), (e: Error) => /does-not-exist|invalid reference/i.test(e.message));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

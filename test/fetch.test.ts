import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyFetchError, credentialHosts, retryDelayMs } from '../src/git/fetchErrors';
import { FetchScheduler } from '../src/git/fetchScheduler';

const err = (stderr: string, exitCode: number | null = 128) => Object.assign(new Error(stderr.split('\n')[0]), { stderr, exitCode });
const noSleep = () => Promise.resolve();
const tick = () => new Promise((r) => setImmediate(r));

test('classifyFetchError: dropped connections retry, credential failures do not, repo-specific errors are other', () => {
  assert.equal(classifyFetchError('Connection closed by 140.82.121.4 port 22\nfatal: Could not read from remote repository.'), 'transient');
  assert.equal(classifyFetchError('kex_exchange_identification: Connection closed by remote host'), 'transient');
  assert.equal(classifyFetchError('fatal: the remote end hung up unexpectedly\nfatal: early EOF'), 'transient');
  assert.equal(classifyFetchError('fatal: unable to access \'https://x/\': The requested URL returned error: 502'), 'transient');
  assert.equal(classifyFetchError('fatal: Could not resolve host: gitlab.example.com'), 'transient');
  assert.equal(classifyFetchError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), 'auth');
  assert.equal(classifyFetchError('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'auth');
  assert.equal(classifyFetchError('remote: HTTP Basic: Access denied\nfatal: Authentication failed for \'https://gitlab.com/a/b.git/\''), 'auth');
  assert.equal(classifyFetchError('ERROR: Repository not found.\nfatal: Could not read from remote repository.'), 'other');
  assert.equal(classifyFetchError("fatal: couldn't find remote ref refs/heads/gone"), 'other');
});

test('credentialHosts: one entry per host, local remotes ignored', () => {
  assert.deepEqual(credentialHosts(['git@github.com:a/b.git', 'https://github.com/c/d', 'ssh://git@GitLab.example.com:2222/x/y.git', 'C:\\repos\\local', '/srv/git/z.git']), ['github.com', 'gitlab.example.com']);
});

test('retryDelayMs: grows and stays within jitter bounds', () => {
  assert.equal(retryDelayMs(1, () => 0), 1125);
  assert.equal(retryDelayMs(1, () => 1), 1875);
  assert.equal(retryDelayMs(2, () => 0.5), 4000);
});

test('FetchScheduler: dropped connections retry silently and then succeed', async () => {
  const logs: string[] = [];
  const s = new FetchScheduler(12, (l) => logs.push(l), noSleep);
  let calls = 0;
  const out = await s.run({
    hosts: ['github.com'],
    mode: 'manual',
    exec: async () => {
      if (++calls < 3) throw err('kex_exchange_identification: Connection closed by remote host');
    }
  });
  assert.deepEqual(out, { ok: true, attempts: 3 });
  assert.equal(logs.length, 2);
});

test('FetchScheduler: gives up after two retries; timeouts and auth failures are not retried', async () => {
  const s = new FetchScheduler(12, () => {}, noSleep);
  let calls = 0;
  const dropped = await s.run({ hosts: [], mode: 'manual', exec: async () => void (calls++, (() => { throw err('Connection reset by peer'); })()) });
  assert.equal(dropped.ok, false);
  assert.equal(dropped.failure, 'transient');
  assert.equal(calls, 3);
  calls = 0;
  const timedOut = await s.run({ hosts: [], mode: 'manual', exec: async () => void (calls++, (() => { throw err('git fetch timed out', null); })()) });
  assert.equal(timedOut.failure, 'other');
  assert.equal(calls, 1);
});

test('FetchScheduler: one sign-in per host; the rest wait, then run in parallel', async () => {
  const s = new FetchScheduler(12, () => {}, noSleep);
  let running = 0;
  let peak = 0;
  const order: string[] = [];
  let releaseProbe!: () => void;
  const probeDone = new Promise<void>((r) => (releaseProbe = r));
  const exec = (name: string) => async () => {
    order.push(name);
    running++;
    peak = Math.max(peak, running);
    if (name === 'a') await probeDone; // the first fetch "shows the login window"
    else await tick();
    running--;
  };
  const tasks = ['a', 'b', 'c', 'd'].map((n) => s.run({ hosts: ['github.com'], mode: 'manual', batchStart: 0, exec: exec(n) }));
  await tick();
  await tick();
  assert.deepEqual(order, ['a'], 'others wait while the first fetch signs in');
  releaseProbe();
  const outs = await Promise.all(tasks);
  assert.ok(outs.every((o) => o.ok));
  assert.equal(order.length, 4);
  assert.ok(peak >= 2, 'after sign-in the remaining fetches run concurrently');
});

test('FetchScheduler: a failed sign-in skips the host for the rest of the batch, a new manual batch asks once more', async () => {
  let now = 1000;
  const s = new FetchScheduler(12, () => {}, noSleep, () => now);
  let prompts = 0;
  const exec = async () => {
    prompts++;
    throw err("fatal: Authentication failed for 'https://gitlab.com/a/b.git/'");
  };
  const batch1 = await Promise.all([1, 2, 3].map(() => s.run({ hosts: ['gitlab.com'], mode: 'manual', batchStart: 1000, exec })));
  assert.equal(prompts, 1);
  assert.equal(batch1.filter((o) => o.skipped).length, 2);
  assert.ok(batch1.every((o) => o.failure === 'auth'));
  // Background fetches never retry a host whose sign-in failed.
  const bg = await s.run({ hosts: ['gitlab.com'], mode: 'background', exec });
  assert.equal(bg.skipped, true);
  assert.equal(prompts, 1);
  // The user fetches again: one more attempt.
  now = 5000;
  await Promise.all([1, 2].map(() => s.run({ hosts: ['gitlab.com'], mode: 'manual', batchStart: 5000, exec })));
  assert.equal(prompts, 2);
});

test('FetchScheduler: a repo-specific error does not block the host', async () => {
  const s = new FetchScheduler(12, () => {}, noSleep);
  const outs = await Promise.all(
    ['missing', 'ok1', 'ok2'].map((n) =>
      s.run({
        hosts: ['github.com'],
        mode: 'manual',
        batchStart: 0,
        exec: async () => {
          if (n === 'missing') throw err('ERROR: Repository not found.');
        }
      })
    )
  );
  assert.deepEqual(outs.map((o) => o.ok), [false, true, true]);
});

test('FetchScheduler: a host that is down does not make its repos take turns', async () => {
  const s = new FetchScheduler(12, () => {}, noSleep);
  let running = 0;
  let peak = 0;
  const outs = await Promise.all(
    Array.from({ length: 6 }, () =>
      s.run({
        hosts: ['gitlab.example.com'],
        mode: 'manual',
        batchStart: 0,
        exec: async () => {
          running++;
          peak = Math.max(peak, running);
          await tick();
          running--;
          throw err('fatal: Could not resolve host: gitlab.example.com');
        }
      })
    )
  );
  assert.ok(outs.every((o) => !o.ok && o.failure === 'transient'));
  assert.ok(peak >= 2, 'after the first failure the rest run in parallel');
});

test('FetchScheduler: manual concurrency limit is honoured; 0 means unlimited', async () => {
  for (const [limit, expected] of [[3, 3], [0, 20]] as const) {
    const s = new FetchScheduler(limit, () => {}, noSleep);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        s.run({
          hosts: [],
          mode: 'manual',
          exec: async () => {
            running++;
            peak = Math.max(peak, running);
            await tick();
            running--;
          }
        })
      )
    );
    assert.equal(peak, expected);
  }
});

test('FetchScheduler: background fetches run two at a time', async () => {
  const s = new FetchScheduler(12, () => {}, noSleep);
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      s.run({
        hosts: [],
        mode: 'background',
        exec: async () => {
          running++;
          peak = Math.max(peak, running);
          await tick();
          running--;
        }
      })
    )
  );
  assert.equal(peak, 2);
});

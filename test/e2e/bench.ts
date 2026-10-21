/** Runs inside VS Code for runBench.ts: measures git processes per scenario and checks built-in Git parity. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CanopyApi } from '../../src/extension';
import { parseStatusV2, StatusInfo } from '../../src/git/parse';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, fn: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Top-level git processes recorded by GIT_TRACE2_EVENT (children such as index-pack carry a "/" in their sid). */
function countTrace(dir: string): number {
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"event":"start"')) continue;
      try {
        const e = JSON.parse(line) as { sid?: string };
        if (e.sid && !e.sid.includes('/')) n++;
      } catch {
        // A line still being written.
      }
    }
  }
  return n;
}

/** Differences that matter between two readings of the same repository. Untracked folders may list file by file. */
function diff(name: string, a: StatusInfo, b: StatusInfo): string[] {
  const out: string[] = [];
  for (const k of ['branch', 'oid', 'detached', 'upstream', 'ahead', 'behind'] as const) if (a[k] !== b[k]) out.push(`${name}: ${k} ${String(a[k])} vs ${String(b[k])}`);
  const paths = (l: { path: string; status: string }[], untracked: boolean) => l.filter((f) => (f.status === 'U') === untracked).map((f) => `${f.status} ${f.path}`).sort().join(', ');
  if (paths(a.staged, false) !== paths(b.staged, false)) out.push(`${name}: staged [${paths(a.staged, false)}] vs [${paths(b.staged, false)}]`);
  if (paths(a.unstaged, false) !== paths(b.unstaged, false)) out.push(`${name}: changes [${paths(a.unstaged, false)}] vs [${paths(b.unstaged, false)}]`);
  if (paths(a.conflicts, false) !== paths(b.conflicts, false)) out.push(`${name}: conflicts differ`);
  // Every untracked file VS Code lists must be one CANOPY lists, or inside an untracked folder CANOPY lists.
  const own = b.unstaged.filter((f) => f.status === 'U').map((f) => f.path);
  for (const f of a.unstaged.filter((x) => x.status === 'U')) if (!own.some((o) => o === f.path || (o.endsWith('/') && f.path.startsWith(o)))) out.push(`${name}: untracked ${f.path} missing`);
  return out;
}

export async function run(): Promise<void> {
  const out = process.env.CANOPY_BENCH_OUT!;
  const count = Number(process.env.CANOPY_BENCH_COUNT);
  const trace = process.env.CANOPY_BENCH_TRACE!;
  const t0 = Date.now();
  const ext = vscode.extensions.getExtension<CanopyApi>('MyriadArtificia.canopy-git')!;
  const { manager, builtin } = await ext.activate();
  await waitFor('every repository loaded', () => manager.all.length >= count && manager.all.every((r) => r.loaded), 180_000);
  const startupMs = Date.now() - t0;
  // Let VS Code's Git finish its own startup reads before counting.
  await sleep(6000);
  const snap = () => ({ canopy: manager.runner.activity.summary().processes, all: countTrace(trace) });
  const s0 = snap();

  const repos = [...manager.all].sort((a, b) => a.name.localeCompare(b.name));
  for (const r of repos.slice(0, 20)) {
    const doc = await vscode.workspace.openTextDocument(path.join(r.root, 'src', 'file3.txt'));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), 'saved\n');
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await sleep(250);
  }
  await sleep(6000);
  const s1 = snap();

  const t1 = Date.now();
  await vscode.commands.executeCommand('canopy.fetchAll');
  const fetchMs = Date.now() - t1;
  await sleep(6000);
  const s2 = snap();

  // Parity last, so its own git status calls are not counted above.
  const mismatches: string[] = [];
  let compared = 0;
  if (builtin.enabled) {
    for (const r of repos) {
      const fromBuiltin = builtin.read(r.root);
      if (!fromBuiltin) continue;
      const own = parseStatusV2(await manager.runner.run(['status', '--porcelain=v2', '--branch', '-z'], { cwd: r.root, readOnly: true, priority: true }));
      compared++;
      mismatches.push(...diff(r.name, fromBuiltin.status, own));
    }
  }
  const result = {
    useBuiltinGit: builtin.enabled,
    fromBuiltin: manager.builtinCount(),
    startup: { canopy: s0.canopy, all: s0.all, ms: startupMs },
    saves: { canopy: s1.canopy - s0.canopy, all: s1.all - s0.all },
    fetchAll: { canopy: s2.canopy - s1.canopy, all: s2.all - s1.all, ms: fetchMs },
    parity: { compared, mismatches }
  };
  console.log(JSON.stringify(result));
  fs.writeFileSync(out, JSON.stringify(result));
}

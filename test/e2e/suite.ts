/** Runs inside the VS Code extension host (see runE2e.ts). Plain assertions; no test framework. */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CanopyApi } from '../../src/extension';
import { addFolder, moveRepos } from '../../src/model/layout';
import { parseProfile } from '../../src/model/profile';
import { priorityDecoration } from '../../src/tree';

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitForAsync<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const results: Array<[string, boolean, string?]> = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push([name, true]);
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push([name, false, (e as Error).stack]);
    console.log(`  ✖ ${name}\n${(e as Error).stack}`);
  }
}

export async function run(): Promise<void> {
  const root = process.env.CANOPY_E2E_ROOT!;
  const ext = vscode.extensions.getExtension<CanopyApi>('MyriadArtificia.canopy-git');
  assert.ok(ext, 'extension is installed');
  const api = await ext.activate();
  const { manager, tree, store, state, ops, profiles, detail, profilesPanel, gitlab, github, forge } = api;
  const byName = (n: string) => manager.all.find((r) => r.name === n);

  await step('discovers repositories in the workspace, including nested ones', async () => {
    await waitFor('2 repos', () => manager.all.length === 2 && manager.all.every((r) => r.loaded));
    assert.deepEqual(manager.all.map((r) => r.name).sort(), ['alpha', 'beta']);
    assert.equal(byName('beta')!.branch, 'feature/x');
  });

  await step('registers every contributed command', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, 'package.json'), 'utf8'));
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = pkg.contributes.commands.map((c: { command: string }) => c.command).filter((c: string) => !all.has(c));
    assert.deepEqual(missing, []);
  });

  await step('reads status: changes and untracked files', async () => {
    const alpha = byName('alpha')!;
    assert.equal(alpha.upstream, 'origin/main');
    assert.deepEqual(alpha.unstaged.map((f) => f.status + ' ' + f.path).sort(), ['M readme.md', 'U scratch.txt']);
  });

  await step('fetch updates behind count', async () => {
    const alpha = byName('alpha')!;
    await vscode.commands.executeCommand('canopy.fetch', alpha);
    await waitFor('behind = 1', () => alpha.behind === 1);
  });

  await step('stage all / unstage all through commands', async () => {
    const alpha = byName('alpha')!;
    await vscode.commands.executeCommand('canopy.stageAll', alpha);
    await waitFor('staged', () => alpha.staged.length === 2);
    await vscode.commands.executeCommand('canopy.unstageAll', alpha);
    await waitFor('unstaged', () => alpha.staged.length === 0 && alpha.unstaged.length === 2);
  });

  await step('layout is saved into the .code-workspace file', async () => {
    const alpha = byName('alpha')!;
    const { layout, id } = addFolder(tree.currentLayout, 'Backend');
    await tree.saveLayout(moveRepos(layout, [alpha.key], id));
    const wsFile = vscode.workspace.workspaceFile!.fsPath;
    await waitFor('workspace file updated', () => fs.readFileSync(wsFile, 'utf8').includes('Backend'));
    const saved = JSON.parse(fs.readFileSync(wsFile, 'utf8')).settings['canopy.layout'];
    assert.equal(saved.folders[0].name, 'Backend');
    assert.deepEqual(saved.folders[0].repos, ['alpha']);
    assert.equal(tree.folderNamesOf(alpha)[0], 'Backend');
  });

  await step('tree shows folders and Unsorted; hidden repos disappear', async () => {
    const top = tree.getChildren();
    assert.deepEqual(top.map((n) => n.kind), ['folder', 'unsorted']);
    const beta = byName('beta')!;
    await vscode.commands.executeCommand('canopy.hideRepository', beta);
    assert.ok(tree.currentLayout.hidden.includes(beta.key));
    assert.deepEqual(tree.getChildren().map((n) => n.kind), ['folder']);
    await tree.saveLayout({ ...tree.currentLayout, hidden: [] });
  });

  await step('opens the details panel', async () => {
    await vscode.commands.executeCommand('canopy.openDetails', byName('alpha'));
    await waitFor('details tab', () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label.startsWith('CANOPY · alpha'))));
    const render = await waitFor('details webview rendered', () => detail.lastRender);
    assert.ok(render.rows >= 2, 'graph rows rendered (commits + uncommitted row)');
    assert.equal(render.drawn, render.rows, 'a short graph is drawn in full');
    assert.equal(render.files, 2);
  });

  await step('the tree redraws only a changed row, and builds tooltips on hover', async () => {
    const alpha = byName('alpha')!;
    const flatten = (nodes: ReturnType<typeof tree.getChildren>): ReturnType<typeof tree.getChildren> => nodes.flatMap((n) => [n, ...flatten(tree.getChildren(n))]);
    const all = flatten(tree.getChildren());
    const alphaNode = all.find((n) => n.kind === 'repo' && n.repo === alpha)!;
    await new Promise((r) => setTimeout(r, 400));
    const fired: unknown[] = [];
    const sub = tree.onDidChangeTreeData((e) => fired.push(e));
    manager.beginActivity(alpha, 'Testing');
    await new Promise((r) => setTimeout(r, 400));
    manager.endActivity(alpha, 'Testing');
    await new Promise((r) => setTimeout(r, 400));
    sub.dispose();
    assert.ok(fired.length > 0, 'the row was redrawn');
    assert.ok(fired.every((e) => e !== undefined), 'no whole-tree redraw for a spinner');
    assert.ok(fired.includes(alphaNode), 'the very node VS Code was given');
    const item = tree.getTreeItem(alphaNode);
    assert.equal(item.tooltip, undefined, 'no tooltip built up front');
    assert.ok(tree.resolveTreeItem(item, alphaNode).tooltip instanceof vscode.MarkdownString, 'tooltip built on hover');
  });

  await step('opens the profiles panel and renders the editor', async () => {
    await vscode.commands.executeCommand('canopy.openProfiles');
    const rows = await waitFor('profiles webview rendered', () => profilesPanel.lastRenderRows);
    assert.equal(rows, 2);
  });

  await step('saved profiles list both workspace profiles and profile files in the project', async () => {
    const panel = profilesPanel;
    const editor = await profiles.editorFromCurrent();
    editor.name = 'In workspace';
    await profiles.save(profiles.profileFromEditor(editor));

    editor.name = 'In a file';
    const fileUri = vscode.Uri.file(path.join(store.baseDir!, 'team.canopy-profile.json'));
    await profiles.saveToFile(profiles.profileFromEditor(editor), fileUri);

    const entries = await waitForAsync('both profiles listed', async () => {
      const all = await profiles.listAll();
      return all.length >= 2 ? all : undefined;
    });
    const ws = entries.find((e) => e.profile.name === 'In workspace')!;
    const file = entries.find((e) => e.profile.name === 'In a file')!;
    assert.equal(ws.source, 'workspace');
    assert.equal(ws.location, 'test.code-workspace');
    assert.equal(file.source, 'file');
    assert.match(file.location, /team\.canopy-profile\.json$/);

    // Loading a file profile and saving writes back to the same file, without asking where.
    await panel.handleMessage({ type: 'load', id: file.profile.id }, () => undefined);
    const loaded = await profiles.editorFromProfile(file.profile, 'profile', file.uri!.toString());
    loaded.name = 'Renamed in file';
    await panel.handleMessage({ type: 'save', editor: loaded }, () => undefined);
    const onDisk = JSON.parse(fs.readFileSync(fileUri.fsPath, 'utf8'));
    assert.equal(onDisk.name, 'Renamed in file');
    assert.equal(onDisk.canopyProfile, 1);
  });

  await step('opens a working-tree diff beside', async () => {
    const alpha = byName('alpha')!;
    const { openChange } = await import('../../src/gitContent');
    await openChange(alpha, alpha.unstaged.find((f) => f.path === 'readme.md')!, false);
    await waitFor('diff tab', () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && t.label.includes('readme.md'))));
    const diff = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff)!.input as vscode.TabInputTextDiff;
    const left = await vscode.workspace.openTextDocument(diff.original);
    assert.equal(left.getText(), '# alpha\n');
  });

  await step('discard with safety stash keeps a recoverable stash', async () => {
    const alpha = byName('alpha')!;
    assert.equal(await ops.discard(alpha, ['readme.md'], true), true);
    await waitFor('readme discarded', () => !alpha.unstaged.some((f) => f.path === 'readme.md'));
    const stashes = await alpha.git(['stash', 'list']);
    assert.match(stashes, /CANOPY safety stash/);
    assert.equal(fs.readFileSync(path.join(alpha.root, 'readme.md'), 'utf8').replace(/\r\n/g, '\n'), '# alpha\n');
  });

  await step('discarding an untracked file with the safety stash succeeds without a git error', async () => {
    const alpha = byName('alpha')!;
    const file = path.join(alpha.root, 'scratch-settings.json');
    fs.writeFileSync(file, '{}\n');
    await manager.refresh(alpha);
    await waitFor('untracked file listed', () => alpha.unstaged.some((f) => f.path === 'scratch-settings.json'));
    const stashCount = async () => (await alpha.git(['stash', 'list'])).split('\n').filter(Boolean).length;
    const before = await stashCount();
    assert.equal(await ops.discard(alpha, ['scratch-settings.json'], true), true, 'discard reports success');
    await waitFor('untracked file discarded', () => !alpha.unstaged.some((f) => f.path === 'scratch-settings.json'));
    assert.equal(await stashCount(), before + 1, 'one new stash');
    assert.equal(fs.existsSync(file), false);
  });

  await step('pull fast-forwards', async () => {
    const alpha = byName('alpha')!;
    await vscode.commands.executeCommand('canopy.pullFfOnly', alpha);
    await waitFor('behind = 0', () => alpha.behind === 0);
    assert.ok(fs.existsSync(path.join(alpha.root, 'other.txt')));
  });

  await step('profile from current state, then apply a profile that clones a missing repo', async () => {
    const editor = await profiles.editorFromCurrent();
    assert.equal(editor.rows.find((r) => r.name === 'beta')!.include, false, 'repos without a remote cannot be shared');
    const current = profiles.profileFromEditor(editor);
    assert.deepEqual(current.repos.map((r) => [r.name, r.branch]), [['alpha', 'main']]);

    const gammaRemote = path.join(root, 'remotes', 'gamma.git');
    const p = parseProfile({ name: 'E2E', repos: [...current.repos, { name: 'gamma', remote: gammaRemote, branch: 'main', path: 'cloned/gamma', folder: 'Team/Gamma' }], onApply: { recreateLayout: true } });
    const base = store.baseDir!;
    const { steps } = profiles.plan(p, base);
    assert.deepEqual(steps.map((s) => s.kind), ['ok', 'clone']);
    await profiles.apply(p, base);
    await waitFor('gamma discovered', () => byName('gamma')?.loaded);
    assert.equal(byName('gamma')!.branch, 'main');
    await waitFor('layout recreated', () => tree.folderNamesOf(byName('gamma')!).join('/') === 'Team/Gamma');
  });

  await step('GitLab: token, pipeline and MR status, create MR, clone from group', async () => {
    const server = await startFakeGitLab(path.join(root, 'remotes', 'delta.git'));
    try {
      const url = server.url;
      const alpha = byName('alpha')!;
      await alpha.git(['remote', 'add', 'gitlab', `${url}/acme/alpha.git`]);
      await vscode.workspace.getConfiguration('canopy').update('gitlab.instances', [{ url }], vscode.ConfigurationTarget.Global);
      await manager.refresh(alpha);
      await waitFor('instance configured', () => gitlab.instances().length === 1);
      assert.equal(gitlab.state(alpha).kind, 'disconnected', 'a configured server without a token shows as disconnected');
      assert.equal(gitlab.state(byName('beta')!).kind, 'none');

      await gitlab.setToken(url, 'wrong-token');
      let info = await gitlab.refresh(alpha);
      assert.match(info?.error ?? '', /invalid, expired or revoked/);

      await gitlab.setToken(url, 'good-token');
      info = await gitlab.refresh(alpha);
      assert.equal(info?.error, undefined);
      assert.equal(info?.project?.id, 7);
      assert.equal(info?.pipeline?.status, 'failed');
      assert.equal(tree.factsOf(alpha).ci, 'failed');
      assert.ok(server.seenAuth.every((h) => h === 'Bearer good-token' || h === 'Bearer wrong-token'));

      await alpha.git(['switch', '-c', 'feature/y']);
      await manager.refresh(alpha);
      info = await gitlab.refresh(alpha);
      assert.equal(info?.mr, undefined);
      const mr = await gitlab.createMergeRequestFor(alpha, { targetBranch: 'main', title: 'Add y', draft: true });
      assert.equal(mr?.iid, 1);
      assert.equal(server.created[0].title, 'Draft: Add y');
      assert.equal(server.created[0].source_branch, 'feature/y');
      info = await gitlab.refresh(alpha);
      assert.equal(info?.mr?.iid, 1);
      assert.equal(info?.mr?.draft, true);
      assert.equal(info?.mr?.approvalsLeft, 1);
      assert.equal(tree.factsOf(alpha).mr, 'draft');

      const { profile, skipped } = gitlab.profileFromProjects('acme/team', server.groupProjects);
      assert.deepEqual(skipped, ['acme/team/empty (empty repository)']);
      assert.deepEqual(profile.repos.map((r) => [r.path, r.folder]), [['team/sub/delta', 'team/sub']]);
      await profiles.apply(profile, store.baseDir!);
      await waitFor('delta discovered', () => byName('delta')?.loaded);
      await waitFor('delta filed under team/sub', () => tree.folderNamesOf(byName('delta')!).join('/') === 'team/sub');
    } finally {
      server.close();
    }
  });


  await step('GitHub: checks and PR status, ETag reuse, create PR, re-run, clone from organization', async () => {
    const server = await startFakeGitHub(path.join(root, 'remotes', 'epsilon.git'));
    try {
      const beta = byName('beta')!;
      await beta.git(['remote', 'add', 'origin', `${server.url}/acme/beta.git`]);
      await manager.refresh(beta);
      await github.useTestServer(server.host, `${server.url}/api/v3`, 'gh-token');
      assert.equal(forge.state(beta).kind, 'connected');
      assert.equal(forge.providerFor(beta)?.kind, 'github');

      let info = await forge.refresh(beta);
      assert.equal(info?.error, undefined);
      assert.equal(info?.provider, 'github');
      assert.equal(info?.pipeline?.status, 'failed', 'one failed run among the newest commit\'s runs makes the checks fail');
      assert.equal(info?.pipeline?.id, 77);
      assert.equal(info?.mr, undefined);
      assert.equal(tree.factsOf(beta).ci, 'failed');

      const pr = await github.createRequestFor(beta, { base: 'main', title: 'Add x', draft: true });
      assert.equal(pr?.number, 1);
      assert.deepEqual([server.createdPulls[0].head, server.createdPulls[0].base, server.createdPulls[0].draft], ['feature/x', 'main', true]);

      info = await forge.refresh(beta);
      assert.equal(info?.mr?.iid, 1);
      assert.equal(info?.mr?.draft, true);
      assert.equal(info?.mr?.approved, true);
      assert.deepEqual(info?.mr?.approvedBy, ['mei']);
      assert.equal(tree.factsOf(beta).mr, 'draft');
      assert.ok(server.notModified > 0, 'unchanged GitHub answers come back as 304 and are reused');
      assert.ok(server.seenAuth.every((h) => h === 'Bearer gh-token'));

      await github.retryPipeline(beta);
      assert.deepEqual(server.reruns, ['77:rerun-failed-jobs']);

      const repos = server.orgRepos;
      const { profile, skipped } = github.profileFromRepos('acme', repos);
      assert.deepEqual(skipped, ['acme/empty (empty repository)']);
      assert.deepEqual(profile.repos.map((r) => [r.path, r.folder]), [['acme/zeta', 'acme']]);
      await profiles.apply(profile, store.baseDir!);
      await waitFor('zeta discovered', () => byName('zeta')?.loaded);
      await waitFor('zeta filed under acme', () => tree.folderNamesOf(byName('zeta')!).join('/') === 'acme');
    } finally {
      server.close();
    }
  });

  await step('Branch menu lists local then remote branches and checks one out on click', async () => {
    const beta = byName('beta')!;
    await vscode.commands.executeCommand('canopy.openDetails', beta);
    const panel = detail as unknown as { onMessage(m: unknown): Promise<void> };
    await panel.onMessage({ type: 'checkoutBranch', name: 'main', remote: false });
    await waitFor('beta on main', () => beta.branch === 'main');
    await panel.onMessage({ type: 'checkoutBranch', name: 'feature/x', remote: false });
    await waitFor('beta back on feature/x', () => beta.branch === 'feature/x');
  });

  await step('tree rows spin and say what they are doing while a pull or push runs', async () => {
    const alpha = byName('alpha')!;
    const node = { kind: 'repo' as const, repo: alpha, parent: '__unsorted' };
    const idle = tree.getTreeItem(node);
    assert.notEqual((idle.iconPath as vscode.ThemeIcon).id, 'sync~spin');
    assert.ok(!String(idle.description).includes('…'), 'no activity text when idle');

    const pending = ops.exec(alpha, ['pull'], { quiet: true });
    assert.deepEqual(alpha.activity, ['Pulling'], 'marked busy as soon as the command starts');
    const busy = tree.getTreeItem(node);
    assert.equal((busy.iconPath as vscode.ThemeIcon).id, 'sync~spin');
    assert.match(String(busy.description), /^Pulling…/);
    await pending;
    assert.deepEqual(alpha.activity, [], 'cleared when it finishes');
    assert.notEqual((tree.getTreeItem(node).iconPath as vscode.ThemeIcon).id, 'sync~spin');

    // A failing command must clear it too.
    await ops.exec(alpha, ['push', 'no-such-remote', 'main'], { quiet: true });
    assert.deepEqual(alpha.activity, []);

    // Fetch, sync and other git actions share the same marker.
    const fetching = manager.fetch(alpha);
    assert.ok((alpha.activity as string[]).includes('Fetching'), 'fetch marks the repo busy');
    await fetching;
    assert.deepEqual(alpha.activity, []);

    // Earlier steps left alpha on a branch without an upstream; sync needs one.
    await alpha.git(['switch', 'main']);
    // ...and something to push, so the sync has real work to do.
    await alpha.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'sync test']);
    await manager.refresh(alpha);
    assert.ok(alpha.upstream && alpha.ahead > 0, 'alpha has an upstream and a commit to push');
    const syncing = ops.sync([alpha]);
    assert.ok((alpha.activity as string[]).includes('Syncing'), 'sync holds one steady marker around its pull and push');
    await syncing;
    assert.deepEqual(alpha.activity, [], 'nothing left behind after a sync');

    const stashing = ops.exec(alpha, ['stash', 'list'], { quiet: true });
    assert.deepEqual(alpha.activity, ['Stashing']);
    await stashing;
    const staging = ops.exec(alpha, ['add', '--dry-run', '.'], { quiet: true });
    assert.deepEqual(alpha.activity, [], 'instant staging commands do not flicker a spinner');
    await staging;
  });

  await step('submodules nest under their parent with their own icon, and the moved marker appears', async () => {
    const sh = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd, stdio: 'pipe' }).toString();
    const base = path.join(root, 'work', 'submodule-test');
    const lib = path.join(base, 'lib-src');
    const host = path.join(base, 'host');
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(host, { recursive: true });
    sh(lib, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(lib, 'a.txt'), 'one\n');
    sh(lib, 'add', '.');
    sh(lib, 'commit', '-q', '-m', 'lib one');
    sh(host, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(host, 'readme.md'), '# host\n');
    sh(host, 'add', '.');
    sh(host, 'commit', '-q', '-m', 'host one');
    sh(host, 'submodule', 'add', '-q', lib, 'libs/lib');
    sh(host, 'commit', '-q', '-m', 'add submodule');
    const added = await manager.addRepositories([host, path.join(host, 'libs', 'lib')]);
    assert.equal(added.length, 2, `both repositories were registered (got ${added.map((r) => r.root).join(', ') || 'none'})`);
    const [hostRepo, subRepo] = added;
    await waitFor('both repositories loaded', () => hostRepo.loaded && subRepo.loaded && subRepo.superRoot);
    assert.equal(tree.parentOf(subRepo)?.key, hostRepo.key, 'submodule knows its parent');

    const topLevel = tree.getChildren().flatMap((n) => (n.kind === 'unsorted' || n.kind === 'folder' ? tree.getChildren(n) : [n]));
    assert.ok(topLevel.some((n) => n.kind === 'repo' && n.repo === hostRepo), 'parent is listed');
    assert.ok(!topLevel.some((n) => n.kind === 'repo' && n.repo === subRepo), 'submodule is not listed at the top level');
    const hostNode = topLevel.find((n) => n.kind === 'repo' && n.repo === hostRepo)!;
    const kids = tree.getChildren(hostNode);
    assert.deepEqual(kids.map((k) => (k.kind === 'repo' ? k.repo.name : '')), ['lib'], 'submodule is a child of its parent');
    assert.notEqual(tree.getTreeItem(hostNode).collapsibleState, vscode.TreeItemCollapsibleState.None, 'parent is expandable');
    const subItem = tree.getTreeItem(kids[0]);
    assert.equal((subItem.iconPath as vscode.ThemeIcon).id, 'file-submodule', 'submodule icon');
    assert.match(String(subItem.contextValue), /submodule/);
    assert.equal(tree.getParent(kids[0])?.kind === 'repo' && (tree.getParent(kids[0]) as { repo: unknown }).repo === hostRepo, true);

    // A new commit inside the submodule leaves it ahead of what the parent records.
    fs.writeFileSync(path.join(host, 'libs', 'lib', 'a.txt'), 'two\n');
    sh(path.join(host, 'libs', 'lib'), 'commit', '-q', '-am', 'lib two');
    await manager.refresh(hostRepo);
    await manager.refresh(subRepo);
    assert.equal(tree.factsOf(subRepo).submoduleMoved, true, 'moved marker');
    // The new commit is also unpushed, and push outranks the moved marker; with nothing else pending the marker shows.
    assert.equal(priorityDecoration(tree.factsOf(subRepo))?.badge, '↑1');
    assert.equal(priorityDecoration({ ...tree.factsOf(subRepo), ahead: 0, behind: 0, changed: 0 })?.badge, '≠');
  });

  await step('submodules from .gitmodules: unloaded until expanded, collapsed, nested in every grouping', async () => {
    const sh = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd, stdio: 'pipe' }).toString();
    const base = path.join(root, 'work', 'declared-submodule-test');
    const lib = path.join(base, 'dep-src');
    const host = path.join(base, 'app');
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(host, { recursive: true });
    sh(lib, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(lib, 'a.txt'), 'one\n');
    sh(lib, 'add', '.');
    sh(lib, 'commit', '-q', '-m', 'dep one');
    sh(host, 'init', '-q', '-b', 'main');
    sh(host, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/dep');
    sh(host, 'commit', '-q', '-m', 'add dep');
    const depRoot = path.join(host, 'vendor', 'dep');
    // What `git submodule update` leaves behind: the recorded commit, no branch.
    sh(depRoot, 'checkout', '-q', '--detach');
    // Only the parent is added; the submodule comes from its .gitmodules.
    const [appRepo] = await manager.addRepositories([host]);
    const dep = await waitFor('declared submodule registered', () => manager.findByRoot(depRoot));
    assert.equal(dep.lazy, true, 'unloaded until its parent is expanded');
    assert.equal(dep.declaredBy, appRepo.key);
    assert.equal(dep.loaded, false, 'no git has run for it yet');
    assert.ok(!tree.visibleRepos().includes(dep), 'not part of Fetch All, totals or profiles');

    const findApp = () => tree.getChildren().flatMap((n) => (n.kind === 'unsorted' || n.kind === 'folder' || n.kind === 'group' ? tree.getChildren(n) : [n])).find((n) => n.kind === 'repo' && n.repo === appRepo)!;
    const appNode = findApp();
    assert.equal(tree.getTreeItem(appNode).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'parent starts collapsed');
    const kids = tree.getChildren(appNode);
    assert.deepEqual(kids.map((k) => (k.kind === 'repo' ? k.repo.name : '')), ['dep']);
    await waitFor('submodule loads on expand', () => dep.loaded && !dep.lazy);
    assert.equal(dep.detached, true, 'detached HEAD is read once loaded');
    assert.match(dep.branchLabel, /\(detached\)/, 'row shows the commit it is on');
    assert.match(String(tree.getTreeItem(tree.getChildren(findApp())[0]).contextValue), /:detached/, 'detached rows hide Pull / Push');

    // Grouped by status, the submodule still sits under its parent instead of in the flat group list.
    await state.set({ groupBy: 'status' });
    try {
      const groupRows = tree.getChildren().flatMap((g) => tree.getChildren(g));
      assert.ok(groupRows.some((n) => n.kind === 'repo' && n.repo === appRepo), 'parent listed in its status group');
      assert.ok(!groupRows.some((n) => n.kind === 'repo' && n.repo === dep), 'submodule not listed flat');
      const appInGroup = groupRows.find((n) => n.kind === 'repo' && n.repo === appRepo)!;
      assert.deepEqual(tree.getChildren(appInGroup).map((k) => (k.kind === 'repo' ? k.repo.name : '')), ['dep']);
    } finally {
      await state.set({ groupBy: 'folders' });
    }
  });

  await step('long graphs draw only the rows in view', async () => {
    const big = path.join(root, 'work', 'long-history');
    fs.mkdirSync(big, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: big });
    // 400 commits in one process.
    let stream = '';
    for (let i = 1; i <= 400; i++) {
      const msg = `commit ${i}`;
      const body = `line ${i}\n`;
      stream += `commit refs/heads/main\nmark :${i}\ncommitter Bench <b@example.com> ${1_700_000_000 + i * 60} +0000\ndata ${msg.length}\n${msg}\n${i > 1 ? `from :${i - 1}\n` : ''}M 644 inline f.txt\ndata ${body.length}\n${body}\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: big, input: stream });
    execFileSync('git', ['reset', '-q', '--hard'], { cwd: big });
    const [repo] = await manager.addRepositories([big]);
    await waitFor('long repo loaded', () => repo.loaded);
    detail.lastRender = undefined;
    await vscode.commands.executeCommand('canopy.openDetails', repo);
    const render = await waitFor('long graph rendered', () => (detail.lastRender?.rows === 300 ? detail.lastRender : undefined));
    assert.ok(render.drawn > 0 && render.drawn < 120, `only a window of the 300 rows is drawn (drew ${render.drawn})`);
  });

  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) throw new Error(`${failed.length} e2e step(s) failed: ${failed.map((f) => f[0]).join('; ')}`);
}

/** A tiny stand-in for the GitLab API endpoints CANOPY uses. */
async function startFakeGitLab(deltaRemote: string) {
  const created: Array<Record<string, string>> = [];
  const seenAuth: string[] = [];
  let base = '';
  const groupProjects = [
    { id: 20, name: 'delta', path: 'delta', path_with_namespace: 'acme/team/sub/delta', default_branch: 'main', web_url: '', http_url_to_repo: deltaRemote, ssh_url_to_repo: deltaRemote },
    { id: 21, name: 'empty', path: 'empty', path_with_namespace: 'acme/team/empty', default_branch: null, web_url: '', http_url_to_repo: 'https://x/empty.git', ssh_url_to_repo: 'git@x:empty.git' }
  ];
  const mrJson = (m: Record<string, string>, i: number) => ({
    iid: i + 1,
    title: m.title,
    web_url: `${base}/acme/alpha/-/merge_requests/${i + 1}`,
    draft: m.title.startsWith('Draft:'),
    has_conflicts: false,
    source_branch: m.source_branch,
    target_branch: m.target_branch,
    state: 'opened'
  });
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    seenAuth.push(auth);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (auth !== 'Bearer good-token') return send(401, { message: '401 Unauthorized' });
    const u = new URL(req.url!, base);
    const p = u.pathname;
    if (p === '/api/v4/user') return send(200, { id: 1, username: 'tester', name: 'Tester' });
    if (p === '/api/v4/projects/acme%2Falpha') {
      return send(200, { id: 7, name: 'alpha', path: 'alpha', path_with_namespace: 'acme/alpha', default_branch: 'main', web_url: `${base}/acme/alpha`, http_url_to_repo: '', ssh_url_to_repo: '' });
    }
    if (p === '/api/v4/projects/7/pipelines') {
      const ref = u.searchParams.get('ref');
      return send(200, ref === 'main' ? [{ id: 99, status: 'failed', ref: 'main', sha: 'abc', web_url: `${base}/acme/alpha/-/pipelines/99` }] : []);
    }
    if (p === '/api/v4/projects/7/merge_requests' && req.method === 'GET') {
      const src = u.searchParams.get('source_branch');
      return send(200, created.map(mrJson).filter((m) => m.source_branch === src));
    }
    if (p === '/api/v4/projects/7/merge_requests' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        created.push(JSON.parse(body));
        send(201, mrJson(created[created.length - 1], created.length - 1));
      });
      return;
    }
    if (/^\/api\/v4\/projects\/7\/merge_requests\/\d+\/approvals$/.test(p)) return send(200, { approved: false, approvals_left: 1 });
    send(404, { message: '404 Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: base, close: () => server.close(), created, seenAuth, groupProjects };
}

/** A tiny stand-in for the GitHub REST endpoints CANOPY uses (served under /api/v3 like GitHub Enterprise). */
async function startFakeGitHub(zetaRemote: string) {
  const createdPulls: Array<Record<string, unknown>> = [];
  const reruns: string[] = [];
  const seenAuth: string[] = [];
  let notModified = 0;
  let base = '';
  const orgRepos = [
    { id: 30, name: 'zeta', full_name: 'acme/zeta', default_branch: 'main', html_url: '', clone_url: zetaRemote, ssh_url: zetaRemote, size: 12, owner: { login: 'acme' } },
    { id: 31, name: 'empty', full_name: 'acme/empty', default_branch: 'main', html_url: '', clone_url: 'https://x/empty.git', ssh_url: 'git@x:empty.git', size: 0, owner: { login: 'acme' } }
  ];
  const runs = [
    { id: 77, name: 'tests', status: 'completed', conclusion: 'failure', html_url: `/runs/77`, head_sha: 'aaa', head_branch: 'feature/x' },
    { id: 76, name: 'lint', status: 'completed', conclusion: 'success', html_url: `/runs/76`, head_sha: 'aaa', head_branch: 'feature/x' },
    { id: 70, name: 'tests', status: 'completed', conclusion: 'success', html_url: `/runs/70`, head_sha: 'old', head_branch: 'feature/x' }
  ];
  const server = http.createServer((req, res): void => {
    const auth = String(req.headers.authorization ?? '');
    seenAuth.push(auth);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const json = JSON.stringify(body);
      const etag = `"${Buffer.from(json).toString('base64').slice(0, 24)}"`;
      if (req.method === 'GET' && status === 200 && req.headers['if-none-match'] === etag) {
        notModified++;
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json', ...(req.method === 'GET' ? { etag } : {}), ...headers });
      res.end(json);
    };
    if (auth !== 'Bearer gh-token') return send(401, { message: 'Bad credentials' });
    const u = new URL(req.url!, base);
    const p = u.pathname.replace(/^\/api\/v3/, '');
    if (p === '/user') return send(200, { login: 'octo', name: 'Octo' }, { 'x-oauth-scopes': 'repo, read:org' });
    if (p === '/repos/acme/beta') return send(200, { id: 9, name: 'beta', full_name: 'acme/beta', default_branch: 'main', html_url: `${base}/acme/beta`, clone_url: '', ssh_url: '', owner: { login: 'acme' } });
    if (p === '/repos/acme/beta/actions/runs') return send(200, { total_count: runs.length, workflow_runs: u.searchParams.get('branch') === 'feature/x' ? runs : [] });
    if (p === '/repos/acme/beta/pulls' && req.method === 'GET') {
      const head = u.searchParams.get('head');
      return send(200, createdPulls.filter((x) => `acme:${x.head}` === head).map((x, i) => ({ number: i + 1, title: x.title, html_url: `${base}/acme/beta/pull/${i + 1}`, draft: x.draft, base: { ref: x.base }, head: { ref: x.head } })));
    }
    if (p === '/repos/acme/beta/pulls' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const x = JSON.parse(body);
        createdPulls.push(x);
        send(201, { number: createdPulls.length, title: x.title, html_url: `${base}/acme/beta/pull/${createdPulls.length}`, draft: x.draft, base: { ref: x.base }, head: { ref: x.head } });
      });
      return;
    }
    const pull = /^\/repos\/acme\/beta\/pulls\/(\d+)$/.exec(p);
    if (pull) {
      const x = createdPulls[Number(pull[1]) - 1];
      return send(200, { number: Number(pull[1]), title: x.title, html_url: '', draft: x.draft, base: { ref: x.base }, head: { ref: x.head }, mergeable: true, mergeable_state: 'clean' });
    }
    if (/^\/repos\/acme\/beta\/pulls\/\d+\/reviews$/.test(p)) return send(200, [{ user: { login: 'sam' }, state: 'COMMENTED' }, { user: { login: 'mei' }, state: 'APPROVED' }]);
    const rerun = /^\/repos\/acme\/beta\/actions\/runs\/(\d+)\/(rerun-failed-jobs|rerun)$/.exec(p);
    if (rerun && req.method === 'POST') {
      reruns.push(`${rerun[1]}:${rerun[2]}`);
      return send(201, {});
    }
    if (p === '/user/orgs') return send(200, [{ login: 'acme' }]);
    if (p === '/orgs/acme/repos') return send(200, orgRepos);
    send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    host: `127.0.0.1:${port}`,
    close: () => server.close(),
    createdPulls,
    reruns,
    seenAuth,
    orgRepos,
    get notModified() {
      return notModified;
    }
  };
}

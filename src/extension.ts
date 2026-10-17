import * as vscode from 'vscode';
import { GitOps } from './commands/gitOps';
import { registerCommands } from './commands/register';
import { GitRunner } from './git/runner';
import { registerGitContent } from './gitContent';
import { Log } from './log';
import { RepoManager } from './manager';
import { DetailPanel } from './panels/detailPanel';
import { ProfilesPanel } from './panels/profilesPanel';
import { Profiles } from './profiles';
import { StatusBar } from './statusBar';
import { Store, ViewState } from './store';
import { RepoTree } from './tree';
import { GitLabService } from './forge/gitlab';
import { GitHubService } from './forge/github';
import { ForgeHub } from './forge/hub';

function gitPath(): string {
  const own = vscode.workspace.getConfiguration('canopy').get<string>('gitPath', '').trim();
  if (own) return own;
  const builtin = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  if (typeof builtin === 'string' && builtin.trim()) return builtin.trim();
  if (Array.isArray(builtin) && builtin.length && builtin[0]) return builtin[0];
  return 'git';
}

/** Returned from activate(); used by the end-to-end tests. */
export interface CanopyApi {
  manager: RepoManager;
  tree: RepoTree;
  store: Store;
  ops: GitOps;
  profiles: Profiles;
  detail: DetailPanel;
  profilesPanel: ProfilesPanel;
  gitlab: GitLabService;
  github: GitHubService;
  forge: ForgeHub;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<CanopyApi> {
  const log = new Log();
  const cfg = vscode.workspace.getConfiguration('canopy');
  const runner = new GitRunner(gitPath(), cfg.get<number>('maxConcurrentGit', 6), (line) => log.git(line));
  const store = new Store(ctx);
  const state = new ViewState(ctx.workspaceState);
  const manager = new RepoManager(runner, store, log);
  const tree = new RepoTree(manager, store, state);
  manager.visibleForAutoFetch = () => tree.visibleRepos();
  const ops = new GitOps(manager, log);
  const detail = new DetailPanel(ctx.extensionUri, manager, ops, tree, log);
  detail.version = `v${String(ctx.extension.packageJSON.version)}${ctx.extensionMode === vscode.ExtensionMode.Development ? ' (dev)' : ''}`;
  const profiles = new Profiles(ctx, store, manager, tree, log);
  const profilesPanel = new ProfilesPanel(ctx.extensionUri, profiles, store, log);
  detail.profiles = profilesPanel;
  const statusBar = new StatusBar(manager, tree, store);
  const gitlab = new GitLabService(ctx, manager, store, ops, log);
  const github = new GitHubService(ctx, manager, store, ops, log);
  for (const svc of [gitlab, github]) {
    svc.profiles = profiles;
    svc.profilesPanel = profilesPanel;
    svc.visibleRepos = () => tree.visibleRepos();
  }
  const forge = new ForgeHub([gitlab, github]);
  tree.forge = forge;
  detail.forge = forge;

  void vscode.commands.executeCommand('setContext', 'canopy.editMode', false);

  ctx.subscriptions.push(
    log,
    store,
    state,
    manager,
    tree,
    detail,
    profilesPanel,
    statusBar,
    gitlab,
    github,
    forge,
    registerGitContent(manager),
    ...registerCommands({ ctx, manager, store, state, tree, ops, detail, profiles, profilesPanel, forge, log }),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        const p = await profiles.profileFromUri(uri);
        if (p) await profilesPanel.show(p, 'import');
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('canopy.gitPath') || e.affectsConfiguration('git.path')) runner.setGitPath(gitPath());
      if (e.affectsConfiguration('canopy.maxConcurrentGit')) runner.setMaxConcurrent(vscode.workspace.getConfiguration('canopy').get<number>('maxConcurrentGit', 6));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => manager.rekey())
  );

  try {
    await runner.run(['--version'], { cwd: process.cwd(), readOnly: true });
  } catch {
    void vscode.window.showErrorMessage(`CANOPY could not run Git ("${gitPath()}"). Install Git or set canopy.gitPath.`, 'Open Settings').then((a) => {
      if (a) void vscode.commands.executeCommand('workbench.action.openSettings', 'canopy.gitPath');
    });
    return { manager, tree, store, ops, profiles, detail, profilesPanel, gitlab, github, forge };
  }
  void manager.discover();
  if (!ctx.globalState.get('canopy.welcomed') && ctx.extensionMode !== vscode.ExtensionMode.Test) {
    void ctx.globalState.update('canopy.welcomed', true);
    void vscode.commands.executeCommand('workbench.action.openWalkthrough', `${ctx.extension.id}#canopy.getStarted`, false);
  }
  return { manager, tree, store, ops, profiles, detail, profilesPanel, gitlab, github, forge };
}

export function deactivate(): void {}

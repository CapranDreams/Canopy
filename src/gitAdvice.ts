import * as vscode from 'vscode';
import { Log } from './log';
import { RepoManager } from './manager';
import { countAutoDetected } from './util/autoDetect';

/** From this many auto-opened repositories on, VS Code's own Git does most of the git work on the machine. */
const THRESHOLD = 15;
const NEVER_KEY = 'canopy.gitAdvice.never';
const ASKED_KEY = 'canopy.gitAdvice.asked';

/**
 * Offers once per workspace to let VS Code's Git follow only the repositories of open files. Measured with 90
 * repositories (npm run bench): startup 12.4 s → 5.3 s, 650 → 20 git processes for 20 saves. Changes nothing
 * unless the user clicks, and never asks when they already chose a value for the setting.
 */
export async function maybeSuggestOpenEditors(ctx: vscode.ExtensionContext, manager: RepoManager, log: Log): Promise<void> {
  if (ctx.extensionMode === vscode.ExtensionMode.Test) return;
  if (ctx.globalState.get<boolean>(NEVER_KEY) || ctx.workspaceState.get<boolean>(ASKED_KEY)) return;
  const git = vscode.workspace.getConfiguration('git');
  if (git.get<boolean>('enabled', true) === false) return;
  const detection = git.inspect<boolean | string>('autoRepositoryDetection');
  if (detection && [detection.globalValue, detection.workspaceValue, detection.workspaceFolderValue].some((v) => v !== undefined)) return;
  if ((detection?.defaultValue ?? true) !== true) return;
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  const roots = manager.all.filter((r) => !r.declaredBy).map((r) => r.root);
  const count = countAutoDetected(roots, folders, git.get<number>('repositoryScanMaxDepth', 1));
  if (count < THRESHOLD) return;
  await ctx.workspaceState.update(ASKED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    `VS Code's own Git is following ${count} repositories in this workspace and re-reads them on every file change, which is most of the git work on your machine. Let it follow only the repositories of files you have open? CANOPY keeps showing all of them. (Measured with 90 repositories: startup 12.4 s → 5.3 s.)`,
    'Switch for This Workspace',
    'Not Now',
    "Don't Ask Again"
  );
  if (choice === 'Switch for This Workspace') {
    await git.update('autoRepositoryDetection', 'openEditors', vscode.ConfigurationTarget.Workspace);
    log.info(`Set git.autoRepositoryDetection to "openEditors" for this workspace (${count} repositories were auto-opened by VS Code's Git).`);
    void vscode.window.showInformationMessage('Done. VS Code\'s Git now follows the repositories of open files; reload the window to release the others.', 'Reload Window').then((a) => {
      if (a) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  } else if (choice === "Don't Ask Again") {
    await ctx.globalState.update(NEVER_KEY, true);
  }
}

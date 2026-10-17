import * as vscode from 'vscode';
import { RepoManager } from './manager';
import { Store } from './store';
import { RepoTree } from './tree';

/** Totals across visible repos, plus the active profile. */
export class StatusBar implements vscode.Disposable {
  private readonly totals = vscode.window.createStatusBarItem('canopy.totals', vscode.StatusBarAlignment.Left, 50);
  private readonly profile = vscode.window.createStatusBarItem('canopy.profile', vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly manager: RepoManager,
    private readonly tree: RepoTree,
    private readonly store: Store
  ) {
    this.totals.name = 'CANOPY repositories';
    this.totals.command = 'workbench.view.extension.canopy';
    this.profile.name = 'CANOPY profile';
    this.profile.command = 'canopy.switchProfile';
    this.disposables.push(
      this.totals,
      this.profile,
      manager.onDidChange(() => this.schedule()),
      manager.onDidChangeFetching(() => this.schedule()),
      store.onDidChangeLayout(() => this.schedule()),
      store.onDidChangeProfiles(() => this.schedule())
    );
    this.update();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.update();
    }, 150);
  }

  private update(): void {
    const repos = this.tree.visibleRepos();
    if (!this.manager.all.length) {
      this.totals.hide();
    } else {
      const sum = (f: (r: (typeof repos)[number]) => number) => repos.reduce((n, r) => n + f(r), 0);
      const behind = sum((r) => r.behind);
      const changed = sum((r) => r.changed);
      const ahead = sum((r) => r.ahead);
      const conflicts = repos.filter((r) => r.conflicts.length || r.operation).length;
      const spin = this.manager.fetchingCount > 0;
      this.totals.text = `${spin ? '$(sync~spin)' : '$(repo)'} ${conflicts ? `$(warning)${conflicts} ` : ''}↓${behind} ●${changed} ↑${ahead}`;
      this.totals.tooltip = new vscode.MarkdownString(
        `**CANOPY** · ${repos.length} repositories${spin ? ` · fetching ${this.manager.fetchingCount}` : ''}\n\n` +
          `- ${behind} incoming commits\n- ${changed} changed files\n- ${ahead} unpushed commits${conflicts ? `\n- ${conflicts} repositories with conflicts or an operation in progress` : ''}`
      );
      this.totals.backgroundColor = conflicts ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      this.totals.show();
    }
    const name = this.store.activeProfileId ? this.store.activeProfileName ?? this.store.profiles.find((x) => x.id === this.store.activeProfileId)?.name : undefined;
    if (name) {
      this.profile.text = `$(layers) ${name}`;
      this.profile.tooltip = `CANOPY profile: ${name} (click to switch)`;
      this.profile.show();
    } else if (this.store.profiles.length) {
      this.profile.text = '$(layers)';
      this.profile.tooltip = 'Switch CANOPY profile';
      this.profile.show();
    } else {
      this.profile.hide();
    }
  }
}

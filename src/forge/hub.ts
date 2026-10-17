import * as vscode from 'vscode';
import type { Repo } from '../repo';
import { ForgeInfo, ForgeKind, ForgeProvider, ForgeState } from './types';

/** Routes each repository to the service (GitLab or GitHub) that hosts its remote. */
export class ForgeHub implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Repo | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChange];

  constructor(readonly providers: readonly ForgeProvider[]) {
    for (const p of providers) this.disposables.push(p.onDidChange((r) => this._onDidChange.fire(r)));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  get(kind: ForgeKind): ForgeProvider {
    return this.providers.find((p) => p.kind === kind)!;
  }

  /** The service for a repo: one it is connected to first, then one that recognizes its remote. */
  providerFor(repo: Repo): ForgeProvider | undefined {
    let fallback: ForgeProvider | undefined;
    for (const p of this.providers) {
      const s = p.state(repo);
      if (s.kind === 'connected') return p;
      if (s.kind === 'disconnected' && !fallback) fallback = p;
    }
    return fallback;
  }

  state(repo: Repo): ForgeState {
    return this.providerFor(repo)?.state(repo) ?? { kind: 'none' };
  }

  info(repo: Repo): ForgeInfo | undefined {
    return this.providerFor(repo)?.info(repo);
  }

  async refresh(repo: Repo): Promise<ForgeInfo | undefined> {
    return this.providerFor(repo)?.refresh(repo);
  }

  refreshVisible(force: boolean): void {
    for (const p of this.providers) p.refreshVisible(force);
  }
}

import type * as vscode from 'vscode';
import type { Repo } from '../repo';

export type ForgeKind = 'gitlab' | 'github';

/** Hosted-Git status for one repository (GitLab pipeline + MR, or GitHub checks + PR). */
export interface ForgeInfo {
  provider: ForgeKind;
  instanceUrl: string;
  host: string;
  /** group/subgroup/project on GitLab, owner/repo on GitHub. */
  projectPath: string;
  remoteName: string;
  project?: { id: number; webUrl: string; defaultBranch: string | null };
  /** GitLab pipeline, or the GitHub Actions runs for the newest commit on the branch. */
  pipeline?: { id: number; status: string; sha: string; webUrl: string; ref: string; isHead: boolean };
  /** GitLab merge request (iid) or GitHub pull request (number). */
  mr?: {
    iid: number;
    title: string;
    webUrl: string;
    draft: boolean;
    hasConflicts: boolean;
    status: string;
    targetBranch: string;
    approved?: boolean;
    approvalsLeft?: number;
    approvedBy?: string[];
    changesRequested?: boolean;
  };
  error?: string;
  fetchedAt: number;
  stateKey: string;
}

/** What the UI shows for a repo's hosted-Git state. */
export type ForgeState =
  | { kind: 'none' }
  | { kind: 'disconnected'; provider: ForgeKind; host: string }
  | { kind: 'connected'; provider: ForgeKind; info: ForgeInfo | undefined; readOnly: boolean };

/** Common surface of the GitLab and GitHub services. */
export interface ForgeProvider extends vscode.Disposable {
  readonly kind: ForgeKind;
  readonly label: string;
  readonly onDidChange: vscode.Event<Repo | undefined>;
  state(repo: Repo): ForgeState;
  info(repo: Repo): ForgeInfo | undefined;
  refresh(repo: Repo): Promise<ForgeInfo | undefined>;
  refreshVisible(force: boolean): void;
  connect(hint?: string): Promise<boolean>;
  disconnect(): Promise<void>;
  createRequest(repo: Repo): Promise<void>;
  openRequest(repo: Repo): Promise<void>;
  openPipeline(repo: Repo): Promise<void>;
  retryPipeline(repo: Repo): Promise<void>;
  openProject(repo: Repo): Promise<void>;
  cloneFromGroup(mode: 'clone' | 'profile'): Promise<void>;
}

/** Wording that differs between the two services. */
export const FORGE_WORDS: Record<ForgeKind, { name: string; request: string; requestShort: string; prefix: string; pipeline: string; group: string }> = {
  gitlab: { name: 'GitLab', request: 'merge request', requestShort: 'MR', prefix: '!', pipeline: 'pipeline', group: 'group' },
  github: { name: 'GitHub', request: 'pull request', requestShort: 'PR', prefix: '#', pipeline: 'checks', group: 'organization' }
};

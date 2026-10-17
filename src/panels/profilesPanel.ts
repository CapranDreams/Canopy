import * as vscode from 'vscode';
import { Log } from '../log';
import { Profile, ProfileValidationError, toProfileFile } from '../model/profile';
import { EditorModel, PROFILE_FILE_GLOB, ProfileEntry, Profiles } from '../profiles';
import { Store } from '../store';
import { timeAgo } from '../tree';
import { webviewHtml } from './webviewUtil';
import { branchColors } from '../branchColors';

/** The Profiles editor tab: saved profiles on the left, an editable repo/branch table on the right. */
export class ProfilesPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private editor: EditorModel | undefined;
  lastRenderRows: number | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly profiles: Profiles,
    private readonly store: Store,
    private readonly log: Log
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(PROFILE_FILE_GLOB);
    const changed = () => store.notifyProfilesChanged();
    this.disposables.push(store.onDidChangeProfiles(() => void this.postState()), watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed), vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('canopy.branchColors')) void this.postState();
    }));
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  /** Opens the panel. With a profile, loads it into the editor (imported profiles are marked for review). */
  async show(profile?: Profile, source: 'profile' | 'import' = 'profile'): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('canopy.profiles', 'CANOPY · Profiles', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'canopy.svg');
      this.panel.webview.html = webviewHtml(this.panel.webview, this.extensionUri, 'profiles.js', 'CANOPY Profiles');
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.fail(e)), undefined, this.disposables);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.editor = undefined;
      }, undefined, this.disposables);
    } else {
      this.panel.reveal();
    }
    if (profile) this.editor = await this.profiles.editorFromProfile(profile, source);
    else if (!this.editor) this.editor = await this.profiles.editorFromCurrent();
    await this.postState();
    if (source === 'import' && profile) {
      void vscode.window.showInformationMessage(`Review "${profile.name}", choose where to clone, then Preview & Switch. Nothing runs until you confirm.`);
    }
  }

  private async postState(): Promise<void> {
    if (!this.panel) return;
    const active = this.profiles.activeId;
    const entries = await this.profiles.listAll();
    void this.panel.webview.postMessage({
      type: 'state',
      settingsLocation: this.profiles.settingsLocation(),
      colors: branchColors(),
      profiles: entries.map((e) => ({
        id: e.profile.id,
        name: e.profile.name,
        mode: e.profile.mode,
        count: e.profile.repos.length,
        createdBy: e.profile.createdBy,
        saved: e.profile.savedAt ? timeAgo(Date.parse(e.profile.savedAt)) : '',
        active: e.profile.id === active,
        source: e.source,
        location: e.location
      })),
      editor: this.editor,
      preview: this.editor ? this.previewJson(this.editor) : ''
    });
  }

  private previewJson(m: EditorModel): string {
    try {
      return JSON.stringify(toProfileFile(this.profiles.profileFromEditor(m)), null, 2);
    } catch (e) {
      return `// ${(e as Error).message}`;
    }
  }

  private fail(e: unknown): void {
    const msg = e instanceof ProfileValidationError ? e.message : String((e as Error)?.message ?? e);
    this.log.error(`Profiles: ${msg}`);
    void vscode.window.showErrorMessage(`CANOPY profile: ${msg}`);
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    if (m.type === 'rendered') {
      this.lastRenderRows = Number(m.rows);
      return;
    }
    if (m.type === 'error') return this.log.error(`Profiles view script error: ${String(m.message)}`);
    if (m.editor) this.editor = m.editor as EditorModel;
    switch (m.type) {
      case 'ready':
        return this.postState();
      case 'edit':
        // Keep the JSON preview current while the user edits.
        return void this.panel?.webview.postMessage({ type: 'preview', preview: this.editor ? this.previewJson(this.editor) : '' });
      case 'newFromCurrent':
        this.editor = await this.profiles.editorFromCurrent();
        return this.postState();
      case 'load': {
        const e = await this.profiles.find(String(m.id));
        if (e) this.editor = await this.profiles.editorFromProfile(e.profile, 'profile', e.uri?.toString());
        return this.postState();
      }
      case 'delete':
        return this.delete(String(m.id));
      case 'save':
        return this.save(false);
      case 'saveAsFile':
        return this.save(true);
      case 'export':
        return this.profiles.exportToFile(await this.targetProfile(m.id));
      case 'copyLink':
        return this.profiles.copyShareLink(await this.targetProfile(m.id));
      case 'import': {
        const p = await this.profiles.importFromFile();
        if (p) {
          this.editor = await this.profiles.editorFromProfile(p, 'import');
          await this.postState();
        }
        return;
      }
      case 'browseBase': {
        const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(this.requireEditor().baseFolder), openLabel: 'Use as Base Folder' });
        if (uris?.length) this.editor = { ...this.requireEditor(), baseFolder: uris[0].fsPath };
        return this.postState();
      }
      case 'preview': {
        const p = m.id ? await this.targetProfile(m.id) : this.profiles.profileFromEditor(this.requireEditor());
        const base = m.id ? this.profiles.defaultBaseFolder() : this.requireEditor().baseFolder;
        const { steps, summary } = this.profiles.plan(p, base);
        return void this.panel?.webview.postMessage({
          type: 'plan',
          id: m.id ?? null,
          name: p.name,
          summary,
          baseFolder: base,
          steps: steps.map((s) => ({ kind: s.kind, repo: s.entry.name, detail: s.detail })),
          work: steps.filter((s) => !['ok', 'skip', 'blocked'].includes(s.kind)).length
        });
      }
      case 'apply': {
        const p = m.id ? await this.targetProfile(m.id) : this.profiles.profileFromEditor(this.requireEditor());
        const base = m.id ? this.profiles.defaultBaseFolder() : this.requireEditor().baseFolder;
        await this.profiles.apply(p, base);
        if (!m.id && this.editor) this.editor = await this.profiles.editorFromProfile(p, this.editor.id ? 'profile' : 'import', this.editor.fileUri);
        return this.postState();
      }
    }
  }

  /**
   * Saves the editor. A profile loaded from a file is written back to that file, one saved in the
   * workspace is updated there, and a new one asks where to go (or goes to a file with asFile).
   */
  private async save(asFile: boolean): Promise<void> {
    const ed = this.requireEditor();
    const profile = this.profiles.profileFromEditor(ed);
    let target: 'workspace' | 'file' | undefined = asFile ? 'file' : ed.fileUri ? 'file' : ed.id && !ed.id.startsWith('file:') ? 'workspace' : undefined;
    if (!target) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(settings-gear) Save in this workspace', description: this.profiles.settingsLocation(), detail: 'Saved with the workspace settings. Only people who open this workspace see it.', t: 'workspace' as const },
          { label: '$(file) Save as a file in the project', description: '*.canopy-profile.json', detail: 'A file you can commit, email or attach. Profile files anywhere in the workspace are listed automatically.', t: 'file' as const }
        ],
        { title: `Save profile "${profile.name}"`, placeHolder: 'Where should this profile be saved?' }
      );
      if (!pick) return;
      target = pick.t;
    }
    if (target === 'workspace') {
      const saved = await this.profiles.save(profile);
      this.editor = { ...ed, id: saved.id, fileUri: undefined, source: 'profile' };
      void vscode.window.showInformationMessage(`Saved profile "${saved.name}" in ${this.profiles.settingsLocation()}.`);
    } else {
      const existing = !asFile && ed.fileUri ? vscode.Uri.parse(ed.fileUri) : undefined;
      const uri = await this.profiles.saveToFile(profile, existing);
      if (!uri) return;
      this.editor = { ...ed, id: 'file:' + uri.toString(), fileUri: uri.toString(), source: 'profile' };
      const inWorkspace = !!vscode.workspace.getWorkspaceFolder(uri);
      void vscode.window.showInformationMessage(
        `Saved profile "${profile.name}" to ${vscode.workspace.asRelativePath(uri, true)}.${inWorkspace ? '' : ' It is outside the workspace, so it will not appear in the Saved list; use Import Profile… to open it later.'}`
      );
    }
    this.store.notifyProfilesChanged();
  }

  private async delete(id: string): Promise<void> {
    const e = await this.profiles.find(id);
    if (!e) return;
    if (e.source === 'file' && e.uri) {
      const ok = await vscode.window.showWarningMessage(`Delete the profile file ${e.location}?`, { modal: true, detail: 'The file is moved to the recycle bin. Repositories on disk are not touched.' }, 'Delete File');
      if (!ok) return;
      await vscode.workspace.fs.delete(e.uri, { useTrash: true });
    } else {
      const ok = await vscode.window.showWarningMessage(`Delete the profile "${e.profile.name}"?`, { modal: true, detail: 'Repositories on disk are not touched.' }, 'Delete');
      if (!ok) return;
      await this.profiles.remove(e.profile.id);
    }
    if (this.editor?.id === id) this.editor = { ...this.editor, id: null, fileUri: undefined, source: 'import' };
    this.store.notifyProfilesChanged();
  }

  private requireEditor(): EditorModel {
    if (!this.editor) throw new Error('No profile is open.');
    return this.editor;
  }

  private async targetProfile(id: unknown): Promise<Profile> {
    if (typeof id === 'string' && id) {
      const e: ProfileEntry | undefined = await this.profiles.find(id);
      if (e) return e.profile;
    }
    return this.profiles.profileFromEditor(this.requireEditor());
  }
}

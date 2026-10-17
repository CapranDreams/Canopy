// @ts-check
/* CANOPY profiles panel. The editor model lives here while editing and is sent back with every action. */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  let profiles = [];
  /** @type {any} */
  let editor = null;
  let preview = '';
  /** @type {any} */
  let plan = null;
  let busy = false;
  let settingsLocation = 'workspace settings';
  let specialNames = ['main'];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const post = (type, extra = {}) => vscode.postMessage({ type, editor, ...extra });

  const APPLY_OPTS = [
    ['cloneMissing', 'Clone repositories that are missing'],
    ['stashChanges', 'Stash local changes before switching'],
    ['pullAfter', 'Pull after checkout'],
    ['recreateLayout', 'Recreate the folder layout in the sidebar']
  ];

  function render() {
    if (!editor) {
      app.className = 'loading';
      app.textContent = 'Loading…';
      return;
    }
    const focusId = document.activeElement?.id;
    const included = editor.rows.filter((r) => r.include).length;
    const selectable = editor.rows.filter((r) => !!r.remote).length;
    const sourceText =
      editor.source === 'current'
        ? `Pre-filled with the ${editor.rows.length} visible repositories and their current branches. Hidden repositories are left out.`
        : editor.source === 'import'
          ? 'Imported profile: review the repositories and branches, choose where to clone, then Preview & Switch. Nothing runs until you confirm.'
          : `Editing the saved profile “${esc(editor.name)}”. Visible repositories that are not in it are unchecked.`;
    app.className = '';
    app.innerHTML = `<div class="page">
      <div class="crumb">CANOPY  /  Profiles</div>
      <div class="title"><h1>Clone &amp; switch profiles</h1></div>
      <div class="meta">A profile records which repositories, remotes and branches belong together. Switch your workspace to a profile in one step, or send it to a teammate so CANOPY clones everything at the right branch.</div>
      <div class="toolbar">
        <button class="btn" data-act="import">Import Profile…</button>
        <button class="btn" data-act="newFromCurrent">New from Current State</button>
      </div>
      <div class="profiles">
        <section class="plist" aria-label="Saved profiles">
          <div class="sec-h">Saved profiles <span class="count">${profiles.length}</span></div>
          ${profiles.length ? profiles.map(card).join('') : `<div class="empty">No saved profiles yet.<br><br><b>Save Profile</b> asks whether to keep the profile in this workspace (${esc(settingsLocation)}) or as a <span class="mono">.canopy-profile.json</span> file in your project. Profile files anywhere in the workspace show up here automatically.</div>`}
        </section>
        <section class="card editor" aria-label="Profile editor">
          <div class="fields">
            <label class="field"><span>Profile name</span><input class="text" id="pname" value="${esc(editor.name)}"></label>
            <div class="field"><span>Branch mode</span>
              <div class="seg" role="group" aria-label="Branch mode">
                <button class="${editor.mode === 'track' ? 'on' : ''}" data-mode="track" aria-pressed="${editor.mode === 'track'}">Track branch tips</button>
                <button class="${editor.mode === 'pin' ? 'on' : ''}" data-mode="pin" aria-pressed="${editor.mode === 'pin'}">Pin exact commits</button>
              </div></div>
            <label class="field"><span>Clone new repos into</span>
              <span class="fields"><input class="text mono" id="base" value="${esc(editor.baseFolder)}" size="34"><button class="btn small" data-act="browseBase">Browse…</button></span></label>
          </div>
          <div class="info"><span class="spacer">${sourceText}</span>${editor.source === 'current' ? '' : '<button class="btn small" data-act="newFromCurrent">Refresh from Sidebar</button>'}</div>
          <div class="actions-bar">
            <button class="btn primary" data-act="save" title="${editor.fileUri ? 'Save back to the profile file' : editor.id ? 'Save the changes to this workspace profile' : 'Choose: this workspace or a file in the project'}">Save Profile</button>
            <button class="btn" data-act="saveAsFile">Save as File…</button>
            <button class="btn" data-act="preview" ${busy ? 'disabled' : ''}>Preview &amp; Switch…</button>
            <button class="btn" data-act="export">Export…</button>
            <button class="btn" data-act="copyLink">Copy Share Link</button>
            <span class="muted spacer-left">${editor.fileUri ? 'Saving to the profile file' : editor.id ? 'Saved in ' + esc(settingsLocation) : 'Not saved yet'}</span>
          </div>
          <fieldset class="checks" aria-label="When switching to this profile">
            <legend>When switching to this profile</legend>
            ${APPLY_OPTS.map(([k, label]) => `<label><input type="checkbox" data-opt="${k}" ${editor.onApply[k] ? 'checked' : ''}>${esc(label)}</label>`).join('')}
          </fieldset>
          <div class="select-bar">
            <button class="btn small" data-act="selectAll" ${selectable === included ? 'disabled' : ''}>Select all</button>
            <button class="btn small" data-act="selectNone" ${included ? '' : 'disabled'}>Select none</button>
            <span class="muted">${included} of ${editor.rows.length} repositories included${selectable < editor.rows.length ? ` · ${editor.rows.length - selectable} without a remote cannot be included` : ''}</span>
            <span class="spacer"></span>
            <span class="legend"><span class="branch-main">${esc(specialNames.join(', ') || 'main')}</span> · <span class="branch-other">other branches</span></span>
          </div>
          <div class="table" role="table" aria-label="Repositories in this profile">
            <div class="trow head" role="row">
              <input type="checkbox" id="all" ${included && included === selectable ? 'checked' : ''} aria-label="Select all repositories" title="Select all / none">
              <span role="columnheader">Repository</span><span role="columnheader">Branch</span><span role="columnheader">Clone into</span><span role="columnheader">Remote</span>
            </div>
            ${editor.rows.map(row).join('')}
          </div>
          <details class="json"><summary>Exported file preview</summary><pre id="json">${esc(preview)}</pre></details>
        </section>
      </div>
    </div>
    ${plan ? planModal() : ''}`;
    if (focusId) document.getElementById(focusId)?.focus();
    const all = /** @type {HTMLInputElement|null} */ (document.getElementById('all'));
    if (all) all.indeterminate = included > 0 && included < selectable;
    vscode.postMessage({ type: 'rendered', rows: editor.rows.length });
  }

  function card(p) {
    const sel = editor && editor.id === p.id;
    return `<div class="card pcard${sel ? ' sel' : ''}">
      <button class="pname" data-load="${esc(p.id)}">${esc(p.name)}${p.active ? ' <span class="pill">active</span>' : ''}</button>
      <span class="muted">${p.count} repos · ${p.mode === 'pin' ? 'pinned commits' : 'tracks branches'}${p.createdBy ? ' · from ' + esc(p.createdBy) : ''}${p.saved ? ' · saved ' + esc(p.saved) : ''}</span>
      <span class="where" title="${esc(p.location)}">${p.source === 'file' ? 'file: ' : 'workspace: '}<span class="mono">${esc(p.location)}</span></span>
      <span class="fields">
        <button class="btn small primary" data-switch="${esc(p.id)}">Switch…</button>
        <button class="btn small" data-export="${esc(p.id)}">Export</button>
        <button class="btn small" data-link="${esc(p.id)}">Copy Link</button>
        <button class="icon-btn danger" data-delete="${esc(p.id)}" aria-label="Delete ${esc(p.name)}" title="${p.source === 'file' ? 'Delete file' : 'Delete'}">✕</button>
      </span>
    </div>`;
  }

  function row(r, i) {
    const noRemote = !r.remote;
    const branchClass = (b) => (specialNames.includes(b) ? 'branch-main' : 'branch-other');
    const options = [...new Set([r.branch, ...(r.branches || [])])].map((b) => `<option class="${branchClass(b)}" ${b === r.branch ? 'selected' : ''}>${esc(b)}</option>`).join('');
    return `<div class="trow${r.include ? '' : ' off'}" role="row">
      <input type="checkbox" data-row="${i}" ${r.include ? 'checked' : ''} ${noRemote ? 'disabled' : ''} aria-label="Include ${esc(r.name)}">
      <span class="cell" title="${esc(r.localRoot || 'not cloned here')}">${esc(r.name)} <span class="muted">${r.localRoot ? esc(r.folder || '') : 'not cloned'}</span></span>
      <select class="${branchClass(r.branch)}" data-branch="${i}" aria-label="Branch for ${esc(r.name)}">${options}</select>
      <input class="text" data-path="${i}" value="${esc(r.path)}" aria-label="Clone path for ${esc(r.name)}">
      <span class="cell mono muted" title="${esc(r.remote)}">${noRemote ? 'no remote, cannot be shared' : esc(r.remote)}</span>
    </div>`;
  }

  function planModal() {
    return `<div class="modal-bg"><div class="modal" role="dialog" aria-label="Switch plan">
      <h2>Switch to “${esc(plan.name)}”?</h2>
      <span class="muted">${esc(plan.summary)} · base folder <span class="mono">${esc(plan.baseFolder)}</span></span>
      <div class="steps">${plan.steps.map((s) => `<div class="step"><span class="kind k-${esc(s.kind)}">${esc(s.kind === 'stash-switch' ? 'STASH' : s.kind.toUpperCase())}</span><span class="repo">${esc(s.repo)}</span><span class="detail" title="${esc(s.detail)}">${esc(s.detail)}</span></div>`).join('')}</div>
      <div class="actions"><button class="btn" data-act="cancelPlan">Cancel</button><button class="btn primary" data-act="runPlan" ${plan.work ? '' : 'disabled'}>${plan.work ? `Run ${plan.work} step${plan.work === 1 ? '' : 's'}` : 'Nothing to do'}</button></div>
    </div></div>`;
  }

  let editTimer;
  function edited() {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => post('edit'), 250);
  }

  app.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.mode) {
      editor.mode = d.mode;
      render();
      edited();
    } else if (d.load) post('load', { id: d.load });
    else if (d.switch) post('preview', { id: d.switch });
    else if (d.export) post('export', { id: d.export });
    else if (d.link) post('copyLink', { id: d.link });
    else if (d.delete) post('delete', { id: d.delete });
    else if (d.act === 'cancelPlan') {
      plan = null;
      render();
    } else if (d.act === 'runPlan') {
      const id = plan.id;
      plan = null;
      busy = true;
      render();
      post('apply', { id });
    } else if (d.act === 'selectAll' || d.act === 'selectNone') {
      editor.rows.forEach((r) => (r.include = d.act === 'selectAll' && !!r.remote));
      render();
      edited();
    } else if (d.act) post(d.act);
  });

  app.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    const d = t.dataset;
    if (t.id === 'all') editor.rows.forEach((r) => (r.include = t.checked && !!r.remote));
    else if (d.row !== undefined) editor.rows[+d.row].include = t.checked;
    else if (d.branch !== undefined) editor.rows[+d.branch].branch = t.value;
    else if (d.opt) editor.onApply[d.opt] = t.checked;
    else return;
    render();
    edited();
  });

  app.addEventListener('input', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id === 'pname') editor.name = t.value;
    else if (t.id === 'base') editor.baseFolder = t.value;
    else if (t.dataset.path !== undefined) editor.rows[+t.dataset.path].path = t.value;
    else return;
    edited();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && plan) {
      plan = null;
      render();
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      profiles = m.profiles;
      settingsLocation = m.settingsLocation || settingsLocation;
      if (m.colors) {
        specialNames = m.colors.specialNames;
        document.documentElement.style.setProperty('--branch-special', m.colors.special);
        document.documentElement.style.setProperty('--branch-other-color', m.colors.other);
      }
      editor = m.editor;
      preview = m.preview;
      busy = false;
      render();
    } else if (m.type === 'preview') {
      preview = m.preview;
      const pre = document.getElementById('json');
      if (pre) pre.textContent = preview;
    } else if (m.type === 'plan') {
      plan = m;
      render();
    }
  });

  window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: String(e.message) + ' @' + e.lineno }));
  vscode.postMessage({ type: 'ready' });
})();

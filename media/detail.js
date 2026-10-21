// @ts-check
/* CANOPY details panel. Renders state posted by DetailPanel; all actions go back as messages. */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const saved = vscode.getState() || {};
  /** @type {Record<string,string>} */
  const drafts = saved.drafts || {};
  let state = null;
  /** @type {string|null} */
  let openMenu = null;
  /** @type {{sha:string, refs:any[], x:number, y:number}|null} */
  let ctx = null;
  /** Row whose changed files are listed beneath it ('*' for uncommitted changes). */
  let selectedSha = null;
  /** Changed files per commit: an array once loaded, 'loading', or {error}. */
  /** @type {Record<string, any>} */
  let commitFiles = {};
  let revealFiles = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const post = (m) => vscode.postMessage(m);
  /** Graph or Stats in the right-hand card. */
  let view = ['stats', 'profiles'].includes(saved.view) ? saved.view : 'graph';
  const stats = {
    range: ['3m', '1y', 'all'].includes(saved.statsRange) ? saved.statsRange : '1y',
    scope: saved.statsScope === 'folder' ? 'folder' : 'repo',
    sort: 'commits',
    /** Repo root + HEAD the shown data belongs to; a change triggers a refetch. */
    key: '',
    loading: false,
    data: null,
    error: null,
    folder: null,
    owners: null
  };
  /** Measured chart widths, so SVG charts are drawn at their real size. */
  const chartW = {};
  const persist = () => vscode.setState({ drafts, view, statsRange: stats.range, statsScope: stats.scope });

  const ICON = {
    sync: '<path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4"/>',
    pull: '<path d="M12 4v14M6 12l6 6 6-6"/>',
    push: '<path d="M12 20V6M6 12l6-6 6 6"/>',
    fetch: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-7 4-11 8"/>',
    merge: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="17" r="2"/><path d="M6 7v10M6 8c0 6 10 4 11 8"/>',
    rebase: '<path d="M4 7h12l-3-3M20 17H8l3 3"/>',
    stash: '<path d="M4 6h16v4H4zM6 10v9h12v-9M10 14h4"/>',
    prune: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 8.5L20 18M8.5 15.5L20 6"/>',
    more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    discard: '<path d="M4 9h11a5 5 0 0 1 0 10H9"/><path d="M8 5L4 9l4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
    merge3: '<path d="M4 4h6v16H4zM14 4h6v16h-6z"/>',
    gitlab: '<path d="M12 21L3 13l2-9 3 6h8l3-6 2 9z"/>',
    github: '<path d="M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 2.8 5.8 3.1 5.8 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
    mr: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>'
  };
  const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n] || ''}</svg>`;

  /** Menu definitions: [label, command id, danger?] | null (separator) | {h: heading} */
  const MENUS = {
    pull: [['Pull', 'pull'], ['Pull (Rebase)', 'pullRebase'], ['Pull (Fast-Forward Only)', 'pullFfOnly'], ['Pull from…', 'pullFrom'], null, ['Pull (Including Submodules)', 'pullSubmodules']],
    push: [['Push', 'push'], ['Push to…', 'pushTo'], ['Publish Branch', 'publishBranch'], ['Push Tags', 'pushTags'], null, ['Force Push (With Lease)…', 'forcePushWithLease', true], ['Force Push…', 'forcePush', true]],
    fetch: [['Fetch', 'fetch'], ['Fetch (Prune)', 'fetchPrune'], ['Fetch from All Remotes', 'fetchAllRemotes']],
    // Filled in render(): these actions, then every local and remote branch.
    branch: [],
    merge: [['Merge Branch…', 'merge'], ['Merge (No Fast-Forward)…', 'mergeNoFf'], ['Squash Merge…', 'mergeSquash'], { h: 'Merge tools' }, ['Open Conflicts in Merge Editor', 'openConflicts'], ['Open External Merge Tool', 'openMergeTool'], ['Accept All Current…', 'acceptAllCurrent'], ['Accept All Incoming…', 'acceptAllIncoming'], null, ['Continue', 'continueOperation'], ['Abort…', 'abortOperation', true]],
    rebase: [['Rebase onto Upstream', 'rebaseOntoUpstream'], ['Rebase onto…', 'rebaseOnto'], ['Interactive Rebase…', 'rebaseInteractive'], null, ['Continue Rebase', 'continueOperation'], ['Skip Commit', 'skipOperation'], ['Abort Rebase…', 'abortOperation', true]],
    prune: [
      { h: 'Remote branches' }, ['Prune Remote Branches Deleted on Server', 'pruneRemoteBranches'],
      { h: 'Local branches' }, ['Delete Local Branches Gone on Remote…', 'pruneGoneBranches', true], ['Delete Local Branches Already Merged…', 'pruneMergedBranches', true],
      { h: 'All at once' }, ['Clean Up: Prune Remotes, Delete Gone and Merged Locals…', 'pruneAll', true],
      null, ['Prune Stale Worktrees', 'pruneWorktrees']
    ],
    stash: [['Stash', 'stash'], ['Stash (Include Untracked)', 'stashIncludeUntracked'], ['Stash Staged', 'stashStaged'], null, ['View Stashes…', 'stashView'], ['Apply Latest', 'stashApplyLatest'], ['Pop Latest', 'stashPopLatest'], ['Apply…', 'stashApply'], ['Pop…', 'stashPop'], null, ['Drop…', 'stashDrop', true], ['Drop All…', 'stashClear', true]],
    more: [
      { h: 'Commit' }, ['Commit Staged…', 'commit'], ['Commit All…', 'commitAll'], ['Amend Last Commit…', 'commitAmend'], ['Undo Last Commit', 'undoLastCommit'],
      { h: 'Changes' }, ['Stage All', 'stageAll'], ['Unstage All', 'unstageAll'], ['Discard All Changes…', 'discardAll', true], ['Clean Untracked Files…', 'cleanUntracked', true],
      { h: 'History' }, ['Cherry-Pick…', 'cherryPick'], ['Revert Commit…', 'revertCommit'], ['Reset to…', 'resetTo'],
      { h: 'Tags & remotes' }, ['Create Tag…', 'createTag'], ['Delete Tag…', 'deleteTag'], ['Add Remote…', 'addRemote'], ['Remove Remote…', 'removeRemote'],
      { h: 'Worktrees' }, ['Create Worktree…', 'worktreeAdd'], ['Open Worktree…', 'worktreeOpen'], ['Remove Worktree…', 'worktreeRemove'], ['Update Submodules', 'submoduleUpdate'],
      { h: 'Tools' }, ['Open in Terminal', 'openInTerminal'], ['Reveal in File Explorer', 'revealInOS'], ['Open on Remote', 'openOnRemote'], ['Open in New Window', 'openInNewWindow'], ['Show Git Output', 'showOutput']
    ],
    commit: [['Commit', 'c:commit'], ['Commit & Push', 'c:push'], ['Commit & Sync', 'c:sync'], null, ['Commit (Amend)', 'c:amend'], ['Commit (Signed Off)', 'c:signoff'], ['Commit (No Verify)', 'c:noverify', true]]
  };

  function menuHtml(name, extraClass = '') {
    const items = MENUS[name];
    if (name === 'more') {
      // Group into sections for a three-column grid.
      const sections = [];
      for (const it of items) {
        if (it && !Array.isArray(it)) sections.push({ h: it.h, items: [] });
        else if (it) sections[sections.length - 1].items.push(it);
      }
      return `<div class="menu grid right ${extraClass}" role="menu">${sections
        .map((s) => `<div><div class="h">${esc(s.h)}</div>${s.items.map(mi).join('')}</div>`)
        .join('')}</div>`;
    }
    const scroll = name === 'branch' ? ' scroll' : '';
    return `<div class="menu${scroll} ${extraClass}" role="menu">${items.map((it) => (it === null ? '<div class="sep"></div>' : Array.isArray(it) ? mi(it) : it.b ? branchItem(it) : `<div class="h">${esc(it.h)}</div>`)).join('')}</div>`;
  }

  const BRANCH_ACTIONS = [['Create Branch…', 'createBranch'], ['Create Branch From…', 'createBranchFrom'], ['Rename Branch…', 'renameBranch'], ['Set Upstream…', 'setUpstream'], ['Checkout (search)…', 'checkout'], null, ['Delete Branch…', 'deleteBranch', true], ['Delete Remote Branch…', 'deleteRemoteBranch', true], ['Prune Merged Branches…', 'pruneMergedBranches']];

  /** Branch menu: actions, then local branches, then remote branches (each newest first). */
  function branchMenu(branches) {
    const local = (branches && branches.local) || [];
    const remote = (branches && branches.remote) || [];
    return [
      ...BRANCH_ACTIONS,
      { h: `Local branches · ${local.length}` },
      ...local.map((b) => ({ b: b.name, remote: false, current: b.current, time: b.time, upstream: b.upstream })),
      { h: `Remote branches · ${remote.length}` },
      ...remote.map((b) => ({ b: b.name, remote: true, current: false, time: b.time }))
    ];
  }

  function branchItem(it) {
    const kind = it.remote ? 'b-remote' : 'b-local';
    const title = it.current ? 'Current branch' : `Check out ${it.b}${it.upstream ? ' (tracks ' + it.upstream + ')' : ''}`;
    return `<button class="mi ${kind}${it.current ? ' current' : ''}" role="menuitem" data-checkout="${esc(it.b)}" data-remote="${it.remote ? '1' : ''}" title="${esc(title)}" ${it.current ? 'aria-current="true"' : ''}>
      <span class="bname">${it.current ? '✓ ' : ''}${esc(it.b)}</span><kbd>${esc(ago(it.time * 1000))}</kbd></button>`;
  }
  function mi([label, id, danger]) {
    return `<button class="mi${danger ? ' danger' : ''}" role="menuitem" data-run="${esc(id)}">${esc(label)}</button>`;
  }

  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + 'mo ago';
    return Math.floor(s / (86400 * 365)) + 'y ago';
  }

  // --- rendering ---------------------------------------------------------------

  // The Profiles tab mounts media/profiles.js in a container outside #app, so the frequent
  // re-renders of the repo view never reset what you are typing in the profile editor.
  const profilesRoot = document.createElement('div');
  profilesRoot.id = 'profiles-root';
  profilesRoot.hidden = true;
  document.body.appendChild(profilesRoot);
  // @ts-ignore
  const profilesView = window.CanopyProfiles ? window.CanopyProfiles.mount(profilesRoot, { postMessage: (m) => post({ type: 'profiles', msg: m }) }) : null;
  let profilesReady = false;

  /** Workspace-wide profiles take the full width; only the breadcrumb and tabs stay from the repo view. */
  function renderProfilesShell() {
    const r = state.repo;
    app.className = '';
    app.innerHTML = `<div class="page shell">
      <div class="crumb"><span>CANOPY  /  Profiles</span><span class="version" title="CANOPY version">CANOPY ${esc(state.version || '')}</span></div>
      <div class="graph-h">${viewTabs()}<span class="muted">Profiles cover the whole workspace, not just ${esc(r.name)}.</span></div>
    </div>`;
    profilesRoot.hidden = false;
    if (!profilesReady && profilesView) {
      profilesReady = true;
      post({ type: 'profiles', msg: { type: 'ready' } });
    }
  }

  let measuring = false;
  /**
   * The repo view is a fixed skeleton of sections (display: contents, so layout is unchanged). Each render
   * builds every section's markup but only replaces the sections whose markup changed, so a spinner or a
   * pipeline update leaves the graph, its scroll position, hover and the commit message box alone.
   */
  const SECTIONS = ['crumb', 'head', 'toolbar', 'banner', 'changes', 'graph', 'ctx'];
  const SKELETON = `<div class="page">
      <div class="sec" data-sec="crumb"></div><div class="sec" data-sec="head"></div><div class="sec" data-sec="toolbar"></div><div class="sec" data-sec="banner"></div>
      <div class="body"><div class="sec" data-sec="changes"></div><div class="sec" data-sec="graph"></div></div>
    </div><div class="sec" data-sec="ctx"></div>`;
  /** @type {Record<string, string>} Markup currently shown per section. */
  let shown = {};
  /** Repo whose draft the live commit message box holds (it is kept across re-renders of the Changes card). */
  let msgRoot = '';

  function render() {
    if (!state) return;
    if (view === 'profiles') {
      shown = {};
      return renderProfilesShell();
    }
    profilesRoot.hidden = true;
    const r = state.repo;
    MENUS.forge = r.forge && r.forge.kind === 'connected' ? forgeMenu(r.forge) : [];
    MENUS.branch = branchMenu(state.branches);
    /** @type {Record<string, string>} */
    const html = {
      crumb: `<div class="crumb"><span>${esc(r.crumb)}</span><span class="version" title="CANOPY version">CANOPY ${esc(state.version || '')}</span></div>`,
      head: `<div class="title">
        <h1>${esc(r.name)}</h1>
        <span class="branch">${icon('branch')}${esc(r.branchLabel)}</span>
        ${r.upstream ? `<span class="mono muted">→ ${esc(r.upstream)}</span>` : r.branch && r.remotes.length ? '<span class="muted">not published</span>' : ''}
      </div>
      ${forgeChips(r)}
      <div class="meta"><span class="mono">${esc(r.root)}</span>${r.fetching ? '<span>fetching…</span>' : r.lastFetch ? `<span>fetched ${ago(r.lastFetch)}</span>` : ''}${r.stashCount ? `<span>${r.stashCount} stash${r.stashCount === 1 ? '' : 'es'}</span>` : ''}</div>`,
      toolbar: toolbar(r),
      banner: banner(r),
      changes: changesCard(r),
      graph: graphCard(),
      ctx: ctx ? contextMenu() : ''
    };
    if (!app.querySelector('[data-sec="graph"]')) {
      // First render, or back from the Profiles tab.
      app.className = '';
      app.innerHTML = SKELETON;
      shown = {};
    }
    const focus = captureFocus();
    const scroll = /** @type {HTMLElement|null} */ (app.querySelector('.rows'))?.scrollTop ?? 0;
    const oldMsg = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('msg'));
    const changed = SECTIONS.filter((k) => shown[k] !== html[k]);
    for (const k of changed) {
      const el = /** @type {HTMLElement} */ (app.querySelector(`[data-sec="${k}"]`));
      el.innerHTML = html[k];
      shown[k] = html[k];
      // Re-rendering replaces a spinning icon; phase it to the clock so the rotation never visibly restarts.
      for (const s of /** @type {SVGElement[]} */ ([...el.querySelectorAll('.i.spin')])) s.style.animationDelay = `-${Date.now() % 900}ms`;
    }
    if (changed.includes('changes')) {
      const msg = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('msg'));
      if (msg && oldMsg && msgRoot === r.root) {
        // Keep the box the user is typing in (value, size, cursor, undo history); take the new placeholder.
        oldMsg.placeholder = msg.placeholder;
        msg.replaceWith(oldMsg);
      } else if (msg) {
        msg.value = drafts[r.root] || '';
      }
      msgRoot = r.root;
    }
    if (changed.includes('graph')) {
      const rows = /** @type {HTMLElement|null} */ (app.querySelector('.rows'));
      if (rows) rows.scrollTop = scroll;
    }
    if (revealFiles) {
      revealFiles = false;
      /** @type {HTMLElement|null} */ (app.querySelector('.cfiles'))?.scrollIntoView({ block: 'nearest' });
    }
    if (changed.includes('ctx')) positionContextMenu();
    if (focus && document.activeElement?.id !== focus.id) restoreFocus(focus);
    if (view === 'stats' && stats.data && !measuring && measureCharts()) {
      measuring = true;
      render();
      measuring = false;
      return;
    }
    post({ type: 'rendered', rows: state.graph.rows.length, files: r.staged.length + r.unstaged.length + r.conflicts.length });
  }

  function toolbar(r) {
    const tb = (name, label, ic, extra = '') =>
      `<div class="tb"><button class="btn ${extra}" data-menu="${name}" aria-haspopup="menu" aria-expanded="${openMenu === name}">${icon(ic)}<span>${esc(label)}</span>${icon('chev', 'chev')}</button>${openMenu === name ? menuHtml(name) : ''}</div>`;
    // The same busy state as the repository's row in the sidebar: any running git action spins this button.
    const doing = r.activity && r.activity.length ? r.activity[r.activity.length - 1] : '';
    const sync = r.upstream
      ? doing
        ? `<button class="btn primary busy" data-run="sync" aria-busy="true" disabled title="${esc(doing)}…">${icon('sync', 'spin')}${esc(doing)}…</button>`
        : `<button class="btn primary" data-run="sync" title="Pull then push">${icon('sync')}Sync ↓${r.behind} ↑${r.ahead}</button>`
      : r.branch && r.remotes.length
        ? doing
          ? `<button class="btn primary busy" data-run="publishBranch" aria-busy="true" disabled title="${esc(doing)}…">${icon('sync', 'spin')}${esc(doing)}…</button>`
          : `<button class="btn primary" data-run="publishBranch">${icon('push')}Publish Branch</button>`
        : '';
    return `<div class="toolbar" role="toolbar" aria-label="Git actions">
      ${sync}
      ${tb('pull', 'Pull', 'pull')}${tb('push', 'Push', 'push')}${tb('fetch', 'Fetch', 'fetch')}
      ${tb('branch', r.branchLabel, 'branch', 'branchbtn')}
      ${tb('merge', 'Merge', 'merge')}${tb('rebase', 'Rebase', 'rebase')}${tb('stash', 'Stash', 'stash')}${tb('prune', 'Prune', 'prune')}
      ${r.forge && r.forge.kind === 'connected' ? tb('forge', (WORDS[r.forge.provider] || WORDS.gitlab).name, (WORDS[r.forge.provider] || WORDS.gitlab).icon) : ''}
      ${tb('more', 'More', 'more')}
      <button class="icon-btn" data-act="refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button>
    </div>`;
  }

  const CI_LABEL = { success: 'passed', failed: 'failed', running: 'running', pending: 'pending', created: 'created', canceled: 'canceled', skipped: 'skipped', manual: 'manual', scheduled: 'scheduled', preparing: 'preparing', waiting_for_resource: 'waiting' };
  /** Wording that differs between GitLab and GitHub. */
  const WORDS = {
    gitlab: { name: 'GitLab', request: 'merge request', Request: 'Merge Request', prefix: '!', Pipeline: 'Pipeline', none: 'No pipeline', retry: 'Retry', icon: 'gitlab', connect: 'Connect GitLab…' },
    github: { name: 'GitHub', request: 'pull request', Request: 'Pull Request', prefix: '#', Pipeline: 'Checks', none: 'No checks', retry: 'Re-run', icon: 'github', connect: 'Sign in to GitHub…' }
  };
  const CI_GITHUB = { success: 'passed', failed: 'failed', running: 'running', canceled: 'canceled', skipped: 'skipped', manual: 'need approval' };

  function forgeMenu(g) {
    const w = WORDS[g.provider] || WORDS.gitlab;
    return [[`Create ${w.Request}…`, 'forge.createRequest'], [`Open ${w.Request}`, 'forge.openRequest'], null, [`Open ${w.Pipeline}`, 'forge.openPipeline'], [`${w.retry} ${w.Pipeline === 'Checks' ? 'Failed Checks' : 'Pipeline'}`, 'forge.retryPipeline'], null, [`Open on ${w.name}`, 'forge.openProject'], [`Refresh ${w.name} Status`, 'forge.refresh']];
  }

  function forgeChips(r) {
    const g = r.forge;
    if (!g || g.kind !== 'connected') return '';
    const w = WORDS[g.provider] || WORDS.gitlab;
    if (g.loading) return `<div class="chips"><span class="chip muted">Loading ${w.name} status…</span></div>`;
    if (g.error && !g.project) return `<div class="chips"><span class="chip ci-failed" title="${esc(g.error)}">${icon(w.icon)}${w.name}: ${esc(g.error)}</span></div>`;
    const parts = [];
    if (g.pipeline) {
      const st = g.pipeline.status;
      const label = g.provider === 'github' ? CI_GITHUB[st] || st : CI_LABEL[st] || st;
      const num = g.pipeline.id && g.provider === 'gitlab' ? `#${g.pipeline.id}` : '';
      const note = [num, g.pipeline.isHead ? '' : 'other commit'].filter(Boolean).join(' · ');
      parts.push(`<button class="chip ci-${esc(st)}" data-run="forge.openPipeline" title="Open ${w.Pipeline.toLowerCase()}${g.pipeline.isHead ? '' : ' (not for the checked-out commit)'}">${icon(w.icon)}${w.Pipeline} ${esc(label)}${note ? ` <span class="muted">${esc(note)}</span>` : ''}</button>`);
      if ((st === 'failed' || st === 'canceled') && g.pipeline.id) parts.push(`<button class="chip" data-run="forge.retryPipeline">${icon('refresh')}${w.retry}</button>`);
    } else {
      parts.push(`<span class="chip muted">${icon(w.icon)}${w.none}</span>`);
    }
    if (g.mr) {
      const m = g.mr;
      const approval = m.changesRequested ? 'changes requested' : m.approved ? 'approved' : m.approvalsLeft ? m.approvalsLeft + ' approval' + (m.approvalsLeft === 1 ? '' : 's') + ' needed' : '';
      const extra = [m.draft ? 'draft' : '', m.hasConflicts ? 'conflicts' : '', approval].filter(Boolean).join(' · ');
      parts.push(`<button class="chip${m.hasConflicts || m.changesRequested ? ' ci-failed' : ''}" data-run="forge.openRequest" title="Open ${w.request} ${w.prefix}${m.iid} → ${esc(m.targetBranch)}">${icon('mr')}${w.prefix}${m.iid} ${esc(m.title)}${extra ? ` <span class="muted">· ${esc(extra)}</span>` : ''}</button>`);
    } else if (r.branch && g.project && r.branch !== g.project.defaultBranch && !g.readOnly) {
      parts.push(`<button class="chip accent" data-run="forge.createRequest">${icon('mr')}Create ${w.request}</button>`);
    }
    return `<div class="chips">${parts.join('')}</div>`;
  }

  function banner(r) {
    if (r.forge && r.forge.kind === 'disconnected' && !r.operation && !r.conflicts.length && !r.error) {
      const w = WORDS[r.forge.provider] || WORDS.gitlab;
      return `<div class="banner info">${icon('plug')}<span class="text">This repository is on <b>${esc(r.forge.host)}</b>. ${r.forge.provider === 'github' ? 'Sign in' : 'Connect CANOPY'} to see ${w.Pipeline.toLowerCase()} and ${w.request}s here.</span><button class="btn small primary" data-run="${r.forge.provider}.connect">${w.connect}</button></div>`;
    }
    if (r.error) return `<div class="banner error">${icon('warn')}<span class="text">${esc(r.error)}</span></div>`;
    if (!r.operation && !r.conflicts.length) return '';
    const op = r.operation || 'merge';
    const n = r.conflicts.length;
    const canSkip = op === 'rebase' || op === 'cherry-pick';
    return `<div class="banner">${icon('warn')}<span class="text"><b>${esc(op[0].toUpperCase() + op.slice(1))} in progress</b>${n ? ` · ${n} conflicted file${n === 1 ? '' : 's'}` : ' · no conflicts left'}</span>
      ${n ? `<button class="btn small" data-run="openConflicts">${icon('merge3')}Merge Editor</button><button class="btn small" data-run="openMergeTool">External Tool</button>` : ''}
      ${op !== 'bisect' ? `<button class="btn small primary" data-run="continueOperation">Continue</button>` : ''}
      ${canSkip ? `<button class="btn small" data-run="skipOperation">Skip</button>` : ''}
      <button class="btn small danger" data-run="abortOperation">Abort</button></div>`;
  }

  function fileRow(f, kind) {
    // Untracked folders arrive as "docs/"; show them as "docs/" rather than an empty name.
    const isDir = f.path.endsWith('/');
    const clean = isDir ? f.path.slice(0, -1) : f.path;
    const slash = clean.lastIndexOf('/');
    const name = (slash >= 0 ? clean.slice(slash + 1) : clean) + (isDir ? '/' : '');
    const dir = slash >= 0 ? clean.slice(0, slash) : '';
    const p = esc(f.path);
    const acts =
      kind === 'conflict'
        ? `<button class="icon-btn" data-act="mergeEditor" data-path="${p}" title="Open in merge editor" aria-label="Open ${p} in merge editor">${icon('merge3')}</button>
           <button class="icon-btn" data-act="open-file" data-path="${p}" title="Open file" aria-label="Open ${p}">${icon('file')}</button>
           <button class="icon-btn" data-act="stage" data-path="${p}" title="Mark resolved (stage)" aria-label="Mark ${p} resolved">${icon('plus')}</button>`
        : kind === 'staged'
          ? `<button class="icon-btn" data-act="open-file" data-path="${p}" title="Open file" aria-label="Open ${p}">${icon('file')}</button>
             <button class="icon-btn" data-act="unstage" data-path="${p}" title="Unstage" aria-label="Unstage ${p}">${icon('minus')}</button>`
          : `<button class="icon-btn" data-act="open-file" data-path="${p}" title="Open file" aria-label="Open ${p}">${icon('file')}</button>
             <button class="icon-btn danger" data-act="discard" data-path="${p}" title="Discard changes" aria-label="Discard changes in ${p}">${icon('discard')}</button>
             <button class="icon-btn" data-act="stage" data-path="${p}" title="Stage" aria-label="Stage ${p}">${icon('plus')}</button>`;
    return `<div class="file"><button class="open" data-act="${kind === 'conflict' ? 'mergeEditor' : 'open'}" data-path="${p}" data-staged="${kind === 'staged'}" title="${p}${f.origPath ? ' (from ' + esc(f.origPath) + ')' : ''}">
        <span class="st st-${esc(f.status)}">${esc(f.status)}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}</span>${lineStats(f)}</button>
        <span class="acts">${acts}</span></div>`;
  }

  function changesCard(r) {
    const total = new Set([...r.staged, ...r.unstaged, ...r.conflicts].map((f) => f.path)).size;
    const section = (title, list, kind, headerActs) =>
      list.length
        ? `<div><div class="sec-h">${esc(title)} <span class="count">${list.length}</span><span class="spacer"></span>${headerActs}</div>${list.map((f) => fileRow(f, kind)).join('')}</div>`
        : '';
    return `<section class="card changes" aria-label="Changes">
      <div class="card-h"><h2>Changes</h2><span class="muted">${total ? total + ' file' + (total === 1 ? '' : 's') : ''}</span><span class="spacer"></span>
        <button class="icon-btn" data-act="stage-all" title="Stage all changes" aria-label="Stage all changes">${icon('plus')}</button>
        <button class="btn small danger" data-act="discard-all" ${r.unstaged.length ? '' : 'disabled'} title="${state.safetyStash ? 'A safety stash is saved first' : 'Cannot be undone'}">${icon('discard')}Discard all</button></div>
      <textarea class="msg" id="msg" rows="2" placeholder="Message (Ctrl+Enter to commit on ${esc(r.branchLabel)})"></textarea>
      <div class="split">
        <button class="btn primary" data-act="commit" ${total ? '' : 'disabled'}>Commit${r.staged.length ? '' : total ? ' All' : ''}</button>
        <button class="btn primary" data-menu="commit" aria-label="More commit options" aria-haspopup="menu">${icon('chev')}</button>
        ${openMenu === 'commit' ? menuHtml('commit', 'right') : ''}
      </div>
      ${section('Merge conflicts', r.conflicts, 'conflict', '')}
      ${section('Staged changes', withStats(r.staged, 'staged'), 'staged', `<button class="icon-btn" data-act="unstage-all" title="Unstage all" aria-label="Unstage all">${icon('minus')}</button>`)}
      ${section('Changes', withStats(r.unstaged, 'unstaged'), 'unstaged', `<button class="icon-btn danger" data-act="discard-all" title="Discard all changes" aria-label="Discard all changes">${icon('discard')}</button><button class="icon-btn" data-act="stage-all" title="Stage all" aria-label="Stage all">${icon('plus')}</button>`)}
      ${total ? '' : '<div class="empty">Working tree clean.</div>'}
    </section>`;
  }

  const ROW_H = 24;
  const LANE_W = 14;
  const lx = (lane) => 9 + lane * LANE_W;
  const ly = (y) => (y === 0 ? 0 : y === 1 ? ROW_H / 2 : ROW_H);

  function laneSvg(row, width) {
    const w = Math.max(1, width) * LANE_W + 6;
    const segs = row.lines
      .map((l) => {
        const x1 = lx(l.x1), y1 = ly(l.y1), x2 = lx(l.x2), y2 = ly(l.y2);
        const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
        return `<path class="lane s${l.color % 8}" d="${d}"/>`;
      })
      .join('');
    const cx = lx(row.lane), c = row.lane % 8;
    const node = row.wip
      ? `<circle class="node-bg s${c}" cx="${cx}" cy="${ROW_H / 2}" r="4" stroke-width="1.6" stroke-dasharray="2 1.6"/>`
      : row.head
        ? `<circle class="node-bg s${c}" cx="${cx}" cy="${ROW_H / 2}" r="4.5" stroke-width="2"/><circle class="f${c}" cx="${cx}" cy="${ROW_H / 2}" r="2"/>`
        : `<circle class="f${c}" cx="${cx}" cy="${ROW_H / 2}" r="3.5"/>`;
    return `<svg width="${w}" height="${ROW_H}" viewBox="0 0 ${w} ${ROW_H}" aria-hidden="true">${segs}${node}</svg>`;
  }

  function viewTabs() {
    return `<div class="tabs" role="tablist" aria-label="View">${[['graph', 'Graph'], ['stats', 'Stats'], ['profiles', 'Profiles']]
      .map(([v, l]) => `<button role="tab" class="tab${view === v ? ' on' : ''}" data-view="${v}" aria-selected="${view === v}">${l}</button>`)
      .join('')}</div>`;
  }

  function graphCard() {
    if (view === 'stats') return statsCard();
    const g = state.graph;
    const scopes = [['all', 'All branches'], ['local', 'Local'], ['current', 'Current']];
    const rows = g.rows
      .map((row) => {
        const refs = row.refs.map((ref) => `<span class="ref ${esc(ref.type)}">${esc(ref.name)}</span>`).join('');
        const subj = row.wip ? `${state.repo.operation ? esc(state.repo.operation) + ' in progress · ' : ''}Uncommitted changes` : esc(row.subject);
        return `<div class="row${row.wip ? ' wip' : ''}${row.head ? ' head' : ''}${selectedSha === row.hash ? ' sel' : ''}" data-sha="${esc(row.hash)}" role="listitem" tabindex="-1">
          ${laneSvg(row, g.width)}
          <span class="subj">${refs}<span class="txt">${subj}</span></span>
          <span class="who">${esc(row.author)}</span><span class="when">${row.time ? ago(row.time * 1000) : ''}</span><span class="sha">${esc(row.short)}</span></div>${selectedSha === row.hash ? filesBlock(row, g.width) : ''}`;
      })
      .join('');
    return `<section class="card graph" aria-label="Commit graph">
      <div class="graph-h">${viewTabs()}
        <div class="seg" role="group" aria-label="Branches shown">${scopes.map(([v, l]) => `<button class="${state.scope === v ? 'on' : ''}" data-scope="${v}" aria-pressed="${state.scope === v}">${l}</button>`).join('')}</div>
        <span class="spacer"></span><span class="muted">Click a commit for its files · right-click for actions</span></div>
      <div class="rows" role="list">${rows || '<div class="more-note">No commits yet.</div>'}</div>
      ${g.truncated ? `<div class="more-note">Showing the latest ${g.rows.length} commits (setting: canopy.graph.maxCommits).</div>` : ''}
    </section>`;
  }

  /** Attaches line counts from state.wipStats[which] ('head' | 'staged' | 'unstaged') to a file list. */
  function withStats(files, which) {
    const stats = (state.wipStats && state.wipStats[which]) || {};
    return files.map((f) => (stats[f.path] ? { ...f, added: stats[f.path][0], deleted: stats[f.path][1] } : f));
  }

  /** Uncommitted files (conflicts, staged, unstaged) as one list, one entry per path. */
  function wipFiles() {
    const r = state.repo;
    const seen = new Map();
    for (const f of r.conflicts) seen.set(f.path, f);
    for (const f of [...r.staged, ...r.unstaged]) if (!seen.has(f.path)) seen.set(f.path, f);
    return withStats([...seen.values()], 'head');
  }

  /** The changed-file list shown under the selected graph row, with the lanes carried through it. */
  function filesBlock(row, width) {
    const w = Math.max(1, width) * LANE_W + 6;
    const lanes = row.lines
      .filter((l) => l.y2 === 2)
      .map((l) => `<path class="lane s${l.color % 8}" d="M${lx(l.x2)} 0V1" vector-effect="non-scaling-stroke"/>`)
      .join('');
    const files = row.wip ? wipFiles() : commitFiles[row.hash];
    let body;
    if (!files || files === 'loading') body = '<div class="cf-note">Loading files…</div>';
    else if (!Array.isArray(files)) body = `<div class="cf-note error">${esc(files.error)}</div>`;
    else if (!files.length) body = `<div class="cf-note">${row.wip ? 'No uncommitted changes.' : 'No file changes in this commit.'}</div>`;
    else
      body =
        `<div class="cf-note">${files.length} file${files.length === 1 ? '' : 's'} ${row.wip ? 'changed since HEAD' : 'changed'}</div>` +
        files.map((f) => commitFileRow(f, row.hash)).join('');
    return `<div class="cfiles" role="listitem" aria-label="Files changed in ${row.wip ? 'uncommitted changes' : esc(row.short)}">
      <svg class="cf-lanes" width="${w}" viewBox="0 0 ${w} 1" preserveAspectRatio="none" aria-hidden="true">${lanes}</svg>
      <div class="cf-list">${body}</div></div>`;
  }

  /** "+12 −3" for a file whose line counts are known (not for binary files). */
  function lineStats(f) {
    if (typeof f.added !== 'number') return '';
    return `<span class="ln" title="${f.added} added, ${f.deleted} deleted"><span class="ln-add">+${f.added}</span><span class="ln-del">−${f.deleted}</span></span>`;
  }

  function commitFileRow(f, sha) {
    const slash = f.path.lastIndexOf('/');
    const name = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    const dir = slash >= 0 ? f.path.slice(0, slash) : '';
    const p = esc(f.path);
    const title = `${p}${f.origPath ? ' (from ' + esc(f.origPath) + ')' : ''}`;
    const openFile = f.status === 'D' ? '' : `<span class="acts"><button class="icon-btn" data-act="open-file" data-path="${p}" title="Open file" aria-label="Open ${p}">${icon('file')}</button></span>`;
    return `<div class="file"><button class="open" data-act="commit-file" data-sha="${esc(sha)}" data-path="${p}" data-orig="${esc(f.origPath || '')}" data-status="${esc(f.status)}" title="${title}">
        <span class="st st-${esc(f.status)}">${esc(f.status)}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}</span>${lineStats(f)}</button>${openFile}</div>`;
  }

  // --- stats ---------------------------------------------------------------------

  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const fmt = (n) => (Math.abs(n) >= 10000 ? compact.format(n) : Number(n).toLocaleString());
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dateLabel = (t, withYear = true) => {
    const d = new Date(t * 1000);
    return `${MONTHS[d.getUTCMonth()]}${withYear ? ' ' + d.getUTCFullYear() : ''}`;
  };
  const bucketLabel = (t, unit) => {
    const d = new Date(t * 1000);
    return unit === 'month' ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `Week of ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };
  /** Clean y-axis maximum and ticks (0 … max in 3–5 steps). */
  function niceScale(max) {
    if (max <= 0) return { max: 1, ticks: [0, 1] };
    const raw = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
    return { max: top, ticks };
  }
  /** Column with a 4px rounded data end and a square base. */
  function colPath(x, y, w, h) {
    if (h <= 0) return '';
    const r = Math.min(4, w / 2, h);
    return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
  }
  const M = { l: 44, r: 12, t: 10, b: 22 };

  function axes(scale, w, h, buckets, unit) {
    const pw = w - M.l - M.r, ph = h - M.t - M.b;
    const grid = scale.ticks
      .map((v) => {
        const y = M.t + ph - (v / scale.max) * ph;
        return `<line class="grid" x1="${M.l}" x2="${w - M.r}" y1="${y}" y2="${y}"/><text class="ax" x="${M.l - 6}" y="${y + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
      })
      .join('');
    const n = buckets.length;
    const labels = Math.min(n, Math.max(2, Math.floor(pw / 90)));
    let xl = '';
    for (let i = 0; i < labels; i++) {
      const b = Math.round((i * (n - 1)) / Math.max(1, labels - 1));
      const x = M.l + ((b + 0.5) * pw) / n;
      const anchor = i === 0 ? 'start' : i === labels - 1 ? 'end' : 'middle';
      const d = new Date(buckets[b].start * 1000);
      xl += `<text class="ax" x="${x}" y="${h - 6}" text-anchor="${anchor}">${unit === 'month' ? dateLabel(buckets[b].start) : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`}</text>`;
    }
    return grid + xl;
  }

  function commitsChart(d, w) {
    const h = 190, b = d.buckets;
    if (!b.length) return '<div class="cf-note">No commits.</div>';
    const scale = niceScale(Math.max(...b.map((x) => x.commits)));
    const pw = w - M.l - M.r, ph = h - M.t - M.b, slot = pw / b.length;
    const bw = Math.max(1, Math.min(24, slot - 2));
    const marks = b
      .map((x, i) => {
        const bh = (x.commits / scale.max) * ph;
        const x0 = M.l + i * slot;
        return `<g class="hb" data-tip="${esc(bucketLabel(x.start, d.unit))}&#10;${x.commits} commit${x.commits === 1 ? '' : 's'}"><rect class="hit" x="${x0}" y="${M.t}" width="${slot}" height="${ph}"/><path class="bar" d="${colPath(x0 + (slot - bw) / 2, M.t + ph - bh, bw, bh)}"/></g>`;
      })
      .join('');
    return `<svg class="chart-svg" width="${w}" height="${h}" role="img" aria-label="Commits per ${d.unit}">${axes(scale, w, h, b, d.unit)}${marks}</svg>`;
  }

  function linesChart(d, w) {
    const h = 190, b = d.buckets;
    if (!b.length) return '<div class="cf-note">No commits.</div>';
    const scale = niceScale(Math.max(...b.map((x) => x.lines)));
    const pw = w - M.l - M.r, ph = h - M.t - M.b, slot = pw / b.length;
    const px = (i) => M.l + (i + 0.5) * slot;
    const py = (v) => M.t + ph - (Math.max(0, v) / scale.max) * ph;
    const pts = b.map((x, i) => `${px(i).toFixed(1)} ${py(x.lines).toFixed(1)}`);
    const line = `M${pts.join('L')}`;
    const area = `${line}L${px(b.length - 1).toFixed(1)} ${M.t + ph}L${px(0).toFixed(1)} ${M.t + ph}Z`;
    const hover = b
      .map((x, i) => {
        const prev = i ? b[i - 1].lines : null;
        const delta = prev === null ? '' : ` (${x.lines - prev >= 0 ? '+' : '−'}${fmt(Math.abs(x.lines - prev))})`;
        return `<g class="hb" data-tip="${esc(bucketLabel(x.start, d.unit))}&#10;${fmt(x.lines)} lines${delta}"><rect class="hit" x="${M.l + i * slot}" y="${M.t}" width="${slot}" height="${ph}"/><line class="guide" x1="${px(i)}" x2="${px(i)}" y1="${M.t}" y2="${M.t + ph}"/><circle class="dot" cx="${px(i)}" cy="${py(x.lines)}" r="4"/></g>`;
      })
      .join('');
    const last = b[b.length - 1];
    return `<svg class="chart-svg" width="${w}" height="${h}" role="img" aria-label="Lines of code over time">${axes(scale, w, h, b, d.unit)}<path class="area" d="${area}"/><path class="line" d="${line}"/><circle class="dot end" cx="${px(b.length - 1)}" cy="${py(last.lines)}" r="4"/>${hover}</svg>`;
  }

  function heatmapChart(d, w) {
    const max = Math.max(1, ...d.heatmap.flat());
    const cell = Math.max(8, Math.min(22, Math.floor((w - 40) / 24) - 2));
    const gap = 2, left = 34, top = 4;
    let cells = '';
    d.heatmap.forEach((row, day) =>
      row.forEach((v, hr) => {
        const q = v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999));
        cells += `<rect class="hm q${q}" x="${left + hr * (cell + gap)}" y="${top + day * (cell + gap)}" width="${cell}" height="${cell}" rx="2" data-tip="${DAYS[day]} ${String(hr).padStart(2, '0')}:00–${String((hr + 1) % 24).padStart(2, '0')}:00&#10;${v} commit${v === 1 ? '' : 's'}"/>`;
      })
    );
    const rows = DAYS.map((n, i) => `<text class="ax" x="${left - 6}" y="${top + i * (cell + gap) + cell / 2 + 4}" text-anchor="end">${n}</text>`).join('');
    const hy = top + 7 * (cell + gap) + 12;
    const cols = [0, 6, 12, 18].map((hr) => `<text class="ax" x="${left + hr * (cell + gap)}" y="${hy}">${String(hr).padStart(2, '0')}:00</text>`).join('');
    const ww = left + 24 * (cell + gap);
    return `<svg class="chart-svg" width="${ww}" height="${hy + 4}" role="img" aria-label="Commits by weekday and hour">${rows}${cols}${cells}</svg>
      <div class="hm-legend"><span>Fewer</span>${[0, 1, 2, 3, 4].map((q) => `<svg width="12" height="12" aria-hidden="true"><rect class="hm q${q}" width="12" height="12" rx="2"/></svg>`).join('')}<span>More commits · author's local time</span></div>`;
  }

  /** A horizontal share bar drawn as SVG (inline styles are blocked by the webview's CSP). */
  const shareBar = (frac) => `<svg class="share" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="6"/><rect class="fill" width="${Math.max(0, Math.min(100, frac * 100)).toFixed(2)}" height="6"/></svg>`;

  function languagesList(d) {
    const total = d.totalLines || 1;
    const top = d.languages.slice(0, 8);
    const rest = d.languages.slice(8);
    if (rest.length) top.push({ language: `Other (${rest.length} more)`, lines: rest.reduce((a, l) => a + l.lines, 0), files: rest.reduce((a, l) => a + l.files, 0) });
    if (!top.length) return '<div class="cf-note">No text files.</div>';
    return `<div class="langs">${top
      .map((l) => `<div class="lang" data-tip="${esc(l.language)}&#10;${fmt(l.lines)} lines in ${fmt(l.files)} file${l.files === 1 ? '' : 's'}"><span class="lname">${esc(l.language)}</span>${shareBar(l.lines / total)}<span class="num">${fmt(l.lines)}</span><span class="pct">${((l.lines / total) * 100).toFixed(1)}%</span></div>`)
      .join('')}</div>`;
  }

  function authorsTable(d) {
    const own = stats.scope === 'repo' ? stats.owners : null;
    const ownTotal = own ? Object.values(own.authors).reduce((a, x) => a + x.lines, 0) : 0;
    const today = (a) => (own && own.authors[a.key] ? own.authors[a.key].lines : 0);
    const key = { commits: (a) => a.commits, added: (a) => a.added, deleted: (a) => a.deleted, today, name: (a) => a.name.toLowerCase() }[stats.sort] || ((a) => a.commits);
    const rows = [...d.authors].sort((x, y) => (stats.sort === 'name' ? (key(x) < key(y) ? -1 : 1) : key(y) - key(x)));
    const th = (k, label, cls = '') => `<th class="${cls}"><button class="sort${stats.sort === k ? ' on' : ''}" data-sort="${k}" aria-sort="${stats.sort === k ? (k === 'name' ? 'ascending' : 'descending') : 'none'}">${label}</button></th>`;
    const showOwn = stats.scope === 'repo';
    const progress = own && own.done < own.total ? `Counting lines each author owns today… ${own.done}/${own.total} files` : '';
    const body = rows
      .map((a) => {
        const lines = today(a);
        const ownCell = showOwn
          ? `<td class="num own"><span class="ownwrap">${own && ownTotal ? shareBar(lines / ownTotal) : ''}<span>${own ? (own.done < own.total && !lines ? '…' : fmt(lines)) : '…'}</span></span></td>`
          : '';
        return `<tr><td class="who" title="${esc(a.email)}">${esc(a.name)}</td><td class="num">${fmt(a.commits)}</td><td class="num add">+${fmt(a.added)}</td><td class="num del">−${fmt(a.deleted)}</td>${ownCell}</tr>`;
      })
      .join('');
    return `<table class="stbl"><thead><tr>${th('name', 'Author')}${th('commits', 'Commits', 'num')}${th('added', 'Lines added', 'num')}${th('deleted', 'Lines deleted', 'num')}${showOwn ? th('today', 'Lines today', 'num') : ''}</tr></thead><tbody>${body}</tbody></table>
      ${d.authorCount > d.authors.length ? `<div class="cf-note">Top ${d.authors.length} of ${d.authorCount} authors by commits.</div>` : ''}
      ${progress ? `<div class="cf-note">${esc(progress)}</div>` : showOwn && own ? '<div class="cf-note">Lines today: lines at HEAD last changed by each author (git blame, whitespace ignored).</div>' : ''}`;
  }

  function churnTable(d) {
    if (!d.churn.length) return '<div class="cf-note">No file changes in this range.</div>';
    const open = stats.scope === 'repo';
    return `<table class="stbl"><thead><tr><th>File</th><th class="num">Commits</th><th class="num">Lines added</th><th class="num">Lines deleted</th></tr></thead><tbody>${d.churn
      .map((c) => `<tr><td class="path">${open ? `<button class="link" data-open-path="${esc(c.path)}" title="Open ${esc(c.path)}">${esc(c.path)}</button>` : esc(c.path)}</td><td class="num">${fmt(c.commits)}</td><td class="num add">+${fmt(c.added)}</td><td class="num del">−${fmt(c.deleted)}</td></tr>`)
      .join('')}</tbody></table>`;
  }

  function reposTable(d) {
    return `<table class="stbl"><thead><tr><th>Repository</th><th class="num">Commits</th><th class="num">Authors</th><th class="num">Lines of code</th><th class="num">Lines added</th><th class="num">Lines deleted</th></tr></thead><tbody>${[...d.repos]
      .sort((a, b) => b.commits - a.commits)
      .map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.commits)}</td><td class="num">${fmt(r.authors)}</td><td class="num">${fmt(r.lines)}</td><td class="num add">+${fmt(r.added)}</td><td class="num del">−${fmt(r.deleted)}</td></tr>`)
      .join('')}</tbody></table>`;
  }

  const tile = (label, value, sub = '') => `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ''}</div>`;
  const panel = (title, sub, body, cls = '') => `<section class="spanel ${cls}"><div class="sp-h"><h3>${esc(title)}</h3>${sub ? `<span class="muted">${esc(sub)}</span>` : ''}</div>${body}</section>`;
  const chartBox = (name, fn, d) => `<div class="chart" data-chart="${name}">${fn(d, chartW[name] || 480)}</div>`;

  function statsCard() {
    const ranges = [['3m', '3 months'], ['1y', '1 year'], ['all', 'All time']];
    const f = stats.folder;
    const scopes = f ? [['repo', 'This repository'], ['folder', `${f.name} · ${f.count} repositories`]] : [];
    const seg = (items, attr, cur, label) =>
      `<div class="seg" role="group" aria-label="${label}">${items.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-${attr}="${v}" aria-pressed="${cur === v}">${esc(l)}</button>`).join('')}</div>`;
    const head = `<div class="graph-h">${viewTabs()}${seg(ranges, 'range', stats.range, 'Time range')}${scopes.length ? seg(scopes, 'sscope', stats.scope, 'Repositories') : ''}<span class="spacer"></span>${stats.loading && stats.data ? '<span class="muted">Updating…</span>' : ''}</div>`;
    const d = stats.data;
    let body;
    if (stats.error) body = `<div class="cf-note error">${esc(stats.error)}</div>`;
    else if (!d) body = '<div class="more-note">Collecting statistics…</div>';
    else {
      const range = stats.range === 'all' ? (d.firstCommit ? `since ${dateLabel(d.firstCommit)}` : 'all time') : stats.range === '3m' ? 'last 3 months' : 'last 12 months';
      const unit = d.unit === 'month' ? 'month' : 'week';
      body = `<div class="stats">
        <div class="tiles">
          ${tile('Lines of code', fmt(d.totalLines), `${fmt(d.totalFiles)} files at HEAD`)}
          ${tile('Commits', fmt(d.commits), range)}
          ${tile('Authors', fmt(d.authorCount), range)}
          ${tile('Lines changed', `<span class="add">+${fmt(d.added)}</span> <span class="del">−${fmt(d.deleted)}</span>`, range)}
        </div>
        <div class="sgrid">
          ${panel(`Commits per ${unit}`, range, chartBox('commits', commitsChart, d))}
          ${panel('Lines of code over time', 'running total of lines added − deleted', chartBox('lines', linesChart, d))}
          ${d.repos ? panel('Repositories', range, reposTable(d), 'wide') : ''}
          ${panel('Authors', range, authorsTable(d), 'wide')}
          ${panel('Languages', 'lines of code at HEAD', languagesList(d))}
          ${panel('Activity', `commits by weekday and hour, ${range}`, chartBox('heatmap', heatmapChart, d))}
          ${panel('Most changed files', `top ${d.churn.length} by commits, ${range}`, churnTable(d), 'wide')}
        </div>
        <div class="more-note">Current branch history, merge commits excluded. Lockfiles and generated files are left out of line counts (setting: canopy.stats.exclude).${d.truncated ? ' Only the most recent commits were read (setting: canopy.stats.maxCommits).' : ''}</div>
      </div>`;
    }
    return `<section class="card graph" aria-label="Repository statistics">${head}<div class="rows stats-scroll">${body}</div></section>`;
  }

  /** Requests stats when the Stats view is shown and the repo, HEAD, range or scope changed. */
  function ensureStats(force = false) {
    if (view !== 'stats' || !state) return;
    const head = state.graph.rows.find((r) => r.head);
    const key = JSON.stringify([state.repo.root, head ? head.hash : '', stats.range, stats.scope]);
    if (!force && key === stats.key) return;
    stats.key = key;
    stats.loading = true;
    stats.error = null;
    post({ type: 'stats', range: stats.range, scope: stats.scope });
  }

  /** Re-renders once if a chart's container width differs from the width it was drawn at. */
  function measureCharts() {
    let changed = false;
    for (const el of /** @type {HTMLElement[]} */ ([...app.querySelectorAll('.chart[data-chart]')])) {
      const name = el.dataset.chart || '';
      const w = Math.floor(el.clientWidth);
      if (w > 0 && Math.abs(w - (chartW[name] || 0)) > 4) {
        chartW[name] = w;
        changed = true;
      }
    }
    return changed;
  }

  function contextMenu() {
    const c = /** @type {NonNullable<typeof ctx>} */ (ctx);
    const short = c.sha.slice(0, 8);
    const current = state.repo.branchLabel;
    const branchRefs = c.refs.filter((r) => r.type === 'local' || r.type === 'remote');
    const target = branchRefs[0]?.name || short;
    const item = (label, action, extra = '', danger = false) => `<button class="mi${danger ? ' danger' : ''}" role="menuitem" data-commit="${action}" ${extra}>${esc(label)}</button>`;
    return `<div class="menu fixed" id="ctx" role="menu">
      <div class="h nocase">Commit ${esc(short)}</div>
      ${branchRefs.map((r) => item(`Checkout ${r.name}`, 'checkoutRef', `data-ref="${esc(r.name)}"`)).join('')}
      ${item('Checkout (detached)…', 'checkout')}
      ${item('Create Branch Here…', 'branch')}
      ${item('Create Tag Here…', 'tag')}
      <div class="sep"></div>
      ${item(`Cherry-Pick onto ${current}`, 'cherryPick')}
      ${item('Revert Commit', 'revert')}
      ${item(`Merge ${target} into ${current}`, 'merge', branchRefs[0] ? `data-ref="${esc(target)}"` : '')}
      ${item(`Rebase ${current} onto ${target}`, 'rebase', branchRefs[0] ? `data-ref="${esc(target)}"` : '')}
      ${item('Interactive Rebase from Here…', 'rebaseInteractive')}
      <div class="sep"></div>
      ${item(`Reset ${current} Here (Soft)`, 'resetSoft')}
      ${item(`Reset ${current} Here (Mixed)`, 'resetMixed')}
      ${item(`Reset ${current} Here (Hard)…`, 'resetHard', '', true)}
      <div class="sep"></div>
      ${item('Compare with Working Tree…', 'compare')}
      ${item('Copy SHA', 'copy')}
    </div>`;
  }

  function positionContextMenu() {
    const el = /** @type {HTMLElement|null} */ (document.getElementById('ctx'));
    if (!el || !ctx) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(ctx.x, window.innerWidth - w - 4)) + 'px';
    el.style.top = Math.max(4, Math.min(ctx.y, window.innerHeight - h - 4)) + 'px';
    /** @type {HTMLElement|null} */ (el.querySelector('.mi'))?.focus();
  }

  function captureFocus() {
    const a = /** @type {HTMLElement|null} */ (document.activeElement);
    if (!a || a === document.body) return null;
    if (a.id === 'msg') return { id: 'msg', start: /** @type {HTMLTextAreaElement} */ (a).selectionStart, end: /** @type {HTMLTextAreaElement} */ (a).selectionEnd };
    return null;
  }
  function restoreFocus(f) {
    if (!f) return;
    const el = /** @type {HTMLTextAreaElement|null} */ (document.getElementById(f.id));
    if (el) {
      el.focus();
      el.setSelectionRange(f.start, f.end);
    }
  }

  // --- events --------------------------------------------------------------------

  function closeMenus() {
    const had = openMenu || ctx;
    openMenu = null;
    ctx = null;
    if (had) render();
  }

  function commit(mode) {
    const r = state.repo;
    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('msg'));
    const message = ta ? ta.value : drafts[r.root] || '';
    post({ type: 'commit', message, mode });
  }

  app.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const el = /** @type {HTMLElement|null} */ (t.closest('[data-menu],[data-run],[data-act],[data-scope],[data-commit],[data-checkout],[data-view],[data-range],[data-sscope],[data-sort],[data-open-path],.row'));
    if (!el) return closeMenus();
    if (el.dataset.checkout !== undefined) {
      const name = el.dataset.checkout;
      openMenu = null;
      render();
      if (!el.classList.contains('current')) post({ type: 'checkoutBranch', name, remote: el.dataset.remote === '1' });
      return;
    }
    if (el.dataset.menu) {
      openMenu = openMenu === el.dataset.menu ? null : el.dataset.menu;
      ctx = null;
      render();
      return;
    }
    if (el.dataset.run) {
      const id = el.dataset.run;
      openMenu = null;
      render();
      if (id.startsWith('c:')) commit(id.slice(2));
      else post({ type: 'cmd', id });
      return;
    }
    if (el.dataset.commit && ctx) {
      post({ type: 'commitAction', action: el.dataset.commit, sha: ctx.sha, ref: el.dataset.ref });
      ctx = null;
      render();
      return;
    }
    if (el.dataset.scope) {
      post({ type: 'scope', scope: el.dataset.scope });
      return;
    }
    if (el.dataset.view) {
      view = ['stats', 'profiles'].includes(el.dataset.view) ? el.dataset.view : 'graph';
      openMenu = null;
      ctx = null;
      persist();
      render();
      ensureStats();
      return;
    }
    if (el.dataset.range || el.dataset.sscope) {
      if (el.dataset.range) stats.range = el.dataset.range;
      if (el.dataset.sscope) stats.scope = el.dataset.sscope;
      persist();
      ensureStats();
      render();
      return;
    }
    if (el.dataset.sort) {
      stats.sort = el.dataset.sort;
      render();
      return;
    }
    if (el.dataset.openPath) {
      post({ type: 'open', path: el.dataset.openPath, mode: 'file' });
      return;
    }
    if (el.classList.contains('row')) {
      const sha = el.dataset.sha || '';
      openMenu = null;
      ctx = null;
      selectedSha = selectedSha === sha ? null : sha;
      if (selectedSha && sha !== '*' && !Array.isArray(commitFiles[sha])) {
        commitFiles[sha] = 'loading';
        post({ type: 'commitFiles', sha });
      }
      revealFiles = !!selectedSha;
      render();
      return;
    }
    const act = el.dataset.act;
    const path = el.dataset.path;
    closeMenus();
    switch (act) {
      case 'refresh': return post({ type: 'refresh' });
      case 'open': return post({ type: 'open', path, staged: el.dataset.staged === 'true', mode: 'diff' });
      case 'open-file': return post({ type: 'open', path, mode: 'file' });
      case 'commit-file': return post({ type: 'openCommitFile', sha: el.dataset.sha, path, origPath: el.dataset.orig, status: el.dataset.status });
      case 'mergeEditor': return post({ type: 'mergeEditor', path });
      case 'stage': return post({ type: 'stage', paths: [path] });
      case 'unstage': return post({ type: 'unstage', paths: [path] });
      case 'discard': return post({ type: 'discard', paths: [path] });
      case 'stage-all': return post({ type: 'stage', paths: [] });
      case 'unstage-all': return post({ type: 'unstage', paths: [] });
      case 'discard-all': return post({ type: 'discard', paths: [] });
      case 'commit': return commit('commit');
    }
  });

  app.addEventListener('contextmenu', (e) => {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.row'));
    if (!row || !row.dataset.sha || row.dataset.sha === '*') return;
    e.preventDefault();
    const sha = row.dataset.sha;
    const r = state.graph.rows.find((x) => x.hash === sha);
    openMenu = null;
    ctx = { sha, refs: r ? r.refs : [], x: e.clientX, y: e.clientY };
    render();
  });

  app.addEventListener('input', (e) => {
    const t = /** @type {HTMLTextAreaElement} */ (e.target);
    if (t.id === 'msg' && state) {
      drafts[state.repo.root] = t.value;
      persist();
    }
  });

  app.addEventListener('keydown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.id === 'msg' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit('commit');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
    const menu = /** @type {HTMLElement|null} */ (document.activeElement?.closest('.menu') ?? null);
    if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('.mi')]);
      const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      e.preventDefault();
    }
  });

  window.addEventListener('blur', () => closeMenus());

  // Hover tooltip for chart marks and rows carrying data-tip (newline = &#10;).
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipEl = null;
  app.addEventListener('mousemove', (e) => {
    const el = /** @type {HTMLElement|null} */ (/** @type {Element} */ (e.target).closest('[data-tip]'));
    if (!el) {
      tipEl = null;
      tip.classList.remove('on');
      return;
    }
    if (el !== tipEl) {
      tipEl = el;
      tip.textContent = el.getAttribute('data-tip') || '';
      tip.classList.add('on');
    }
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > window.innerWidth - 4) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 4) y = e.clientY - h - 14;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, y) + 'px';
  });
  app.addEventListener('mouseleave', () => {
    tipEl = null;
    tip.classList.remove('on');
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (view === 'stats' && stats.data && measureCharts()) render();
    }, 120);
  });

  function applyColors(c) {
    if (!c) return;
    const root = document.documentElement.style;
    root.setProperty('--branch-local', c.local);
    root.setProperty('--branch-remote', c.remote);
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      applyColors(m.colors);
      if (state && state.repo.root !== m.repo.root) {
        openMenu = null;
        ctx = null;
        selectedSha = null;
        commitFiles = {};
        stats.data = null;
        stats.owners = null;
        stats.folder = null;
        stats.key = '';
      }
      state = m;
      ensureStats();
      render();
    } else if (m.type === 'commitFiles' && state && m.root === state.repo.root) {
      commitFiles[m.sha] = m.error ? { error: m.error } : m.files;
      if (selectedSha === m.sha) {
        revealFiles = true;
        render();
      }
    } else if (m.type === 'stats' && state && m.root === state.repo.root) {
      stats.loading = false;
      stats.folder = m.folder;
      stats.scope = m.scope;
      stats.error = m.error || null;
      if (m.data) stats.data = m.data;
      stats.owners = m.ownership || (m.scope === 'repo' ? stats.owners : null);
      if (view === 'stats') render();
    } else if (m.type === 'profiles') {
      profilesView?.onMessage(m.msg);
    } else if (m.type === 'statsOwners' && state && m.root === state.repo.root) {
      stats.owners = m.ownership;
      if (view === 'stats' && stats.scope === 'repo') render();
    } else if (m.type === 'committed' && state) {
      drafts[state.repo.root] = '';
      persist();
      const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('msg'));
      if (ta) ta.value = '';
    } else if (m.type === 'switching') {
      app.className = 'loading';
      app.textContent = `Loading ${m.name}…`;
    }
  });

  window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message) + ' @' + e.lineno }));
  post({ type: 'ready' });
})();

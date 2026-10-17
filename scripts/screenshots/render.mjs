// Renders README screenshots from the demo workspace (scripts/make-demo.mjs) with CANOPY's real
// webview code, inside an editor-style frame. GitLab pipeline / merge request data is made up.
// Usage: npm run compile && node scripts/make-demo.mjs demo-canopy && node scripts/screenshots/render.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = (m) => require(path.join(root, 'out/src', m));
const { parseStatusV2, parseLog, parseRemotes, parseBranches, changedPathCount, LOG_FORMAT, BRANCH_FORMAT } = out('git/parse.js');
const COLORS = { specialNames: ['main'], special: '#b180d7', other: '#e535ab', local: '#b180d7', remote: '#3794ff' };
const { layoutGraph } = out('git/graph.js');
const { compareRepos, attentionOf, needsAttention } = out('model/types.js');
const { compileQuery } = out('model/query.js');
const { pipelineSymbol } = out('forge/instances.js');

const demo = path.resolve(process.argv[2] ?? path.join(root, 'demo-canopy'));
const build = path.join(root, '.screenshots');
const images = path.join(root, 'images');
fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(images, { recursive: true });
const workspace = JSON.parse(fs.readFileSync(path.join(demo, 'demo.code-workspace'), 'utf8'));
const layout = workspace.settings['canopy.layout'];

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });

// Made-up hosted-Git state per demo repository: Platform and Data on GitLab, Frontend on GitHub.
const FORGE = {
  'api-gateway': { provider: 'gitlab', pipeline: { id: 5121, status: 'success' } },
  'auth-service': { provider: 'gitlab', pipeline: { id: 5133, status: 'failed' } },
  billing: { provider: 'gitlab', pipeline: { id: 5140, status: 'running' } },
  notifications: { provider: 'gitlab', pipeline: { id: 5098, status: 'success' } },
  'web-app': { provider: 'github', pipeline: { id: 9137, status: 'running' }, mr: { iid: 128, title: 'Redesign checkout into three steps', draft: false, hasConflicts: false, approved: false, approvedBy: [], targetBranch: 'main' } },
  'design-system': { provider: 'github', pipeline: { id: 9110, status: 'success' } },
  'marketing-site': { provider: 'github' },
  'mobile-app': { provider: 'github' },
  'analytics-pipeline': { provider: 'gitlab', pipeline: { id: 5102, status: 'success' } },
  'warehouse-models': { provider: 'gitlab', pipeline: { id: 5095, status: 'success' }, mr: { iid: 41, title: 'Release 2026.10', draft: true, hasConflicts: false, approved: false, approvalsLeft: 2, targetBranch: 'main' } },
  'infra-terraform': { provider: 'gitlab', pipeline: { id: 5089, status: 'success' } }
};
const PREFIX = { gitlab: '!', github: '#' };

// --- read the demo repositories ------------------------------------------------

const repos = fs
  .readdirSync(path.join(demo, 'src'))
  .sort()
  .map((name) => {
    const dir = path.join(demo, 'src', name);
    const status = parseStatusV2(git(dir, ['status', '--porcelain=v2', '--branch', '-z']));
    const gitDir = path.join(dir, '.git');
    const op = fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply')) ? 'rebase' : fs.existsSync(path.join(gitDir, 'MERGE_HEAD')) ? 'merge' : null;
    const remotes = parseRemotes(git(dir, ['remote', '-v']));
    const last = Number(git(dir, ['log', '-1', '--format=%ct']).trim());
    const forge = FORGE[name] ?? {};
    const facts = {
      key: `src/${name}`, name, root: `~/work/demo/src/${name}`, branch: status.branch, detached: status.detached, headShort: status.oid?.slice(0, 8) ?? null,
      upstream: status.upstream, ahead: status.ahead, behind: status.behind, changed: changedPathCount(status), staged: status.staged.length,
      conflicts: status.conflicts.length, operation: op, lastCommitTime: last, remoteUrls: [...remotes.values()], folderNames: [], error: null, loaded: true,
      ci: forge.pipeline?.status ?? null, mr: forge.mr ? (forge.mr.draft ? 'draft' : 'open') : null, mrConflicts: false
    };
    return { name, dir, status, op, facts, forge };
  });
const byName = (n) => repos.find((r) => r.name === n);

function branchLabel(r) {
  return r.status.branch ?? (r.status.detached ? `${r.status.oid.slice(0, 8)} (detached)` : 'no commits');
}

// --- shared page bits ---------------------------------------------------------------

const VARS = `:root{--vscode-font-family:'Segoe UI',system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,'Courier New',monospace;--vscode-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#2b2b2b;--vscode-sideBar-background:#181818;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#026ec1;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;--vscode-button-secondaryHoverBackground:#3c3c3c;--vscode-list-hoverBackground:#2a2d2e;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#3c3c3c;--vscode-focusBorder:#0078d4;--vscode-charts-blue:#3794ff;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-green:#89d185;--vscode-charts-red:#f14c4c;--vscode-charts-yellow:#cca700;--vscode-menu-background:#1f1f1f;--vscode-menu-border:#454545;--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-errorForeground:#f85149;--vscode-list-inactiveSelectionBackground:#37373d;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-dropdown-background:#313131;--vscode-dropdown-foreground:#cccccc;--vscode-dropdown-border:#3c3c3c;--vscode-textBlockQuote-background:#2b2b2b;--vscode-editorWidget-background:#202020;--vscode-widget-shadow:rgba(0,0,0,.6);--vscode-textLink-foreground:#4daafc;--vscode-inputValidation-warningBackground:#352a05;--vscode-inputValidation-warningBorder:#b89500;--vscode-gitDecoration-modifiedResourceForeground:#e2c08d;--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-untrackedResourceForeground:#73c991;--vscode-gitDecoration-conflictingResourceForeground:#e4676b;--vscode-gitDecoration-deletedResourceForeground:#c74e39}`;
const css = pathToFileURL(path.join(root, 'media/webview.css')).href;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function webviewPage(file, script, state, after = '') {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${VARS}</style><link rel="stylesheet" href="${css}"></head><body><div id="app"></div>
<script>window.acquireVsCodeApi=()=>({postMessage(){},getState(){return null},setState(){}});</script>
<script src="${pathToFileURL(path.join(root, 'media', script)).href}"></script>
<script>window.postMessage(${JSON.stringify(state)},'*');${after}</script></body></html>`;
  fs.writeFileSync(path.join(build, file), html);
  return file;
}

function detailState(name, scope = 'all') {
  const r = byName(name);
  const commits = parseLog(git(r.dir, ['log', '--topo-order', '-n120', `--format=${LOG_FORMAT}`, '--exclude=refs/stash', '--all', '--']), ['origin']);
  if (r.facts.changed && r.status.oid) commits.unshift({ hash: '*', parents: [r.status.oid], refs: [], author: '', time: 0, subject: '' });
  const { rows, width } = layoutGraph(commits);
  const f = r.forge;
  const provider = f.provider ?? 'gitlab';
  const forge = {
    kind: 'connected', provider, readOnly: false, host: provider === 'github' ? 'github.com' : 'gitlab.example.com', project: { id: 1, webUrl: '#', defaultBranch: 'main' },
    pipeline: f.pipeline ? { ...f.pipeline, sha: r.status.oid, webUrl: '#', ref: r.status.branch, isHead: true } : undefined,
    mr: f.mr ? { ...f.mr, webUrl: '#', status: '' } : undefined, loading: false
  };
  const folder = layout.folders.find((x) => x.repos.includes(r.facts.key))?.name ?? 'Unsorted';
  return {
    type: 'state',
    scope,
    safetyStash: true,
    colors: COLORS,
    branches: (() => {
      const list = parseBranches(git(r.dir, ['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']));
      return { local: list.filter((b) => !b.remote).map((b) => ({ name: b.name, time: b.time, current: b.current, upstream: b.upstream ?? null })), remote: list.filter((b) => b.remote).map((b) => ({ name: b.name, time: b.time })) };
    })(),
    repo: {
      name, root: r.facts.root, crumb: `CANOPY  /  ${folder}`, branch: r.status.branch, branchLabel: branchLabel(r), detached: r.status.detached, upstream: r.status.upstream,
      ahead: r.status.ahead, behind: r.status.behind, operation: r.op, error: null, lastFetch: Date.now() - 4 * 60_000, fetching: false, remotes: ['origin'], stashCount: name === 'web-app' ? 1 : 0,
      staged: r.status.staged, unstaged: r.status.unstaged, conflicts: r.status.conflicts, forge
    },
    graph: {
      width, truncated: false,
      rows: commits.map((c, i) => ({ hash: c.hash, short: c.hash === '*' ? '' : c.hash.slice(0, 8), refs: c.refs, author: c.author.split(' ')[0], time: c.time, subject: c.subject, lane: rows[i].lane, lines: rows[i].lines, wip: c.hash === '*', head: c.hash === r.status.oid }))
    }
  };
}

// --- sidebar replica ------------------------------------------------------------------

const ICON = {
  repo: '<path d="M5 3h11v18H5zM5 17h11M8 3v14"/>',
  pull: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  push: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7c0 5 6 4 6 10M18 7c0 5-6 4-6 10"/>',
  warning: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>'
};
const ATT = {
  conflict: ['warning', '#e4676b'], error: ['warning', '#f85149'], diverged: ['fork', '#b180d7'], behind: ['pull', '#3794ff'],
  changes: ['repo', '#e2c08d'], ahead: ['push', '#89d185'], unpublished: ['repo', '#9d9d9d'], clean: ['repo', '#c5c5c5']
};
const svg = (name, color, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
const OP_LABEL = { rebase: 'rebasing', merge: 'merging' };

function badges(f) {
  const p = [];
  if (f.operation) p.push(OP_LABEL[f.operation]);
  if (f.conflicts) p.push(`⚠${f.conflicts}`);
  if (f.behind) p.push(`↓${f.behind}`);
  if (f.changed) p.push(`●${f.changed}`);
  if (f.ahead) p.push(`↑${f.ahead}`);
  return p.join(' ');
}

function repoRow(r, depth, { edit = false, hidden = false, selected = false } = {}) {
  const f = r.facts;
  const [icon, color] = ATT[attentionOf(f)];
  const forge = [r.forge.pipeline ? pipelineSymbol(r.forge.pipeline.status) : '', r.forge.mr ? `${PREFIX[r.forge.provider ?? 'gitlab']}${r.forge.mr.iid}${r.forge.mr.draft ? ' draft' : ''}` : ''].filter(Boolean).join(' ');
  const desc = [branchLabel(r), badges(f), forge, hidden ? '(hidden)' : ''].filter(Boolean).join('  ');
  return `<div class="row${selected ? ' sel' : ''}${hidden ? ' dim' : ''}" style="padding-left:${4 + depth * 16 + 20}px">
    ${edit ? `<span class="cb${hidden ? '' : ' on'}"></span>` : ''}${svg(icon, color)}<span class="label">${esc(f.name)}</span><span class="desc">${esc(desc)}</span></div>`;
}

function aggregate(list) {
  const s = (k) => list.reduce((n, r) => n + r.facts[k], 0);
  return [s('conflicts') ? `⚠${s('conflicts')}` : '', s('behind') ? `↓${s('behind')}` : '', s('changed') ? `●${s('changed')}` : '', s('ahead') ? `↑${s('ahead')}` : ''].filter(Boolean).join(' ');
}

function folderRow(name, list, depth, smart, edit, collapsed = false) {
  return `<div class="row" style="padding-left:${4 + depth * 16}px"><span class="tw${collapsed ? '' : ' open'}">${svg('chevron', '#c5c5c5', 14)}</span>${edit && !smart ? '<span class="cb on"></span>' : ''}${svg(smart ? 'filter' : 'folder', '#c5c5c5')}<span class="label">${esc(name)}</span><span class="desc">${esc(aggregate(list) || String(list.length))}</span></div>`;
}

function treeHtml({ edit = false, selected = 'web-app', hidden = [] } = {}) {
  const cmp = compareRepos('attention');
  const sort = (list) => list.sort((a, b) => cmp(a.facts, b.facts));
  let html = '';
  const visit = (folder, depth) => {
    let list;
    if (folder.query) {
      const pred = compileQuery(folder.query);
      list = sort(repos.filter((r) => pred(r.facts)));
    } else list = sort(folder.repos.map((k) => repos.find((r) => r.facts.key === k)).filter(Boolean));
    const all = [...list, ...folder.children.flatMap((c) => c.repos.map((k) => repos.find((r) => r.facts.key === k)).filter(Boolean))];
    html += folderRow(folder.name, all, depth, !!folder.query, edit);
    for (const c of folder.children) visit(c, depth + 1);
    for (const r of list) html += repoRow(r, depth + 1, { edit, hidden: hidden.includes(r.name), selected: r.name === selected && !folder.query });
  };
  for (const f of layout.folders) visit(f, 0);
  return html;
}

const SIDEBAR_CSS = `
.sidebar{background:#181818;color:#ccc;font:13px 'Segoe UI',system-ui,sans-serif;display:flex;flex-direction:column;border-right:1px solid #2b2b2b;overflow:hidden}
.sb-title{height:35px;display:flex;align-items:center;padding:0 8px 0 20px;font-size:11px;letter-spacing:.04em;color:#ccc}
.sb-head{height:22px;display:flex;align-items:center;gap:4px;padding:0 8px 0 4px;font-size:11px;font-weight:700;letter-spacing:.02em}
.sb-head .t{flex:1;display:flex;align-items:center;gap:2px}.sb-head .d{font-weight:400;color:#9d9d9d;margin-left:6px}
.tb{display:flex;gap:2px}.tb span{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:4px}
.msg{margin:4px 12px 6px 20px;padding:6px 8px;font-size:12px;color:#ccc;background:#252526;border-radius:3px}
.row{height:22px;display:flex;align-items:center;gap:6px;white-space:nowrap;padding-right:8px}
.row.sel{background:#37373d}.row.dim{opacity:.55}.row .label{flex:0 0 auto}.row .desc{color:#9d9d9d;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.tw{width:16px;flex:0 0 16px;display:flex;justify-content:center}.tw.open svg{transform:rotate(90deg)}
.cb{width:14px;height:14px;border:1px solid #6b6b6b;border-radius:3px;flex:0 0 auto;background:#313131;position:relative}
.cb.on{background:#0078d4;border-color:#0078d4}.cb.on::after{content:'';position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
`;

function sidebar({ edit = false, selected = 'web-app', hidden = [], width = 400 } = {}) {
  const vis = repos.filter((r) => !hidden.includes(r.name));
  const tb = (n) => `<span>${svg(n, '#c5c5c5', 15)}</span>`;
  return `<div class="sidebar" style="width:${width}px">
    <div class="sb-title">CANOPY</div>
    <div class="sb-head"><span class="t">${svg('chevron', '#c5c5c5', 14).replace('<svg', '<svg style="transform:rotate(90deg)"')} REPOSITORIES<span class="d">${vis.length} repos${hidden.length ? ` · ${hidden.length} hidden` : ''}</span></span>
      <span class="tb">${tb('pull')}${tb('filter')}${edit ? '<span>' + svg('check', '#c5c5c5', 15) + '</span>' : tb('folder')}${tb('repo')}</span></div>
    ${edit ? '<div class="msg">Editing layout: drag repos into folders, uncheck to hide. Click ✓ when done.</div>' : ''}
    <div class="tree">${treeHtml({ edit, selected, hidden })}</div>
  </div>`;
}

function windowPage(file, { iframe, tab, height = 820, width = 1480 }) {
  const vis = repos;
  const sum = (k) => vis.reduce((n, r) => n + r.facts[k], 0);
  const attention = vis.filter((r) => needsAttention(r.facts)).length;
  const conflicts = vis.filter((r) => r.facts.conflicts || r.facts.operation).length;
  const act = (n, on) => `<div class="ai${on ? ' on' : ''}">${n}</div>`;
  const canopyIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V7M12 17c0-3-6-2.5-6-6M12 15c0-2.5 6-2 6-4"/><circle cx="6" cy="9" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="18" cy="9" r="2"/></svg>`;
  const files = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#868686" stroke-width="1.5"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>`;
  const search = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#868686" stroke-width="1.5"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>`;
  const scm = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#868686" stroke-width="1.5"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/></svg>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#111}*{box-sizing:border-box}
.win{width:${width}px;height:${height}px;display:flex;flex-direction:column;background:#1f1f1f;font:13px 'Segoe UI',system-ui,sans-serif;color:#ccc;overflow:hidden}
.title{height:32px;flex:0 0 32px;background:#1f1f1f;border-bottom:1px solid #2b2b2b;display:flex;align-items:center;justify-content:center;font-size:12px;color:#9d9d9d;position:relative}
.dots{position:absolute;left:12px;display:flex;gap:7px}.dots i{width:11px;height:11px;border-radius:6px;background:#3c3c3c;display:block}
.main{flex:1;display:flex;min-height:0}
.activity{width:48px;flex:0 0 48px;background:#181818;border-right:1px solid #2b2b2b;display:flex;flex-direction:column;align-items:center;padding-top:6px;gap:4px}
.ai{width:48px;height:46px;display:flex;align-items:center;justify-content:center;position:relative}.ai.on{box-shadow:inset 2px 0 0 #0078d4}
.badge{position:absolute;right:7px;bottom:7px;min-width:16px;height:16px;border-radius:8px;background:#0078d4;color:#fff;font-size:9px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 4px}
.editor{flex:1;display:flex;flex-direction:column;min-width:0}
.tabs{height:35px;flex:0 0 35px;background:#181818;display:flex;border-bottom:1px solid #2b2b2b}
.tab{display:flex;align-items:center;gap:6px;padding:0 14px;background:#1f1f1f;border-top:1px solid #0078d4;border-right:1px solid #2b2b2b;font-size:13px;color:#fff}
.tab.off{background:#181818;border-top-color:transparent;color:#9d9d9d}
iframe{flex:1;border:0;width:100%;background:#1f1f1f}
.status{height:22px;flex:0 0 22px;background:#181818;border-top:1px solid #2b2b2b;display:flex;align-items:center;gap:14px;padding:0 10px;font-size:12px;color:#ccc}
.status .w{background:#5a4a00;padding:0 6px;height:22px;display:flex;align-items:center}
${SIDEBAR_CSS}
</style></head><body><div class="win">
<div class="title"><span class="dots"><i></i><i></i><i></i></span>demo.code-workspace</div>
<div class="main">
  <div class="activity">${act(files)}${act(search)}${act(scm)}<div class="ai on">${canopyIcon}<span class="badge">${attention}</span></div></div>
  ${sidebar({ selected: tab.repo })}
  <div class="editor"><div class="tabs"><div class="tab">${canopyIcon.replace(/#fff/g, '#c5c5c5').replace('width="24" height="24"', 'width="14" height="14"')} CANOPY · ${esc(tab.repo)}</div><div class="tab off">README.md</div></div>
  <iframe src="${iframe}"></iframe></div>
</div>
<div class="status"><span>⎇ ${esc(branchLabel(byName(tab.repo)))}</span><span class="w">⚠${conflicts} ↓${sum('behind')} ●${sum('changed')} ↑${sum('ahead')}</span><span>▤ Platform on-call</span><span style="margin-left:auto">Ln 1, Col 1</span></div>
</div></body></html>`;
  fs.writeFileSync(path.join(build, file), html);
  return file;
}

function sidebarPage(file, opts) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#181818}*{box-sizing:border-box}${SIDEBAR_CSS}.sidebar{height:100vh;border-right:0}</style></head><body>${sidebar(opts)}</body></html>`;
  fs.writeFileSync(path.join(build, file), html);
  return file;
}

// --- profiles page state ----------------------------------------------------------

function profilesState() {
  const rows = repos.map((r) => {
    const folder = layout.folders.flatMap((f) => [f, ...f.children]).find((f) => f.repos.includes(r.facts.key))?.name ?? '';
    const branches = git(r.dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).split('\n').map((s) => s.trim().replace(/^origin\//, '')).filter((s) => s && s !== 'origin' && s !== 'HEAD');
    const branch = r.status.branch ?? 'main';
    return { include: ['api-gateway', 'auth-service', 'billing', 'notifications', 'web-app', 'design-system'].includes(r.name), name: r.name, remote: (FORGE[r.name]?.provider === 'github' ? `https://github.com/acme/${r.name}.git` : `https://gitlab.example.com/acme/${r.name}.git`), branch, path: `src/${r.name}`, folder, localRoot: r.facts.root, branches: [...new Set([branch, ...branches])] };
  });
  return {
    type: 'state',
    settingsLocation: 'demo.code-workspace',
    colors: COLORS,
    profiles: [
      { id: 'p1', name: 'Platform on-call', mode: 'track', count: 6, saved: '2h ago', active: true, source: 'workspace', location: 'demo.code-workspace' },
      { id: 'file:1', name: 'Q4 release', mode: 'pin', count: 9, saved: '3d ago', active: false, source: 'file', location: 'release/q4.canopy-profile.json' },
      { id: 'file:2', name: 'New starter setup', mode: 'track', count: 12, saved: '2w ago', active: false, source: 'file', location: 'onboarding.canopy-profile.json', createdBy: 'priya' }
    ],
    editor: { id: 'p1', name: 'Platform on-call', mode: 'track', source: 'profile', baseFolder: '~/work/demo', onApply: { cloneMissing: true, stashChanges: true, pullAfter: true, recreateLayout: false }, rows },
    preview: ''
  };
}

// --- write pages and capture ------------------------------------------------------

const shots = [
  { name: 'overview', page: windowPage('overview.html', { iframe: webviewPage('detail-web-app.html', 'detail.js', detailState('web-app')), tab: { repo: 'web-app' } }), w: 1480, h: 820 },
  { name: 'conflict', page: webviewPage('detail-billing.html', 'detail.js', detailState('billing'), `setTimeout(()=>{const r=[...document.querySelectorAll('.row')].find(x=>x.textContent.includes('Email invoices'));if(r){const b=r.getBoundingClientRect();r.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:b.left+380,clientY:b.top+14}));}},300);`), w: 1180, h: 780 },
  { name: 'gitlab', page: webviewPage('detail-auth.html', 'detail.js', detailState('auth-service'), `setTimeout(()=>document.querySelector('[data-menu=forge]').click(),300);`), w: 1180, h: 560 },
  { name: 'profiles', page: webviewPage('profiles.html', 'profiles.js', profilesState()), w: 1380, h: 860 },
  { name: 'branch-menu', dir: build, page: webviewPage('detail-branch.html', 'detail.js', detailState('web-app'), `setTimeout(()=>document.querySelector('[data-menu=branch]').click(),300);`), w: 1180, h: 760 },
  { name: 'edit-layout', page: sidebarPage('edit.html', { edit: true, selected: '', hidden: ['dev-scripts', 'marketing-site'], width: 460 }), w: 460, h: 560 }
];

const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!edge) throw new Error('Needs Microsoft Edge or Chrome for headless screenshots.');
for (const s of shots) {
  const outFile = path.join(s.dir ?? images, `${s.name}.png`);
  execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', `--window-size=${s.w},${s.h}`, '--force-device-scale-factor=2', `--user-data-dir=${path.join(build, 'profile')}`, '--virtual-time-budget=4000', `--screenshot=${outFile}`, pathToFileURL(path.join(build, s.page)).href], { stdio: 'ignore' });
  console.log(`${s.name}.png  ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
}

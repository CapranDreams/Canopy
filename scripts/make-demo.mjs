// Builds a demo workspace of fictional repositories for trying CANOPY and for README screenshots.
// Usage: node scripts/make-demo.mjs [targetDir]   (default: ./demo-canopy)
// Everything here is made up: the "Acme" company, people, repositories and commit messages.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? 'demo-canopy');
if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
const remotes = path.join(target, '.remotes');
const src = path.join(target, 'src');
fs.mkdirSync(remotes, { recursive: true });
fs.mkdirSync(src, { recursive: true });

const PEOPLE = {
  alex: ['Alex Rivera', 'alex@example.com'],
  priya: ['Priya Nair', 'priya@example.com'],
  sam: ['Sam Okafor', 'sam@example.com'],
  jordan: ['Jordan Lee', 'jordan@example.com'],
  mei: ['Mei Chen', 'mei@example.com']
};
const NOW = Date.now();

function git(cwd, args, who = 'alex', daysAgo = 0) {
  const [name, email] = PEOPLE[who];
  const date = new Date(NOW - daysAgo * 86400_000).toISOString();
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  }).toString();
}

function write(dir, file, text) {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function commit(dir, files, msg, who, daysAgo) {
  for (const [f, t] of Object.entries(files)) write(dir, f, t);
  git(dir, ['add', '-A'], who, daysAgo);
  git(dir, ['commit', '-q', '-m', msg], who, daysAgo);
}

/** Creates the bare remote and a working clone with an initial history on main. */
function repo(name, history) {
  const bare = path.join(remotes, `${name}.git`);
  git(target, ['init', '-q', '--bare', '-b', 'main', bare]);
  const dir = path.join(src, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['remote', 'add', 'origin', bare]);
  let day = history.length * 3 + 4;
  commit(dir, { 'README.md': `# ${name}\n`, '.gitignore': 'node_modules/\ndist/\n' }, 'Initial commit', 'alex', day);
  for (const [msg, who, files] of history) {
    day -= 3;
    commit(dir, files ?? { [`notes/${msg.length}.md`]: msg + '\n' }, msg, who, day);
  }
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  return { dir, bare };
}

/** Adds commits to the remote from a throwaway clone, so the working copy falls behind. */
function remoteCommits(bare, branch, commits) {
  const tmp = path.join(target, '.tmp-' + path.basename(bare));
  git(target, ['clone', '-q', '-b', branch, bare, tmp]);
  for (const [msg, who, files, daysAgo] of commits) commit(tmp, files ?? { [`notes/r${msg.length}.md`]: msg + '\n' }, msg, who, daysAgo ?? 0.5);
  git(tmp, ['push', '-q']);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function featureMerge(dir, branch, commits, mergeMsg, daysAgo) {
  git(dir, ['switch', '-q', '-c', branch]);
  for (const [msg, who, files, d] of commits) commit(dir, files ?? { [`src/${branch.split('/').pop()}-${msg.length}.ts`]: `// ${msg}\n` }, msg, who, d);
  git(dir, ['switch', '-q', 'main']);
  git(dir, ['merge', '-q', '--no-ff', '-m', mergeMsg, branch], 'priya', daysAgo);
  git(dir, ['branch', '-q', '-d', branch]);
}

// --- Platform ---------------------------------------------------------------

{
  const { dir, bare } = repo('api-gateway', [
    ['Add request ID middleware', 'sam'],
    ['Route /v2/orders to the orders service', 'alex'],
    ['Rate limit anonymous clients', 'priya']
  ]);
  featureMerge(dir, 'feature/health-checks', [['Add /healthz endpoint', 'sam', null, 6], ['Report dependency status in /healthz', 'sam', null, 5]], "Merge branch 'feature/health-checks'", 4);
  git(dir, ['tag', 'v2.4.0']);
  git(dir, ['push', '-q', '--tags', 'origin', 'main']);
  remoteCommits(bare, 'main', [['Upgrade HTTP client to 5.2', 'jordan', null, 1.2], ['Add circuit breaker to the payments route', 'priya', null, 0.8], ['Log upstream latency per route', 'sam', null, 0.3]]);
  git(dir, ['fetch', '-q']);
}

{
  const { dir } = repo('auth-service', [
    ['Hash passwords with argon2id', 'mei'],
    ['Add session expiry setting', 'alex'],
    ['Support SSO via OpenID Connect', 'mei']
  ]);
  git(dir, ['switch', '-q', '-c', 'feature/passkeys']);
  commit(dir, { 'src/webauthn/register.ts': '// register a passkey\n' }, 'Add passkey registration flow', 'mei', 2);
  git(dir, ['push', '-q', '-u', 'origin', 'feature/passkeys']);
  commit(dir, { 'src/webauthn/login.ts': '// sign in with a passkey\n' }, 'Sign in with a passkey', 'mei', 1);
  commit(dir, { 'src/webauthn/recovery.ts': '// recovery codes\n' }, 'Offer recovery codes after enrolment', 'mei', 0.4);
  write(dir, 'src/webauthn/login.ts', '// sign in with a passkey\n// TODO: device name\n');
  write(dir, 'src/config.ts', 'export const PASSKEYS = true;\n');
  write(dir, 'docs/passkeys.md', '# Passkeys\n');
}

{
  const { dir, bare } = repo('billing', [
    ['Generate monthly invoices', 'jordan', { 'src/invoice.ts': 'export const round = (n: number) => Math.round(n);\n' }],
    ['Add tax rules for EU customers', 'priya'],
    ['Email invoices as PDF', 'jordan']
  ]);
  git(dir, ['switch', '-q', '-c', 'fix/invoice-rounding']);
  commit(dir, { 'src/invoice.ts': 'export const round = (n: number) => Math.round(n * 100) / 100;\n' }, 'Round invoice totals to cents', 'jordan', 1);
  commit(dir, { 'src/invoice.test.ts': '// rounding tests\n' }, 'Test rounding of invoice totals', 'jordan', 0.9);
  remoteCommits(bare, 'main', [['Use banker’s rounding for totals', 'priya', { 'src/invoice.ts': 'export const round = (n: number) => bankersRound(n, 2);\n' }, 0.6]]);
  git(dir, ['fetch', '-q']);
  try {
    git(dir, ['rebase', 'origin/main'], 'jordan', 0.1);
  } catch {
    // Leave the rebase stopped on the conflict on purpose.
  }
}

{
  const { dir } = repo('notifications', [
    ['Send email through the queue', 'sam'],
    ['Add SMS provider', 'alex'],
    ['Batch digests hourly', 'sam'],
    ['Respect quiet hours', 'priya']
  ]);
  featureMerge(dir, 'feature/push', [['Add web push channel', 'alex', null, 3], ['Store push subscriptions', 'alex', null, 2.5]], "Merge branch 'feature/push'", 2);
  git(dir, ['push', '-q', 'origin', 'main']);
}

// --- Frontend ---------------------------------------------------------------

{
  const { dir, bare } = repo('web-app', [
    ['Set up routing', 'priya'],
    ['Add product listing page', 'alex'],
    ['Cart drawer', 'priya'],
    ['Dark mode', 'mei']
  ]);
  featureMerge(dir, 'feature/search', [['Instant search box', 'alex', null, 6], ['Highlight matches', 'alex', null, 5.5]], "Merge branch 'feature/search'", 5);
  git(dir, ['push', '-q', 'origin', 'main']);
  git(dir, ['switch', '-q', '-c', 'feature/checkout-redesign']);
  commit(dir, { 'src/checkout/Steps.tsx': '// steps\n' }, 'Split checkout into three steps', 'priya', 3);
  git(dir, ['push', '-q', '-u', 'origin', 'feature/checkout-redesign']);
  remoteCommits(bare, 'feature/checkout-redesign', [['Address review comments on the address form', 'mei', { 'src/checkout/Address.tsx': '// address\n' }, 1]]);
  commit(dir, { 'src/checkout/Payment.tsx': '// payment\n' }, 'New payment step with saved cards', 'priya', 0.7);
  commit(dir, { 'src/checkout/Review.tsx': '// review\n' }, 'Order review step', 'priya', 0.2);
  git(dir, ['fetch', '-q']);
  write(dir, 'src/checkout/Steps.tsx', '// steps\n// progress bar\n');
}

{
  const { dir } = repo('design-system', [
    ['Button and link components', 'mei'],
    ['Color tokens', 'mei'],
    ['Form inputs', 'priya']
  ]);
  git(dir, ['tag', 'v1.8.0']);
  git(dir, ['push', '-q', '--tags', 'origin', 'main']);
  write(dir, 'src/tokens.css', ':root { --accent: #2f7d6d; }\n');
  git(dir, ['add', 'src/tokens.css']);
  write(dir, 'src/Tooltip.tsx', '// tooltip\n');
}

{
  repo('marketing-site', [
    ['Landing page', 'jordan'],
    ['Pricing page', 'jordan']
  ]);
}

{
  const { dir } = repo('mobile-app', [
    ['App shell', 'alex'],
    ['Sign-in screen', 'alex'],
    ['Order history', 'sam']
  ]);
  git(dir, ['switch', '-q', '-c', 'feature/offline-mode']);
  commit(dir, { 'src/sync/queue.ts': '// offline queue\n' }, 'Queue writes while offline', 'alex', 0.5);
}

// --- Data -------------------------------------------------------------------

{
  const { dir, bare } = repo('analytics-pipeline', [
    ['Ingest page views', 'sam'],
    ['Sessionize events', 'jordan'],
    ['Daily active users job', 'sam']
  ]);
  remoteCommits(bare, 'main', [
    ['Backfill job for March', 'jordan', null, 2],
    ['Partition events by day', 'sam', null, 1.5],
    ['Drop bot traffic', 'jordan', null, 1],
    ['Add funnel metrics', 'sam', null, 0.6],
    ['Speed up sessionization', 'jordan', null, 0.2]
  ]);
  git(dir, ['fetch', '-q']);
}

{
  const { dir } = repo('warehouse-models', [
    ['Orders fact table', 'jordan'],
    ['Customer dimension', 'jordan'],
    ['Revenue by region view', 'priya']
  ]);
  git(dir, ['switch', '-q', '-c', 'release/2026.10']);
  commit(dir, { 'models/release.yml': 'version: 2026.10\n' }, 'Prepare 2026.10 release', 'jordan', 1);
  git(dir, ['tag', 'v2026.10.0']);
  git(dir, ['push', '-q', '-u', 'origin', 'release/2026.10', '--tags']);
}

// --- Tooling ----------------------------------------------------------------

{
  const { dir } = repo('infra-terraform', [
    ['VPC and subnets', 'sam'],
    ['Managed Postgres', 'sam'],
    ['CDN for static assets', 'alex']
  ]);
  write(dir, 'envs/staging/main.tf', '# scale web to 4\n');
}

{
  repo('dev-scripts', [
    ['Bootstrap script', 'alex'],
    ['Seed demo data', 'priya']
  ]);
}

// --- Workspace file with a ready-made layout -------------------------------

const k = (n) => `src/${n}`;
const workspace = {
  folders: [{ path: '.' }],
  settings: {
    'canopy.autoFetch.intervalMinutes': 0,
    'canopy.gitlab.promptToConnect': false,
    'canopy.scanDepth': 3,
    'canopy.layout': {
      version: 1,
      folders: [
        { id: 'attention', name: 'Needs attention', repos: [], children: [], query: 'is:conflict OR is:diverged OR pipeline:failed' },
        { id: 'platform', name: 'Platform', repos: [k('api-gateway'), k('auth-service'), k('billing'), k('notifications')], children: [] },
        { id: 'frontend', name: 'Frontend', repos: [k('web-app'), k('design-system'), k('marketing-site')], children: [{ id: 'mobile', name: 'Mobile', repos: [k('mobile-app')], children: [] }] },
        { id: 'data', name: 'Data', repos: [k('analytics-pipeline'), k('warehouse-models')], children: [] },
        { id: 'tooling', name: 'Tooling', repos: [k('infra-terraform'), k('dev-scripts')], children: [] }
      ],
      hidden: [],
      unsorted: []
    }
  }
};
fs.writeFileSync(path.join(target, 'demo.code-workspace'), JSON.stringify(workspace, null, 2) + '\n');
console.log(`Demo workspace ready: ${path.join(target, 'demo.code-workspace')}`);

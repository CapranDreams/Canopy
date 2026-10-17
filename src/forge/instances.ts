/** Which configured GitLab server (if any) hosts a remote. Pure, unit tested. */
import { remoteHostPath } from '../util/remote';

export interface GitLabInstance {
  /** Base URL, e.g. https://gitlab.com or https://git.example.com/gitlab */
  url: string;
  name?: string;
  /** Extra host names used in SSH remotes (when SSH runs on a different host than the web UI). */
  sshHosts?: string[];
}

export function normalizeInstanceUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/api\/v4$/, '');
}

/** Returns an error message for an unusable server URL. Plain http is allowed only for localhost. */
export function validateInstanceUrl(url: string): string | undefined {
  const u = normalizeInstanceUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return 'Enter a full URL, for example https://gitlab.example.com';
  }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return undefined;
  return 'Use an https:// URL so your access token is never sent unencrypted.';
}

export function instanceHost(inst: GitLabInstance): string {
  return new URL(normalizeInstanceUrl(inst.url)).host.toLowerCase();
}

export interface RemoteMatch {
  instance: GitLabInstance;
  /** Project path with namespace, e.g. group/subgroup/project */
  projectPath: string;
}

/** Finds the instance and project path for a remote URL. */
export function matchRemote(remoteUrl: string, instances: readonly GitLabInstance[]): RemoteMatch | undefined {
  const url = remoteUrl.trim();
  for (const inst of instances) {
    const base = new URL(normalizeInstanceUrl(inst.url));
    const host = base.host.toLowerCase();
    const prefix = base.pathname.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(url)) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (u.host.toLowerCase() !== host) continue;
      let p = decodeURIComponent(u.pathname);
      if (prefix && !p.toLowerCase().startsWith(prefix.toLowerCase() + '/')) continue;
      p = p.slice(prefix.length).replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
      if (p.includes('/')) return { instance: inst, projectPath: p };
      continue;
    }
    const hp = remoteHostPath(url);
    if (!hp) continue;
    const sshHosts = [base.hostname.toLowerCase(), ...(inst.sshHosts ?? []).map((h) => h.toLowerCase())];
    if (sshHosts.includes(hp.host.toLowerCase()) && hp.path.includes('/')) return { instance: inst, projectPath: hp.path.replace(/^\/+/, '') };
  }
  return undefined;
}

/** Hosts from remotes that look like GitLab servers but are not configured yet. */
export function suggestHosts(remoteUrls: readonly string[], instances: readonly GitLabInstance[]): Map<string, number> {
  const known = new Set(instances.map(instanceHost));
  const counts = new Map<string, number>();
  for (const url of remoteUrls) {
    const hp = remoteHostPath(url);
    if (!hp) continue;
    const host = hp.host.toLowerCase();
    if (known.has(host) || !/gitlab/.test(host)) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return counts;
}

/** Page where a user creates a personal access token, with name and scopes filled in. */
export function tokenPageUrl(inst: GitLabInstance, scopes: string[] = ['api']): string {
  return `${normalizeInstanceUrl(inst.url)}/-/user_settings/personal_access_tokens?name=CANOPY&scopes=${scopes.join(',')}`;
}

export function pipelineSymbol(status: string | undefined): string {
  switch (status) {
    case 'success':
      return '✓';
    case 'failed':
      return '✗';
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return '◷';
    case 'canceled':
    case 'skipped':
      return '⊘';
    case 'manual':
      return '▷';
    default:
      return '';
  }
}

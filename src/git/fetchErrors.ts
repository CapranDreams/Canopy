/** Classifies `git fetch` failures and groups remotes by credential host. Pure, unit tested. */
import { remoteHostPath } from '../util/remote';

/**
 * `transient`: the network or server dropped us (worth a silent retry).
 * `auth`: credentials are missing or rejected (retrying would only prompt again).
 * `other`: anything else (bad ref, corrupt repo, missing remote, ...).
 */
export type FetchFailure = 'transient' | 'auth' | 'other';

/**
 * Credential problems that affect every repository on the host. "Repository not found" and HTTP 403 are left
 * out on purpose: they mean the credential worked but this one repository is off limits.
 */
const AUTH = [
  /authentication failed/i,
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /permission denied \((publickey|keyboard-interactive|password)/i,
  /invalid username or password/i,
  /returned error: 401\b/,
  /HTTP Basic: Access denied/i,
  /logon failed/i,
  /credential.*(cancel|not found|failed)/i
];

const TRANSIENT = [
  /connection (closed|reset|refused|timed out)/i,
  /closed by remote host/i,
  /kex_exchange_identification/i,
  /ssh_exchange_identification/i,
  /remote end hung up/i,
  /early eof/i,
  /RPC failed/i,
  /unexpected disconnect/i,
  /operation timed out/i,
  /connection timed out/i,
  /failed to connect/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /network is unreachable/i,
  /broken pipe/i,
  /returned error: (429|5\d\d)\b/,
  /TLS|SSL_ERROR|schannel|gnutls/i,
  /index-pack failed/i,
  /fetch-pack: invalid index-pack output/i
];

export function classifyFetchError(stderr: string): FetchFailure {
  // Auth wins: "fatal: Authentication failed ... 403" must not be retried.
  if (AUTH.some((re) => re.test(stderr))) return 'auth';
  if (TRANSIENT.some((re) => re.test(stderr))) return 'transient';
  return 'other';
}

/** Hosts a fetch will contact (lower case); local and file remotes have none. */
export function credentialHosts(remoteUrls: Iterable<string>): string[] {
  const hosts = new Set<string>();
  for (const url of remoteUrls) {
    const p = remoteHostPath(url);
    if (p) hosts.add(p.host);
  }
  return [...hosts].sort();
}

/** Delay before retry `attempt` (1-based): ~1.5 s, ~4 s, with jitter so retried fetches don't reconnect in lockstep. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = attempt <= 1 ? 1500 : 4000;
  return Math.round(base * (0.75 + random() * 0.5));
}

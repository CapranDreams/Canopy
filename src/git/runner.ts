import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { Limiter } from '../util/limit';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface RunOptions {
  cwd: string;
  /** Read-only commands skip optional locks so they never block a user's own git. */
  readOnly?: boolean;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Bypass the concurrency limiter (for user-initiated, interactive operations). */
  priority?: boolean;
  /** Run git (and the ssh / credential helpers it starts, which inherit it) at below-normal CPU priority. */
  background?: boolean;
}

export type GitLogger = (line: string) => void;

const DEFAULT_TIMEOUT_MS = 120_000;

export class GitRunner {
  private readonly limiter: Limiter;

  constructor(
    private gitPath: string,
    maxConcurrent: number,
    private readonly log: GitLogger = () => {}
  ) {
    this.limiter = new Limiter(maxConcurrent);
  }

  setGitPath(path: string): void {
    this.gitPath = path;
  }

  setMaxConcurrent(n: number): void {
    this.limiter.setMax(n);
  }

  run(args: readonly string[], opts: RunOptions): Promise<string> {
    const exec = () => this.exec(args, opts);
    return opts.priority ? exec() : this.limiter.run(exec);
  }

  private exec(args: readonly string[], opts: RunOptions): Promise<string> {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      ...(opts.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
      ...opts.env
    };
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.gitPath, args as string[], { cwd: opts.cwd, env, windowsHide: true });
      } catch (e) {
        reject(new GitError(`Failed to start git: ${(e as Error).message}`, args, '', null));
        return;
      }
      if (opts.background && child.pid) {
        try {
          os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // Best effort; the process may already have exited.
        }
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new GitError(`git ${args[0]} timed out`, args, Buffer.concat(err).toString('utf8'), null));
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new GitError(`Failed to run git: ${e.message}`, args, '', null));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (!opts.readOnly || code !== 0) {
          this.log(`[${opts.cwd}] git ${args.join(' ')} (${Date.now() - started} ms, exit ${code})${stderr.trim() ? '\n  ' + stderr.trim().split('\n').join('\n  ') : ''}`);
        }
        if (code === 0) resolve(stdout);
        else reject(new GitError(firstMeaningfulLine(stderr) || `git ${args[0]} failed with exit code ${code}`, args, stderr, code));
      });
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }
}

function firstMeaningfulLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const important = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines.find((l) => !/^hint:/i.test(l)) ?? lines[0] ?? '';
  return important.replace(/^(fatal|error):\s*/i, '');
}

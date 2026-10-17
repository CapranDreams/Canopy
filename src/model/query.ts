/**
 * Smart folder queries, e.g.  is:conflict OR (is:dirty AND age<7d) -name:scratch
 *
 * Terms:  is:conflict|operation|diverged|behind|incoming|ahead|unpushed|dirty|changes|clean|detached|unpublished|error
 *         is:mr / is:pr, is:draft, is:mr-conflict / is:pr-conflict  pipeline:<status> (success, failed, running, canceled, none)
 *         name:<glob> branch:<glob> path:<glob> folder:<glob> remote:<text>
 *         behind>N ahead>N changes>N (also <, >=, <=, =)   age<7d age>2w (h, d, w, m, y)
 *         bare words match name or branch.
 * Operators: AND (or juxtaposition), OR, NOT / leading "-", parentheses.
 */
import { RepoFacts, attentionOf } from './types';

export type Predicate = (r: RepoFacts, now?: number) => boolean;

type Token = { t: 'word'; v: string } | { t: '(' } | { t: ')' };

function tokenize(q: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '(' || ch === ')') {
      tokens.push({ t: ch });
      i++;
    } else {
      let v = '';
      while (i < q.length && !/\s|\(|\)/.test(q[i])) {
        if (q[i] === '"') {
          const end = q.indexOf('"', i + 1);
          v += q.slice(i + 1, end < 0 ? q.length : end);
          i = end < 0 ? q.length : end + 1;
        } else {
          v += q[i++];
        }
      }
      tokens.push({ t: 'word', v });
    }
  }
  return tokens;
}

export class QueryError extends Error {}

export function compileQuery(query: string): Predicate {
  const tokens = tokenize(query);
  let pos = 0;
  const peek = () => tokens[pos];
  const isWord = (tok: Token | undefined, w: string) => tok?.t === 'word' && tok.v.toUpperCase() === w;

  function parseOr(): Predicate {
    let left = parseAnd();
    while (isWord(peek(), 'OR')) {
      pos++;
      const right = parseAnd();
      const l = left;
      left = (r, now) => l(r, now) || right(r, now);
    }
    return left;
  }

  function parseAnd(): Predicate {
    let left = parseNot();
    for (;;) {
      const tok = peek();
      if (!tok || tok.t === ')' || isWord(tok, 'OR')) break;
      if (isWord(tok, 'AND')) pos++;
      const right = parseNot();
      const l = left;
      left = (r, now) => l(r, now) && right(r, now);
    }
    return left;
  }

  function parseNot(): Predicate {
    const tok = peek();
    if (isWord(tok, 'NOT')) {
      pos++;
      const inner = parseNot();
      return (r, now) => !inner(r, now);
    }
    if (tok?.t === 'word' && tok.v.startsWith('-') && tok.v.length > 1) {
      pos++;
      const inner = parseTerm(tok.v.slice(1));
      return (r, now) => !inner(r, now);
    }
    return parsePrimary();
  }

  function parsePrimary(): Predicate {
    const tok = tokens[pos++];
    if (!tok) throw new QueryError('Query ended unexpectedly.');
    if (tok.t === '(') {
      const inner = parseOr();
      if (tokens[pos++]?.t !== ')') throw new QueryError('Missing closing parenthesis.');
      return inner;
    }
    if (tok.t === ')') throw new QueryError('Unexpected ")".');
    return parseTerm(tok.v);
  }

  if (!tokens.length) return () => true;
  const pred = parseOr();
  if (pos < tokens.length) throw new QueryError('Unexpected ")".');
  return pred;
}

function glob(pattern: string): (s: string) => boolean {
  const re = new RegExp('^' + pattern.toLowerCase().split('*').map(escapeRe).join('.*') + '$');
  const contains = !pattern.includes('*');
  const needle = pattern.toLowerCase();
  return (s) => (contains ? s.toLowerCase().includes(needle) : re.test(s.toLowerCase()));
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

const AGE_UNITS: Record<string, number> = { h: 3600, d: 86400, w: 604800, m: 2592000, y: 31536000 };

function compare(op: string, a: number, b: number): boolean {
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: return a === b;
  }
}

function parseTerm(word: string): Predicate {
  const colon = /^([a-z]+):(.*)$/i.exec(word);
  if (colon) {
    const key = colon[1].toLowerCase();
    const value = colon[2];
    if (key === 'is') return isTerm(value.toLowerCase());
    const g = glob(value);
    switch (key) {
      case 'name': return (r) => g(r.name);
      case 'branch': return (r) => g(r.branch ?? r.headShort ?? '');
      case 'path': return (r) => g(r.root.replace(/\\/g, '/'));
      case 'folder': return (r) => r.folderNames.some(g);
      case 'remote': return (r) => r.remoteUrls.some((u) => u.toLowerCase().includes(value.toLowerCase()));
      case 'pipeline':
      case 'ci': {
        const v = value.toLowerCase();
        const running = ['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled'];
        if (v === 'none') return (r) => !r.ci;
        if (v === 'running') return (r) => !!r.ci && running.includes(r.ci);
        if (v === 'passed') return (r) => r.ci === 'success';
        return (r) => r.ci === v;
      }
      default: throw new QueryError(`Unknown filter "${key}:".`);
    }
  }
  const cmp = /^(behind|ahead|changes|conflicts|age)(>=|<=|>|<|=)(\d+)([hdwmy]?)$/i.exec(word);
  if (cmp) {
    const [, field, op, num, unit] = cmp;
    const n = Number(num);
    if (field.toLowerCase() === 'age') {
      const seconds = n * (AGE_UNITS[(unit || 'd').toLowerCase()] ?? 86400);
      return (r, now = Date.now() / 1000) => r.lastCommitTime > 0 && compare(op, now - r.lastCommitTime, seconds);
    }
    const get: Record<string, (r: RepoFacts) => number> = {
      behind: (r) => r.behind,
      ahead: (r) => r.ahead,
      changes: (r) => r.changed,
      conflicts: (r) => r.conflicts
    };
    const f = get[field.toLowerCase()];
    return (r) => compare(op, f(r), n);
  }
  const g = glob(word);
  return (r) => g(r.name) || g(r.branch ?? '');
}

function isTerm(v: string): Predicate {
  switch (v) {
    case 'conflict':
    case 'conflicts':
      return (r) => r.conflicts > 0 || r.operation !== null;
    case 'operation':
    case 'rebasing':
    case 'merging':
      return (r) => r.operation !== null;
    case 'diverged':
      return (r) => r.behind > 0 && r.ahead > 0;
    case 'behind':
    case 'incoming':
      return (r) => r.behind > 0;
    case 'ahead':
    case 'unpushed':
      return (r) => r.ahead > 0;
    case 'dirty':
    case 'changes':
    case 'modified':
      return (r) => r.changed > 0;
    case 'clean':
      return (r) => attentionOf(r) === 'clean';
    case 'detached':
      return (r) => r.detached;
    case 'unpublished':
    case 'noupstream':
      return (r) => !r.detached && !r.upstream;
    case 'error':
      return (r) => r.error !== null;
    case 'mr':
      return (r) => r.mr !== null;
    case 'draft':
      return (r) => r.mr === 'draft';
    case 'mr-conflict':
    case 'pr-conflict':
      return (r) => r.mrConflicts;
    default:
      throw new QueryError(`Unknown "is:${v}".`);
  }
}

export function validateQuery(q: string): string | undefined {
  try {
    compileQuery(q);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

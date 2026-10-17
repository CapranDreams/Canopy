import * as vscode from 'vscode';

export interface BranchColors {
  /** Branch names shown in the "special" color (default: main). */
  specialNames: string[];
  special: string;
  other: string;
  local: string;
  remote: string;
}

const DEFAULTS: BranchColors = { specialNames: ['main'], special: '#b180d7', other: '#e535ab', local: '#3794ff', remote: '#b180d7' };

/** Accepts CSS colors such as #rgb, #rrggbb(aa), rgb()/hsl() and named colors; anything else falls back. */
function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]+\)|[a-z]{3,20})$/i.test(value.trim()) ? value.trim() : fallback;
}

export function branchColors(): BranchColors {
  const c = vscode.workspace.getConfiguration('canopy.branchColors');
  const names = c.get<unknown>('specialNames');
  return {
    specialNames: Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim()) : DEFAULTS.specialNames,
    special: color(c.get('special'), DEFAULTS.special),
    other: color(c.get('other'), DEFAULTS.other),
    local: color(c.get('local'), DEFAULTS.local),
    remote: color(c.get('remote'), DEFAULTS.remote)
  };
}

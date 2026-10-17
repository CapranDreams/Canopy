/**
 * Lays out a commit list (topological order, newest first) into lanes for a graph view.
 * Each row gets the lane of its node and the line segments to draw within that row.
 * Rows are drawn independently: y 0 = top edge, 1 = node centre, 2 = bottom edge.
 */

export interface GraphInput {
  hash: string;
  parents: string[];
}

export interface GraphLine {
  x1: number;
  y1: 0 | 1;
  x2: number;
  y2: 1 | 2;
  /** Lane index used to pick a colour. */
  color: number;
}

export interface GraphRow {
  lane: number;
  lines: GraphLine[];
}

export function layoutGraph(commits: readonly GraphInput[], maxLanes = 16): { rows: GraphRow[]; width: number } {
  // active[i] = hash expected next in lane i, or null when the lane is free.
  const active: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 1;

  const freeLane = () => {
    const i = active.indexOf(null);
    if (i >= 0) return i;
    active.push(null);
    return active.length - 1;
  };

  for (const c of commits) {
    let lane = active.indexOf(c.hash);
    if (lane < 0) lane = freeLane();
    const lines: GraphLine[] = [];

    for (let i = 0; i < active.length; i++) {
      const h = active[i];
      if (h === null) continue;
      if (h === c.hash) lines.push({ x1: i, y1: 0, x2: lane, y2: 1, color: i });
      else lines.push({ x1: i, y1: 0, x2: i, y2: 2, color: i });
    }
    for (let i = 0; i < active.length; i++) if (active[i] === c.hash) active[i] = null;

    c.parents.forEach((p, idx) => {
      const existing = active.indexOf(p);
      if (existing >= 0 && idx === 0 && lane < existing && active[lane] === null) {
        // Keep the first-parent line in the lower lane: bend the other lane into ours instead.
        const pass = lines.find((l) => l.x1 === existing && l.y1 === 0 && l.x2 === existing && l.y2 === 2);
        if (pass) pass.x2 = lane;
        active[existing] = null;
        active[lane] = p;
        lines.push({ x1: lane, y1: 1, x2: lane, y2: 2, color: lane });
        return;
      }
      if (existing >= 0) {
        lines.push({ x1: lane, y1: 1, x2: existing, y2: 2, color: idx === 0 ? lane : existing });
        return;
      }
      const target = idx === 0 && active[lane] === null ? lane : freeLane();
      active[target] = p;
      lines.push({ x1: lane, y1: 1, x2: target, y2: 2, color: idx === 0 ? lane : target });
    });

    while (active.length && active[active.length - 1] === null) active.pop();
    width = Math.max(width, lane + 1, active.length);
    rows.push({ lane, lines });
  }

  if (width > maxLanes) {
    // Clamp very wide histories; lines beyond the cap collapse onto the last lane.
    for (const r of rows) {
      r.lane = Math.min(r.lane, maxLanes - 1);
      for (const l of r.lines) {
        l.x1 = Math.min(l.x1, maxLanes - 1);
        l.x2 = Math.min(l.x2, maxLanes - 1);
      }
    }
    width = maxLanes;
  }
  return { rows, width };
}

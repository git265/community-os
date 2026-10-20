// Group map pins that would sit on top of each other at the current zoom. Pure: give it the points and a function that
// turns a point into screen pixels, and it returns the pins to draw one by one and the clusters to draw as a count badge.
const RANK = { 'Out of service': 3, 'Under repair': 2, 'Needs attention': 1, Working: 0 };
export function clusterPoints(points, toPx, cell = 44, keep = new Set()) {
  const cells = new Map();
  for (const p of points) {
    const [px, py] = toPx(p); const k = `${Math.floor(px / cell)}:${Math.floor(py / cell)}`;
    if (!cells.has(k)) cells.set(k, []); cells.get(k).push(p);
  }
  const singles = []; const clusters = [];
  for (const g of cells.values()) {
    const kept = g.filter((p) => keep.has(p.id)); const rest = g.filter((p) => !keep.has(p.id));
    singles.push(...kept);
    if (rest.length === 1) singles.push(rest[0]);
    else if (rest.length > 1) {
      const worst = rest.reduce((w, p) => ((RANK[p.cond] ?? 0) > (RANK[w.cond] ?? 0) ? p : w), rest[0]);
      clusters.push({ x: rest.reduce((s, p) => s + p.x, 0) / rest.length, y: rest.reduce((s, p) => s + p.y, 0) / rest.length, n: rest.length, color: worst.color, cond: worst.cond, points: rest, overdue: rest.some((p) => p.overdue) });
    }
  }
  return { singles, clusters };
}

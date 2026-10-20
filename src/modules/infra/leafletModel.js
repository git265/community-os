import { COND_COLOR, effectiveCondition, faultyOf, isOverdue, layerOf, parseBreaks, parseShape, pointsAlong, units } from './infraModel.js';

/**
 * Draw data for the Leaflet site map, in plan pixels (x right, y down). Selection is NOT in here, so picking an asset never
 * rebuilds the thousands of shapes - the map draws the highlight on its own small layer.
 */
export function buildLeafletData(assets, { layers, openMap, visible, condFilter = 'All' }) {
  const open = new Set(openMap.keys());
  const points = []; const lines = []; const zones = []; const dots = []; const breaks = []; const wedges = [];
  for (const a of assets) {
    const shape = parseShape(a);
    if (!shape) continue;
    const L = layerOf(layers, a.type);
    if (visible && !visible.has(L.slug)) continue;
    const cond = effectiveCondition(a, open);
    const overdue = isOverdue(a);
    if (condFilter === 'Overdue' ? !overdue : condFilter !== 'All' && cond !== condFilter) continue;
    const base = { id: a.id, name: a.name || '', layer: L.slug, icon: L.icon, type: a.type, cond, color: COND_COLOR[cond] || COND_COLOR.Working, overdue, dash: L.dash || 'solid' };
    if (shape.t === 'point') {
      points.push({ ...base, x: shape.c[0], y: shape.c[1], dir: Number.isFinite(shape.dir) ? shape.dir : -1 });
      if (Number.isFinite(shape.dir) && shape.dir >= 0 && L.slug === 'cctv-camera') {
        const r = 70; const half = 28; const rad = (d) => ((d - 90) * Math.PI) / 180;
        const p = (d) => [shape.c[0] + r * Math.cos(rad(d)), shape.c[1] + r * Math.sin(rad(d))];
        wedges.push({ id: a.id, color: base.color, pts: [shape.c, p(shape.dir - half), p(shape.dir + half)] });
      }
    } else if (shape.t === 'line') {
      lines.push({ ...base, pts: shape.c });
      parseBreaks(a).forEach((b, i) => breaks.push({ id: a.id, i, x: b.c[0], y: b.c[1], note: b.note || '' }));
      const n = units(a);
      if (L.dots && n >= 1 && n <= 400) {
        const f = faultyOf(a);
        const healthy = cond === 'Under repair' ? COND_COLOR['Under repair'] : ['Standby', 'Retired'].includes(cond) ? COND_COLOR.Standby : COND_COLOR.Working;
        pointsAlong(shape.c, n).forEach((p, i) => dots.push({ id: a.id, x: p[0], y: p[1], color: i >= n - f ? COND_COLOR['Out of service'] : healthy }));
      }
    } else zones.push({ ...base, pts: shape.c });
  }
  return { points, lines, zones, dots, breaks, wedges };
}

/** Sample assets for the performance test: points scattered over the plan (or inside the boundary). Never saved. */
export function sampleAssets(n, plan, layers, inside) {
  const W = plan.width || 4000; const H = plan.height || 3000;
  const kinds = layers.filter((l) => l.geometry === 'Point');
  const conds = ['Working', 'Working', 'Working', 'Working', 'Working', 'Working', 'Needs attention', 'Under repair', 'Out of service', 'Standby'];
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 40) {
    const x = Math.round(rnd() * W); const y = Math.round(rnd() * H);
    if (inside && !inside([x, y])) continue;
    const k = kinds[Math.floor(rnd() * kinds.length)];
    out.push({ id: `perf-${out.length}`, name: `${k.type} sample ${out.length + 1}`, type: k.type, area: 'Sample', status: conds[Math.floor(rnd() * conds.length)], shape: JSON.stringify({ t: 'point', c: [x, y] }), planId: plan.id, quantity: 1 });
  }
  return out;
}

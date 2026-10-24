import { localDay, todayLocal } from '../../lib/locale.js';
// Infrastructure map: the pure logic (no React, no map library) so it can be tested on its own and reused by other screens.
//
// An asset is an Equipment row (STORAGE: COLLECTIONS.EQUIPMENT) with a `shape` - JSON in PLAN PIXELS, not latitude / longitude:
//   { t: 'point', c: [x, y], dir?: degrees }      one pin (a camera can carry a viewing direction)
//   { t: 'line',  c: [[x, y], ...] }              a road, pipe, cable (a group of lights along a road is one line + a quantity)
//   { t: 'zone',  c: [[x, y], ...] }              an outline (plant, clubhouse, park, parking)
// Plan pixels keep working for any community's drawing, scaled or not. When a plan is calibrated (metres per pixel) lengths
// are shown in metres, and a plan can later be matched to real GPS points without touching a single asset.

export const CONDITIONS = ['Working', 'Needs attention', 'Under repair', 'Out of service', 'Standby', 'Retired'];
export const LIVE_CONDITIONS = ['Working', 'Needs attention', 'Under repair', 'Out of service'];
/** Colours: green / amber / blue / coral (never dark red) / grey. Same in the legend, the board and the map. */
export const COND_COLOR = { Working: '#2e9e6b', 'Needs attention': '#e8a317', 'Under repair': '#377dff', 'Out of service': '#e5484d', Standby: '#9aa4b2', Retired: '#9aa4b2' };
export const COND_HELP = {
  Working: 'Does its job, nothing to do',
  'Needs attention': 'Works, but a fault or an overdue service is logged',
  'Under repair': 'A maintenance task is open on it',
  'Out of service': 'Not working and not yet being repaired',
  Standby: 'Spare, ignored in roll-ups', Retired: 'Decommissioned, ignored in roll-ups',
};
const SEVERITY = { 'Out of service': 4, 'Needs attention': 3, 'Under repair': 2, Working: 1, Standby: 0, Retired: 0 };
/** A group (e.g. 40 street lights) turns coral when this share or more is faulty; any fault makes it amber. */
export const GROUP_OUT_SHARE = 0.3;

/** How each kind of asset is drawn. A community overrides or adds kinds in Plans & layers; these defaults need no set-up. */
export const DEFAULT_LAYERS = [
  { type: 'Street light', geometry: 'Line', icon: '💡', spacing: 25, dots: true },
  { type: 'Feeder pillar', geometry: 'Point', icon: '⚡' },
  { type: 'Transformer / HT', geometry: 'Point', icon: '🔌' },
  { type: 'CCTV camera', geometry: 'Point', icon: '📹' },
  { type: 'Water pipeline', geometry: 'Line', icon: '💧', dash: 'solid' },
  { type: 'Sewer line', geometry: 'Line', icon: '🟤', dash: 'dashed' },
  { type: 'Storm drain', geometry: 'Line', icon: '🌧', dash: 'dotted' },
  { type: 'Electrical cable', geometry: 'Line', icon: '〰', dash: 'dashdot' },
  { type: 'Valve', geometry: 'Point', icon: '🚰' },
  { type: 'Manhole / chamber', geometry: 'Point', icon: '⭕' },
  { type: 'Water tank', geometry: 'Point', icon: '🛢' },
  { type: 'Pump', geometry: 'Point', icon: '⚙' },
  { type: 'Motor', geometry: 'Point', icon: '⚙' },
  { type: 'Blower', geometry: 'Point', icon: '🌀' },
  { type: 'Panel / starter', geometry: 'Point', icon: '🎛' },
  { type: 'Sensor / meter', geometry: 'Point', icon: '📟' },
  { type: 'NVR / DVR', geometry: 'Point', icon: '🖥' },
  { type: 'UPS / battery', geometry: 'Point', icon: '🔋' },
  { type: 'Air conditioner', geometry: 'Point', icon: '❄' },
  { type: 'Lift', geometry: 'Point', icon: '🛗' },
  { type: 'Fire safety', geometry: 'Point', icon: '🧯' },
  { type: 'Network / Wi-Fi', geometry: 'Point', icon: '📶' },
  { type: 'Zone / building', geometry: 'Zone', icon: '▭' },
  { type: 'Other', geometry: 'Point', icon: '●' },
];
export const DASHES = { solid: null, dashed: [4, 2], dotted: [1, 2], dashdot: [4, 2, 1, 2] };

const slug = (s) => String(s || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
export const layerSlug = slug;

/** Defaults + the community's own rows: a row with the same type overrides a default, a new type is added, `hidden` removes it. */
export function mergeLayers(rows = []) {
  const byType = new Map(DEFAULT_LAYERS.map((l) => [l.type.toLowerCase(), { ...l }]));
  for (const r of rows) {
    if (!r?.type) continue;
    const k = String(r.type).trim().toLowerCase();
    const base = byType.get(k) || { type: String(r.type).trim(), geometry: 'Point', icon: '●' };
    byType.set(k, { ...base, ...(r.geometry ? { geometry: r.geometry } : {}), ...(r.icon ? { icon: r.icon } : {}), ...(Number(r.spacing) > 0 ? { spacing: Number(r.spacing) } : {}), hidden: !!r.hidden, rowId: r.id, custom: !DEFAULT_LAYERS.some((d) => d.type.toLowerCase() === k) });
  }
  return [...byType.values()].filter((l) => !l.hidden).map((l) => ({ ...l, slug: slug(l.type) }));
}
export function layerOf(layers, type) {
  const k = String(type || '').trim().toLowerCase();
  return layers.find((l) => l.type.toLowerCase() === k) || { type: type || 'Other', geometry: 'Point', icon: '●', slug: slug(type) };
}

export function parseShape(a) {
  if (!a?.shape) return null;
  try {
    const s = typeof a.shape === 'string' ? JSON.parse(a.shape) : a.shape;
    if (!s || !s.t || !s.c) return null;
    if (s.t === 'point' && Array.isArray(s.c) && s.c.length === 2 && s.c.every(Number.isFinite)) return s;
    if ((s.t === 'line' || s.t === 'zone') && Array.isArray(s.c) && s.c.length >= 2 && s.c.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return s;
  } catch { /* fall through */ }
  return null;
}
export const shapeJson = (shape) => JSON.stringify(shape);

/** Marked breaks on a pipe / cable: [{ c:[x,y], note, at, by }] kept on the asset. */
export function parseBreaks(a) {
  try { const v = typeof a?.breaks === 'string' ? JSON.parse(a.breaks || '[]') : a?.breaks; return Array.isArray(v) ? v.filter((b) => b && Array.isArray(b.c) && b.c.length === 2) : []; } catch { return []; }
}
/** The point on a polyline nearest to p (plan pixels), so a tap near a pipe lands exactly on it. Returns { c, dist }. */
export function snapToLine(line, p) {
  let best = null;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i]; const [bx, by] = line[i + 1]; const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    const q = [ax + t * dx, ay + t * dy]; const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || d < best.dist) best = { c: q, dist: d };
  }
  return best;
}

/** The "primary" plan is the first by order; assets without a plan id belong to it. */
export function planOfAsset(a, plans) { return plans.find((p) => p.id === a.planId) || (!a.planId ? plans[0] : null) || null; }
export const assetsOnPlan = (assets, plan, plans) => assets.filter((a) => planOfAsset(a, plans)?.id === plan?.id);

export const units = (a) => Math.max(1, Number(a.quantity) || 1);
export const faultyOf = (a) => Math.min(units(a), Math.max(0, Number(a.faulty) || 0));
const todayIso = () => todayLocal();

/**
 * The condition people see. Under repair is automatic while a linked task is open; a group with faults shows amber (coral from
 * GROUP_OUT_SHARE faulty); Standby / Retired are left alone. The STORED condition (a.status) is never rewritten by this.
 */
export function effectiveCondition(a, openTicketIds = new Set()) {
  if (a.status === 'Standby' || a.status === 'Retired') return a.status;
  if (openTicketIds.has(a.id)) return 'Under repair';
  const f = faultyOf(a);
  if (f > 0 && units(a) > 1) return f / units(a) >= GROUP_OUT_SHARE ? 'Out of service' : 'Needs attention';
  if (f > 0 && a.status === 'Working') return 'Needs attention';
  return CONDITIONS.includes(a.status) ? a.status : 'Working';
}
export const isOverdue = (a) => !!a.nextService && a.nextService < todayIso() && !['Standby', 'Retired'].includes(a.status);
export function warrantySoon(a, days = 60) {
  if (!a.warrantyUntil) return false;
  const lim = localDay(new Date(Date.now() + days * 864e5));
  return a.warrantyUntil >= todayIso() && a.warrantyUntil <= lim;
}

/** Tickets that are still live and point at an asset. */
export const DEAD_TICKET = ['Closed', 'Cancelled'];
export function openTicketsByAsset(tickets) {
  const m = new Map();
  for (const t of tickets) {
    if (!t.assetId || DEAD_TICKET.includes(t.status)) continue;
    if (!m.has(t.assetId)) m.set(t.assetId, []);
    m.get(t.assetId).push(t);
  }
  return m;
}

/** Worst condition across a set of assets (ignores Standby / Retired). */
export function worstOf(conds) {
  let best = null;
  for (const c of conds) if ((SEVERITY[c] ?? 0) > (SEVERITY[best] ?? -1) && SEVERITY[c] > 0) best = c;
  return best || (conds.length ? 'Standby' : null);
}

/** One row per area for the health board. */
export function areaRollup(assets, openMap) {
  const open = new Set(openMap.keys());
  const rows = new Map();
  for (const a of assets) {
    const area = (a.area || 'Unassigned').trim() || 'Unassigned';
    if (!rows.has(area)) rows.set(area, { area, assets: [], conds: [], units: 0, faulty: 0, openTasks: 0, overdue: 0, warranty: 0, nextService: '' });
    const r = rows.get(area);
    const c = effectiveCondition(a, open);
    r.assets.push(a); r.conds.push(c);
    if (!['Standby', 'Retired'].includes(c)) {
      r.units += units(a);
      r.faulty += c === 'Under repair' && units(a) === 1 ? 1 : faultyOf(a) || (['Needs attention', 'Out of service', 'Under repair'].includes(c) && units(a) === 1 ? 1 : 0);
    }
    r.openTasks += (openMap.get(a.id) || []).length;
    if (isOverdue(a)) r.overdue += 1;
    if (warrantySoon(a)) r.warranty += 1;
    if (a.nextService && !['Standby', 'Retired'].includes(a.status) && (!r.nextService || a.nextService < r.nextService)) r.nextService = a.nextService;
  }
  return [...rows.values()].map((r) => ({ ...r, worst: worstOf(r.conds) })).sort((a, b) => (SEVERITY[b.worst] ?? 0) - (SEVERITY[a.worst] ?? 0) || a.area.localeCompare(b.area));
}

// ------------------------------------------------------------------ geometry (plan pixels)
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function pathLength(pts) { let n = 0; for (let i = 1; i < pts.length; i++) n += dist(pts[i - 1], pts[i]); return n; }
/** n points spaced evenly along a path (first and last included when n > 1). */
export function pointsAlong(pts, n) {
  const total = pathLength(pts);
  if (n <= 0 || total === 0) return [];
  if (n === 1) return [pts[Math.floor(pts.length / 2)]];
  const out = [];
  for (let k = 0; k < n; k++) {
    let want = (total * k) / (n - 1);
    for (let i = 1; i < pts.length; i++) {
      const seg = dist(pts[i - 1], pts[i]);
      if (want <= seg || i === pts.length - 1) {
        const t = seg ? Math.min(1, want / seg) : 0;
        out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
        break;
      }
      want -= seg;
    }
  }
  return out;
}
export const centroid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
export function shapeCenter(shape) {
  if (!shape) return null;
  if (shape.t === 'point') return shape.c;
  if (shape.t === 'line') return pointsAlong(shape.c, 3)[1];
  return centroid(shape.c);
}
export function bbox(shape) {
  const pts = shape.t === 'point' ? [shape.c] : shape.c;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export function fmtLength(px, metersPerPx) {
  if (!metersPerPx) return '';
  const m = px * metersPerPx;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
const finite = (n) => Number.isFinite(Number(n)) && n !== '' && n !== null;

// ------------------------------------------------------------------ community boundary (plan pixels)
/** The community outline drawn on a plan, as a list of [x, y] corners, or null when none is set. */
export function parseBoundary(plan) {
  try {
    const b = typeof plan?.boundary === 'string' ? JSON.parse(plan.boundary) : plan?.boundary;
    const c = Array.isArray(b) ? b : b?.c;
    if (Array.isArray(c) && c.length >= 3 && c.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]))) return c.map((p) => [Number(p[0]), Number(p[1])]);
  } catch { /* none */ }
  return null;
}
export function pointInPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** True when any part of a shape (its corners and points along every edge) lies outside the boundary. No boundary = nothing is outside. */
export function shapeOutside(shape, poly) {
  if (!shape || !poly) return false;
  if (shape.t === 'point') return !pointInPoly(shape.c, poly);
  const c = shape.c; const edges = shape.t === 'zone' ? c.length : c.length - 1;
  for (let i = 0; i < edges; i++) {
    const a = c[i]; const b = c[(i + 1) % c.length]; const n = Math.max(1, Math.min(60, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 25)));
    for (let k = 0; k <= n; k++) if (!pointInPoly([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], poly)) return true;
  }
  return false;
}

/** CSV with a header row: name, type, area, quantity, faulty, status, x, y (x and y are % across / down the plan, optional). */
export function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const src = String(text || '').replace(/\r/g, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => String(c).trim()));
  if (clean.length < 2) return { rows: [], error: 'Add a header row (name, type, area, quantity, status, x, y) and at least one row.' };
  const head = clean[0].map((h) => String(h).trim().toLowerCase());
  const need = ['name', 'type'];
  if (need.some((n) => !head.includes(n))) return { rows: [], error: 'The header must include name and type.' };
  const out = clean.slice(1).map((r, i) => {
    const o = {}; head.forEach((h, k) => { o[h] = String(r[k] ?? '').trim(); });
    const x = o.x === '' || o.x === undefined ? NaN : Number(o.x); const y = o.y === '' || o.y === undefined ? NaN : Number(o.y);
    return { line: i + 2, name: o.name, type: o.type, area: o.area || '', quantity: Number(o.quantity) || 1, faulty: Number(o.faulty) || 0, status: CONDITIONS.find((c) => c.toLowerCase() === String(o.status || '').toLowerCase()) || 'Working', xPct: x, yPct: y };
  });
  const bad = out.find((r) => !r.name || !r.type);
  if (bad) return { rows: [], error: `Row ${bad.line}: name and type are required.` };
  const off = out.find((r) => (Number.isFinite(r.xPct) && (r.xPct < 0 || r.xPct > 100)) || (Number.isFinite(r.yPct) && (r.yPct < 0 || r.yPct > 100)));
  if (off) return { rows: [], error: `Row ${off.line}: x and y are percentages from 0 to 100.` };
  return { rows: out, error: '' };
}

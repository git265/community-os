// Putting the site plan on the real map. Two spots that are known on both the plan (pixels) and the earth (latitude, longitude)
// fix the plan's position, scale and rotation (a similarity transform; a flat plan of a small site needs nothing more).
// Everything works in metres on a local flat projection around the first spot, which is exact enough across a few kilometres.
const R = 6371008.8; const rad = (d) => (d * Math.PI) / 180; const deg = (r) => (r * 180) / Math.PI;
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };

export const parseGeoRef = (plan) => { try { const g = JSON.parse(plan?.geoRef || 'null'); return g && g.a && g.b ? g : null; } catch { return null; } };
export const geoRefJson = (a, b) => JSON.stringify({ a, b });

/** a, b: { x, y (plan pixels, y down), lat, lng }. Returns { toLL(x, y) -> [lat, lng], toXY(lat, lng) -> [x, y], metersPerPx, rotationDeg } or null. */
export function makeGeo(g) {
  if (!g?.a || !g?.b) return null;
  const { a, b } = g; const lat0 = rad(a.lat); const k = Math.cos(lat0);
  const toM = (lat, lng) => [R * rad(lng - a.lng) * k, R * rad(lat - a.lat)]; // east, north in metres from spot A
  const fromM = (e, n) => [a.lat + deg(n / R), a.lng + deg(e / (R * k))];
  const pa = [a.x, -a.y]; const pb = [b.x, -b.y]; // plan with y up
  const dp = [pb[0] - pa[0], pb[1] - pa[1]]; const dm = toM(b.lat, b.lng);
  if (Math.hypot(...dp) < 1e-6 || Math.hypot(...dm) < 0.5) return null;
  const m = cdiv(dm, dp); // plan pixel -> metres, a complex multiplier (scale and rotation)
  const inv = cdiv([1, 0], m);
  return {
    metersPerPx: Math.hypot(...m), rotationDeg: deg(Math.atan2(m[1], m[0])),
    toLL: (x, y) => { const e = cmul(m, [x - a.x, -y - -a.y]); return fromM(e[0], e[1]); },
    toXY: (lat, lng) => { const e = toM(lat, lng); const p = cmul(inv, e); return [a.x + p[0], -(-a.y + p[1])]; },
  };
}
export const ready = (plan) => makeGeo(parseGeoRef(plan));

export const BASES = [
  { id: 'street', label: 'Street', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors', max: 19 },
  { id: 'satellite', label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Tiles © Esri, Maxar, Earthstar Geographics', max: 19 },
];

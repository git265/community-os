// Which assets are closest to a spot on the plan (plan pixels). Points by distance, lines by distance to the line, outlines by being inside (distance 0).
import { snapToLine, pointInPoly } from '../../modules/infra/infraModel.js';
export function nearestAssets(assetsWithShapes, pt, limit = 3, maxPx = Infinity) {
  const out = [];
  for (const { asset, shape } of assetsWithShapes) {
    let d = Infinity;
    if (shape.t === 'point') d = Math.hypot(shape.c[0] - pt.x, shape.c[1] - pt.y);
    else if (shape.t === 'line') { const s = snapToLine(shape.c, [pt.x, pt.y]); d = s ? s.dist : Infinity; }
    else if (shape.t === 'zone') d = pointInPoly([pt.x, pt.y], shape.c) ? 0 : Math.min(...shape.c.map(([x, y]) => Math.hypot(x - pt.x, y - pt.y)));
    if (d <= maxPx) out.push({ asset, d, shape });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, limit);
}

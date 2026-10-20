import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import '../../lib/infra/leafletSafe.js';
import 'leaflet/dist/leaflet.css';
import { COND_COLOR, DASHES, pathLength, shapeCenter, snapToLine } from './infraModel.js';
import { clusterPoints } from '../../lib/infra/cluster.js';

const resolveUrl = (u) => (/^(data:|https?:|blob:|\/)/.test(u || '') ? u : `${import.meta.env.BASE_URL || '/'}${u || ''}`);
const nice = (m) => { const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p; };

/**
 * The site plan as a Leaflet map (CRS.Simple: plan pixels are the map units, no tiles, no network).
 * All shapes are drawn on one Canvas renderer, so a thousand assets stay smooth on a phone. At detail zoom the visible pins also
 * show the kind's icon. The parent owns the data; this draws it, reports taps, collects new shapes (with snapping) and measures.
 *
 * props: plan, data (leafletModel.buildLeafletData), boundary, selected {id, shape}, mode ('view'|'point'|'line'|'zone'|'break'|'measure'),
 *        directional, mpp, onSelect(id|null), onDraw(shape), onCancel(), focus {nonce, shape}, hint, onStats({ms,count})
 */
export default function LeafletMap({ plan, data, boundary, selected, mode = 'view', directional = false, mpp = 0, onSelect, onDraw, onCancel, focus, hint = '', onStats, fade = 0.6, onReport, impact = null }) {
  const box = useRef(null); const wrap = useRef(null); const posRef = useRef(null);
  const S = useRef({}); // live values for event handlers
  const [draft, setDraft] = useState([]);
  const [dirPending, setDirPending] = useState(null);
  const [snapOn, setSnapOn] = useState(true);
  const [full, setFull] = useState(false);
  const [scale, setScale] = useState(null);
  const [rect, setRect] = useState(null); // the part of the plan on screen, as fractions, for the overview box
  const [mini, setMini] = useState(() => { try { return localStorage.getItem('communityos:minimap') !== 'off'; } catch { return true; } });
  const W = plan.width || 4000; const H = plan.height || 3000;
  const ll = (x, y) => [H - y, x];
  Object.assign(S.current, { onReport, selectedId: selected?.id || '', mode, onSelect, onDraw, draft, dirPending, directional, mpp, data, snapOn, W, H, boundary, fade });

  // ---------- map, once per plan ----------
  useEffect(() => {
    const map = L.map(box.current, { crs: L.CRS.Simple, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, attributionControl: false, preferCanvas: true, doubleClickZoom: false, tapHold: true, zoomControl: true, renderer: L.canvas({ tolerance: 8, padding: 0.3 }) });
    const bounds = [[0, 0], [H, W]];
    const img = L.imageOverlay(resolveUrl(plan.imageUrl), bounds, { opacity: S.current.fade, interactive: false }).addTo(map);
    map.setView([H / 2, W / 2], -3, { animate: false });
    S.current.z0 = -3;
    // fit once the box really has a size (a lazy-loaded page can mount it at 0 x 0); later resizes keep the user's view
    const init = () => {
      map.invalidateSize(); map.setMinZoom(-10);
      map.fitBounds(bounds, { padding: [8, 8], animate: false });
      const z0 = map.getZoom(); S.current.z0 = z0;
      map.setMinZoom(z0 - 1); map.setMaxZoom(z0 + 4.5); map.setMaxBounds(L.latLngBounds([-H * 0.2, -W * 0.2], [H * 1.2, W * 1.2]));
      S.current.restyle?.(); S.current.pins?.();
    };
    S.current.init = init;
    const g = {};
    ['mask', 'zones', 'wedges', 'lines', 'dots', 'points', 'pointRings', 'rings', 'clusters', 'impact', 'pins', 'sel', 'draft', 'snap'].forEach((k) => { g[k] = L.layerGroup().addTo(map); });
    S.current.map = map; S.current.g = g; S.current.img = img; S.current.bounds = bounds;
    if (import.meta.env.DEV) window.__leafMap = map;

    const updateScale = () => { const m = (S.current.mpp || 0) / 2 ** map.getZoom(); const unit = m ? 'm' : 'px'; const per = m || 1 / 2 ** map.getZoom(); const target = per * 90; const len = nice(target); setScale({ w: Math.round(len / per), label: m ? (len >= 1000 ? `${len / 1000} km` : `${len} m`) : `${len} ${unit}` }); };
    const viewRect = () => { if (S.current.map !== map || !map._loaded) return; const b = map.getBounds(); const W0 = S.current.W; const H0 = S.current.H; setRect({ x1: Math.max(0, b.getWest() / W0), x2: Math.min(1, b.getEast() / W0), y1: Math.max(0, 1 - b.getNorth() / H0), y2: Math.min(1, 1 - b.getSouth() / H0) }); };
    map.on('zoomend', () => { updateScale(); S.current.clusters?.(); S.current.restyle?.(); S.current.pins?.(); viewRect(); });
    map.on('moveend', () => { S.current.clusters?.(); S.current.pins?.(); viewRect(); });
    map.on('contextmenu', (e) => { if (S.current.mode !== 'view') return; const x = e.latlng.lng; const y = S.current.H - e.latlng.lat; if (x < 0 || y < 0 || x > S.current.W || y > S.current.H) return; S.current.onReport?.({ x: Math.round(x), y: Math.round(y) }); });
    map.on('mousemove', (e) => {
      const { x, y } = { x: e.latlng.lng, y: S.current.H - e.latlng.lat };
      if (posRef.current) posRef.current.textContent = `${Math.round(x)}, ${Math.round(y)} px${S.current.mpp ? ` · ${Math.round(x * S.current.mpp)}, ${Math.round(y * S.current.mpp)} m` : ''}`;
      S.current.hover?.(x, y);
    });
    map.on('click', (e) => S.current.mapClick?.(e));
    map.on('dblclick', (e) => S.current.mapDbl?.(e));
    updateScale();
    let fitted = false; let touched = false;
    ['mousedown', 'touchstart', 'wheel'].forEach((ev) => box.current.addEventListener(ev, () => { touched = true; }, { passive: true }));
    const ro = new ResizeObserver(() => { const r = wrap.current?.getBoundingClientRect(); if (!r || !r.width || !r.height) return; if (!fitted || !touched) { fitted = true; init(); updateScale(); } else map.invalidateSize(); }); ro.observe(wrap.current);
    return () => { ro.disconnect(); map.remove(); S.current.map = null; if (import.meta.env.DEV) delete window.__leafMap; };
  }, [plan.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { S.current.img?.setOpacity(fade); }, [fade]);
  useEffect(() => { setTimeout(() => S.current.map?.invalidateSize(), 60); }, [full]);

  // ---------- boundary + data layers ----------
  useEffect(() => {
    const { map, g } = S.current; if (!map) return;
    g.mask.clearLayers();
    if (boundary) {
      const ring = boundary.map(([x, y]) => ll(x, y));
      L.polygon([[[-H, -W], [-H, 2 * W], [2 * H, 2 * W], [2 * H, -W]], ring], { stroke: false, fillColor: '#0b1d33', fillOpacity: 0.22, interactive: false }).addTo(g.mask);
      L.polygon(ring, { color: '#13917f', weight: 2.5, dashArray: '8 6', fill: false, interactive: false }).addTo(g.mask);
    }
  }, [boundary, plan.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const { map, g } = S.current; if (!map) return;
    const t0 = performance.now();
    ['zones', 'wedges', 'lines', 'dots', 'points', 'rings'].forEach((k) => g[k].clearLayers());
    const pick = (id) => () => { if (S.current.mode !== 'view') return; S.current.pickedAt = Date.now(); S.current.onSelect?.(id); };
    const tip = data.points.length + data.lines.length <= 2500;
    const mk = (layer, id, name) => { layer.on('click', pick(id)); if (tip && name) layer.bindTooltip(name, { sticky: true, direction: 'top', className: 'lf-tip' }); return layer; };
    data.zones.forEach((z) => mk(L.polygon(z.pts.map(([x, y]) => ll(x, y)), { color: z.color, weight: 2, fillColor: z.color, fillOpacity: 0.12 }), z.id, z.name).addTo(g.zones));
    data.wedges.forEach((w) => L.polygon(w.pts.map(([x, y]) => ll(x, y)), { stroke: false, fillColor: w.color, fillOpacity: 0.25, interactive: false }).addTo(g.wedges));
    data.lines.forEach((l) => {
      const d = DASHES[l.dash];
      mk(L.polyline(l.pts.map(([x, y]) => ll(x, y)), { color: l.color, weight: 4, opacity: 0.9, dashArray: d ? d.map((n) => n * 3).join(' ') : null, lineCap: 'round' }), l.id, l.name).addTo(g.lines);
    });
    data.dots.forEach((d) => mk(L.circleMarker(ll(d.x, d.y), { radius: 3.4, color: '#fff', weight: 1, fillColor: d.color, fillOpacity: 1 }), d.id).addTo(g.dots));
    data.breaks.forEach((b) => L.circleMarker(ll(b.x, b.y), { radius: 7, color: '#fff', weight: 2, fillColor: COND_COLOR['Out of service'], fillOpacity: 1, interactive: false }).addTo(g.rings));
    const dataPts = [];
    const pointObjs = data.points.map((p) => {
      const m = mk(L.circleMarker(ll(p.x, p.y), { radius: 6, color: '#fff', weight: 2, fillColor: p.color, fillOpacity: 1 }), p.id, `${p.name} · ${p.cond}`);
      dataPts.push([m, p]);
      let r = null; if (p.overdue) { r = L.circleMarker(ll(p.x, p.y), { radius: 10, color: '#e8a317', weight: 2, fill: false, dashArray: '3 3', interactive: false }); dataPts.push([r, p, 'ring']); }
      return { p, m, r };
    });
    // Pins that would sit on top of each other are drawn as one badge with a count; tap it to zoom in. Fully zoomed in, every pin shows.
    S.current.singleIds = new Set();
    S.current.clusters = () => {
      if (S.current.map !== map || !map._loaded) return;
      g.points.clearLayers(); g.pointRings.clearLayers(); g.clusters.clearLayers();
      const b = map.getBounds().pad(0.35); const vis = pointObjs.filter((o) => b.contains(ll(o.p.x, o.p.y)));
      const keepSet = new Set(S.current.selectedId ? [S.current.selectedId] : []);
      const atMax = S.current.mode !== 'view' || map.getZoom() >= map.getMaxZoom() - 0.4; // while drawing, every pin shows so each can be snapped to
      const { singles, clusters } = atMax ? { singles: vis.map((o) => o.p), clusters: [] } : clusterPoints(vis.map((o) => o.p), (p) => { const c = map.latLngToLayerPoint(ll(p.x, p.y)); return [c.x, c.y]; }, 46, keepSet);
      const byId = new Map(vis.map((o) => [o.p.id, o]));
      S.current.singleIds = new Set(singles.map((p) => p.id));
      singles.forEach((p) => { const o = byId.get(p.id); o.m.addTo(g.points); o.r?.addTo(g.pointRings); });
      clusters.forEach((c) => {
        const size = c.n >= 100 ? 46 : c.n >= 20 ? 40 : 34;
        const mk2 = L.marker(ll(c.x, c.y), { keyboard: false, zIndexOffset: 400, title: `${c.n} assets here. Tap to zoom in.`, icon: L.divIcon({ className: 'lf-cluster-wrap', html: `<span class="lf-cluster${c.overdue ? ' od' : ''}" style="background:${c.color};width:${size}px;height:${size}px">${c.n}</span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) });
        mk2.on('click', () => { S.current.pickedAt = Date.now(); map.flyToBounds(L.latLngBounds(c.points.map((p) => ll(p.x, p.y))), { padding: [70, 70], maxZoom: Math.min(map.getMaxZoom(), map.getZoom() + 2.5), duration: 0.5 }); });
        mk2.addTo(g.clusters);
      });
      S.current.restyle?.();
    };
    // a slow expanding circle on everything that is not in working condition (points, and the middle of lines and zones)
    let pulses = 0;
    const pulse = (x, y, color) => { if (++pulses > 300) return; L.marker(ll(x, y), { interactive: false, keyboard: false, zIndexOffset: -200, icon: L.divIcon({ className: 'lf-pulse-wrap', html: `<span class="lf-pulsering" style="--c:${color}"></span><span class="lf-pulsering d2" style="--c:${color}"></span>`, iconSize: [44, 44], iconAnchor: [22, 22] }) }).addTo(g.rings); };
    data.points.forEach((p) => { if (p.cond !== 'Working' && !String(p.id).startsWith('perf-')) pulse(p.x, p.y, p.color); });
    [...data.lines, ...data.zones].forEach((o) => { if (o.cond !== 'Working' && o.pts?.length) { const m = o.pts[Math.floor(o.pts.length / 2)]; pulse(m[0], m[1], o.color); } });
    S.current.dataPts = dataPts;
    S.current.restyle = () => { const z = map.getZoom() - S.current.z0; const r = Math.max(2.5, Math.min(13, 2.8 + z * 2.4)); const w = z < 1 ? (dataPts.length > 1500 ? 0 : 1) : 2; dataPts.forEach(([m, , ring]) => { m.setRadius(ring ? r + 4 : r); if (!ring) m.setStyle({ weight: w, stroke: w > 0 }); }); g.dots.eachLayer((c) => c.setRadius(Math.max(2, Math.min(7, 2.6 + z * 1.2)))); };
    S.current.pins = () => {
      g.pins.clearLayers();
      const z = map.getZoom() - S.current.z0; if (z < 1.5) return;
      const b = map.getBounds().pad(0.05); let n = 0;
      for (const p of data.points) {
        if (!S.current.singleIds?.has(p.id) || !b.contains(ll(p.x, p.y))) continue;
        if (++n > 220) { g.pins.clearLayers(); return; }
        L.marker(ll(p.x, p.y), { interactive: false, keyboard: false, icon: L.divIcon({ className: 'lf-pin-wrap', html: `<span class="lf-pin" style="background:${p.color}">${p.icon || '●'}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(g.pins);
      }
    };
    S.current.clusters(); S.current.restyle(); S.current.pins();
    const ms = Math.round(performance.now() - t0);
    onStats?.({ ms, count: data.points.length + data.lines.length + data.zones.length + data.dots.length });
  }, [data, plan.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- selection highlight ----------
  useEffect(() => {
    const { map, g } = S.current; if (!map) return;
    g.sel.clearLayers();
    const sh = selected?.shape; if (!sh) return;
    const c = shapeCenter(sh); if (!c) return;
    if (sh.t === 'line') L.polyline(sh.c.map(([x, y]) => ll(x, y)), { color: '#0b2a4a', weight: 9, opacity: 0.28, interactive: false }).addTo(g.sel);
    if (sh.t === 'zone') L.polygon(sh.c.map(([x, y]) => ll(x, y)), { color: '#0b2a4a', weight: 4, fill: false, interactive: false }).addTo(g.sel);
    L.marker(ll(c[0], c[1]), { interactive: false, keyboard: false, zIndexOffset: 900, icon: L.divIcon({ className: 'lf-sel-wrap', html: '<span class="lf-sel"></span>', iconSize: [44, 44], iconAnchor: [22, 22] }) }).addTo(g.sel);
    S.current.clusters?.(); S.current.pins?.();
  }, [selected?.id, selected?.shape && JSON.stringify(selected.shape)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- who is affected: the valve to close, the served blocks, the pipe itself ----------
  useEffect(() => {
    const { map, g } = S.current; if (!map) return;
    g.impact.clearLayers();
    if (!impact) return;
    if (impact.line?.length > 1) L.polyline(impact.line.map(([x, y]) => ll(x, y)), { color: '#e5484d', weight: 10, opacity: 0.3, interactive: false }).addTo(g.impact);
    data.zones.forEach((z) => { if ((impact.zoneNames || []).includes(String(z.name || '').trim().toLowerCase())) L.polygon(z.pts.map(([x, y]) => ll(x, y)), { color: '#e5484d', weight: 3, dashArray: '6 4', fillColor: '#e5484d', fillOpacity: 0.16, interactive: false }).addTo(g.impact); });
    if (impact.valve) {
      L.circleMarker(ll(impact.valve.x, impact.valve.y), { radius: 15, color: '#e5484d', weight: 4, fill: false, interactive: false }).addTo(g.impact);
      L.marker(ll(impact.valve.x, impact.valve.y), { interactive: false, keyboard: false, zIndexOffset: 1200, icon: L.divIcon({ className: 'lf-valve-wrap', html: `<span class="lf-valve" data-testid="valve-label">Close first: ${String(impact.valve.name).replace(/[<>&]/g, '')}</span>`, iconSize: [0, 0], iconAnchor: [-14, 34] }) }).addTo(g.impact);
    }
  }, [impact, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- focus ----------
  useEffect(() => {
    const { map } = S.current; if (!map || !focus?.shape) return;
    const sh = focus.shape; const pts = sh.t === 'point' ? [sh.c] : sh.c;
    if (sh.t === 'point') map.flyTo(ll(sh.c[0], sh.c[1]), Math.min(map.getMaxZoom(), S.current.z0 + 3), { duration: 0.6 });
    else map.flyToBounds(L.latLngBounds(pts.map(([x, y]) => ll(x, y))), { padding: [60, 60], maxZoom: S.current.z0 + 3.5, duration: 0.6 });
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- drawing / measuring ----------
  const drawing = mode !== 'view';
  useEffect(() => { setDraft([]); setDirPending(null); S.current.g?.draft.clearLayers(); S.current.g?.snap.clearLayers(); const m = S.current.map; if (m) m.getContainer().style.cursor = mode === 'view' ? '' : 'crosshair'; S.current.clusters?.(); }, [mode]);

  const snapAt = (x, y) => {
    if (!S.current.snapOn) return null;
    const tol = 14 / 2 ** S.current.map.getZoom(); const d = S.current.data;
    let best = null;
    const test = (px, py, kind) => { const dd = Math.hypot(px - x, py - y); if (dd <= tol && (!best || dd < best.d - 0.01)) best = { c: [px, py], d: dd, kind }; };
    d.points.forEach((p) => test(p.x, p.y, 'point'));
    d.lines.forEach((l) => l.pts.forEach(([px, py]) => test(px, py, 'vertex')));
    d.zones.forEach((z) => z.pts.forEach(([px, py]) => test(px, py, 'vertex')));
    if (!best) d.lines.forEach((l) => { const s = snapToLine(l.pts, [x, y]); if (s && s.dist <= tol && (!best || s.dist < best.d)) best = { c: s.c, d: s.dist, kind: 'edge' }; });
    return best;
  };
  S.current.hover = (x, y) => {
    const g = S.current.g; if (!g) return; g.snap.clearLayers();
    if (S.current.mode === 'view') return;
    const s = snapAt(x, y); const pos = s ? s.c : [x, y];
    if (s) L.circleMarker(ll(s.c[0], s.c[1]), { radius: 9, color: '#13917f', weight: 3, fill: false, interactive: false }).addTo(g.snap);
    const dr = S.current.draft;
    if (dr.length && ['line', 'zone', 'measure'].includes(S.current.mode)) L.polyline([ll(...dr[dr.length - 1]), ll(pos[0], pos[1])], { color: '#377dff', weight: 2, dashArray: '4 4', interactive: false }).addTo(g.snap);
    if (S.current.dirPending) L.polyline([ll(...S.current.dirPending), ll(x, y)], { color: '#377dff', weight: 2, dashArray: '4 4', interactive: false }).addTo(g.snap);
  };
  S.current.mapClick = (e) => {
    if (import.meta.env.DEV) (window.__clicks = window.__clicks || []).push([S.current.mode, Math.round(e.latlng.lng), Math.round(S.current.H - e.latlng.lat)]);
    const m = S.current.mode;
    if (m === 'view') { if (Date.now() - (S.current.pickedAt || 0) > 80) S.current.onSelect?.(null); return; }
    let x = e.latlng.lng; let y = S.current.H - e.latlng.lat;
    const s = snapAt(x, y); if (s) [x, y] = s.c;
    x = Math.round(x * 10) / 10; y = Math.round(y * 10) / 10;
    if (x < 0 || y < 0 || x > S.current.W || y > S.current.H) return;
    if (m === 'point' || m === 'break') {
      if (S.current.directional && m === 'point') {
        if (!S.current.dirPending) { setDirPending([x, y]); return; }
        const [px, py] = S.current.dirPending; const dir = Math.round((Math.atan2(x - px, -(y - py)) * 180) / Math.PI + 360) % 360;
        setDirPending(null); S.current.onDraw?.({ t: 'point', c: [px, py], dir }); return;
      }
      S.current.onDraw?.({ t: 'point', c: [x, y] }); return;
    }
    setDraft((d) => [...d, [x, y]]);
  };
  S.current.mapDbl = () => { /* finishing is explicit (button), so a double tap never creates a stray point */ };

  useEffect(() => {
    const g = S.current.g; if (!g) return; g.draft.clearLayers();
    if (!draft.length) return;
    const pts = draft.map(([x, y]) => ll(x, y));
    if (mode === 'zone' && draft.length >= 3) L.polygon(pts, { color: '#377dff', weight: 3, fillColor: '#377dff', fillOpacity: 0.12, interactive: false }).addTo(g.draft);
    else L.polyline(pts, { color: '#377dff', weight: 3, interactive: false }).addTo(g.draft);
    pts.forEach((p, i) => L.circleMarker(p, { radius: i === 0 ? 7 : 5, color: '#fff', weight: 2, fillColor: '#377dff', fillOpacity: 1, interactive: false }).addTo(g.draft));
  }, [draft, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const need = mode === 'zone' ? 3 : 2;
  const len = pathLength(draft);
  const measureTxt = draft.length > 1 ? (mpp ? `${(len * mpp).toFixed(len * mpp < 100 ? 1 : 0)} m` : `${Math.round(len)} px`) : '';
  const finish = () => { if (draft.length < need) return; const c = draft; setDraft([]); if (mode !== 'measure') onDraw?.({ t: mode, c }); };
  const cancel = () => { setDraft([]); setDirPending(null); onCancel?.(); };
  const fit = () => { const m = S.current.map; if (!m) return; m.invalidateSize(); m.fitBounds(S.current.bounds, { padding: [8, 8] }); };

  return (
    <div ref={wrap} className={`infra-map-wrap lf-wrap${full ? ' lf-full' : ''}`} data-testid="leaflet-wrap">
      <div ref={box} className="infra-map lf-map" data-testid="leaflet-map" />
      {drawing && (
        <div className="infra-draw-bar" data-testid="lf-drawbar" role="status">
          <b>{mode === 'measure' ? '📏 Measure' : hint || 'Tap the plan'}</b>
          <span className="muted">{mode === 'measure' ? (measureTxt ? `Length ${measureTxt}` : 'Tap points along the route') : mode === 'point' ? (directional ? (dirPending ? 'Tap where the camera looks' : 'Tap the camera, then where it looks') : 'Tap the spot') : mode === 'break' ? 'Tap the pipe' : `${draft.length} point${draft.length === 1 ? '' : 's'} · need ${need}`}</span>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} data-testid="lf-snap" /> Snap</label>
          {['line', 'zone', 'measure'].includes(mode) && <button type="button" className="btn secondary sm" disabled={!draft.length} onClick={() => setDraft((d) => d.slice(0, -1))} data-testid="lf-undo">Undo</button>}
          {['line', 'zone'].includes(mode) && <button type="button" className="btn sm" disabled={draft.length < need} onClick={finish} data-testid="lf-finish">Finish</button>}
          <button type="button" className="btn secondary sm" onClick={cancel} data-testid="lf-cancel">{mode === 'measure' ? 'Done' : 'Cancel'}</button>
        </div>
      )}
      <button type="button" className="infra-fit lf-fit-labelled" style={{ top: 76 }} aria-label="Fit the whole site" title="Fit the whole site" data-testid="lf-fit" onClick={fit}>⤢<span> Fit site</span></button>
      <button type="button" className="infra-fit" style={{ top: 110 }} aria-label={full ? 'Exit full screen' : 'Full screen'} title="Full screen" data-testid="lf-full" onClick={() => setFull((f) => !f)}>{full ? '✕' : '⛶'}</button>
      <button type="button" className="infra-fit" style={{ top: 144 }} aria-label={mini ? 'Hide the overview' : 'Show the overview'} title="Overview" data-testid="lf-minitoggle" onClick={() => setMini((m) => { const n = !m; try { localStorage.setItem('communityos:minimap', n ? 'on' : 'off'); } catch { /* ignore */ } return n; })}>▣</button>
      {mini && rect && (
        <div className="lf-mini" data-testid="lf-mini" aria-label="Overview of the whole plan. Tap to move the map there." role="img"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const fx = (e.clientX - r.left) / r.width; const fy = (e.clientY - r.top) / r.height; S.current.map?.panTo(ll(fx * W, fy * H)); }}>
          <img src={resolveUrl(plan.imageUrl)} alt="" draggable="false" />
          <span className="lf-mini-view" style={{ left: `${rect.x1 * 100}%`, top: `${rect.y1 * 100}%`, width: `${Math.max(2, (rect.x2 - rect.x1) * 100)}%`, height: `${Math.max(2, (rect.y2 - rect.y1) * 100)}%` }} />
        </div>
      )}
      {scale && <div className="infra-scale"><span style={{ width: scale.w }} />{scale.label}</div>}
      <div className="lf-pos" ref={posRef} aria-hidden="true" />
    </div>
  );
}

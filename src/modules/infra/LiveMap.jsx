import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import '../../lib/infra/leafletSafe.js';
import 'leaflet/dist/leaflet.css';
import { BASES } from '../../lib/infra/geo.js';
import { DASHES } from './infraModel.js';

/**
 * The site plan's assets drawn on a real map (street or satellite). The plan stays the place to draw and edit; this shows the same
 * boundary, lines, outlines and pins at their real positions, and is where a plan is aligned to the earth.
 *
 * props: plan, data (leafletModel.buildLeafletData), boundary [[x,y]...], geo (lib/infra/geo.makeGeo or null), base ('street'|'satellite'|'custom'),
 *        customUrl, selected {id}, onSelect(id), align {a:{x,y}, b:{x,y}} | null  (waiting for two taps on the map), onAligned(aLL, bLL), onCancelAlign(), focus
 */
export default function LiveMap({ plan, data, boundary, geo, base = 'street', customUrl = '', selected, onSelect, align, onAligned, onCancelAlign }) {
  const box = useRef(null); const S = useRef({}); const [taps, setTaps] = useState([]); const [find, setFind] = useState(''); const [msg, setMsg] = useState('');
  Object.assign(S.current, { onSelect, align, onAligned, taps });

  useEffect(() => {
    const map = L.map(box.current, { preferCanvas: true, zoomSnap: 0.5, maxZoom: 21, attributionControl: true });
    map.attributionControl.setPrefix(false);
    if (import.meta.env.DEV) window.__liveMap = map;
    S.current.map = map; S.current.g = { tiles: null, shapes: L.layerGroup().addTo(map), marks: L.layerGroup().addTo(map) };
    map.setView([20.5937, 78.9629], 5);
    map.on('click', (e) => {
      const al = S.current.align; if (!al) return;
      const next = [...S.current.taps, [e.latlng.lat, e.latlng.lng]];
      if (next.length >= 2) { setTaps([]); S.current.onAligned?.({ lat: next[0][0], lng: next[0][1] }, { lat: next[1][0], lng: next[1][1] }); } else setTaps(next);
    });
    return () => { try { map.off(); S.current.g.shapes.clearLayers(); S.current.g.marks.clearLayers(); if (S.current.g.tiles) map.removeLayer(S.current.g.tiles); } catch { /* ignore */ } S.current.map = null; map.remove(); if (import.meta.env.DEV) delete window.__liveMap; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // base layer
  useEffect(() => {
    const { map, g } = S.current; if (!map) return;
    if (g.tiles) map.removeLayer(g.tiles);
    const b = BASES.find((x) => x.id === base);
    const url = base === 'custom' ? customUrl.trim() : b?.url;
    g.tiles = url ? L.tileLayer(url, { maxZoom: 21, maxNativeZoom: b?.max || 19, attribution: base === 'custom' ? 'Map tiles: your provider' : b.attr, crossOrigin: true }).addTo(map) : null;
    if (g.tiles) g.tiles.setZIndex(1);
  }, [base, customUrl]);

  // shapes
  useEffect(() => {
    const { map, g } = S.current; if (!map) return;
    g.shapes.clearLayers();
    if (!geo) return;
    const ll = (x, y) => geo.toLL(x, y);
    const pick = (id) => () => { if (!S.current.align) S.current.onSelect?.(id); };
    const mk = (layer, id, name) => { layer.on('click', pick(id)); if (name) layer.bindTooltip(name, { sticky: true, direction: 'top' }); return layer; };
    const all = [];
    if (boundary?.length >= 3) { const r = boundary.map(([x, y]) => ll(x, y)); L.polygon(r, { color: '#13917f', weight: 3, dashArray: '8 6', fill: false, interactive: false }).addTo(g.shapes); all.push(...r); }
    data.zones.forEach((z) => mk(L.polygon(z.pts.map(([x, y]) => ll(x, y)), { color: z.color, weight: 2, fillColor: z.color, fillOpacity: 0.18 }), z.id, z.name).addTo(g.shapes));
    data.lines.forEach((l) => { const d = DASHES[l.dash]; mk(L.polyline(l.pts.map(([x, y]) => ll(x, y)), { color: l.color, weight: 4, opacity: 0.95, dashArray: d ? d.map((n) => n * 3).join(' ') : null }), l.id, l.name).addTo(g.shapes); });
    data.dots.forEach((d) => mk(L.circleMarker(ll(d.x, d.y), { radius: 3, color: '#fff', weight: 1, fillColor: d.color, fillOpacity: 1 }), d.id).addTo(g.shapes));
    data.points.forEach((p) => {
      mk(L.circleMarker(ll(p.x, p.y), { radius: 7, color: '#fff', weight: 2, fillColor: p.color, fillOpacity: 1 }), p.id, `${p.name} · ${p.cond}`).addTo(g.shapes);
      if (p.overdue) L.circleMarker(ll(p.x, p.y), { radius: 11, color: '#e8a317', weight: 2, fill: false, dashArray: '3 3', interactive: false }).addTo(g.shapes);
      all.push(ll(p.x, p.y));
    });
    if (all.length && !S.current.fitted) { S.current.fitted = true; map.fitBounds(L.latLngBounds(all), { padding: [30, 30], maxZoom: 19 }); }
  }, [data, boundary, geo]);

  // selection ring
  useEffect(() => {
    const { map, g } = S.current; if (!map) return; g.marks.clearLayers();
    if (!geo || !selected?.id) return;
    const p = data.points.find((x) => x.id === selected.id); const l = data.lines.find((x) => x.id === selected.id); const z = data.zones.find((x) => x.id === selected.id);
    const pts = p ? [[p.x, p.y]] : (l || z)?.pts; if (!pts?.length) return;
    const c = pts[Math.floor(pts.length / 2)]; const at = geo.toLL(c[0], c[1]);
    L.circleMarker(at, { radius: 14, color: '#0b2a4a', weight: 3, fill: false, interactive: false }).addTo(g.marks);
  }, [selected, data, geo]);

  // align taps
  useEffect(() => {
    const { g } = S.current; if (!g) return; if (!align) { setTaps([]); }
  }, [align]);
  useEffect(() => {
    const { g } = S.current; if (!g) return; g.marks.eachLayer((m) => { if (m.options.tap) g.marks.removeLayer(m); });
    taps.forEach((t, i) => L.marker(t, { tap: true, icon: L.divIcon({ className: 'lf-pin-wrap', html: `<span class="lf-pin" style="background:#377dff">${i ? 'B' : 'A'}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(g.marks));
  }, [taps]);

  async function search(e) {
    e?.preventDefault(); const q = find.trim(); if (!q) return; setMsg('Searching…');
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      const j = await r.json(); if (!j[0]) return setMsg('No place found. Try the locality and city.');
      S.current.map.setView([Number(j[0].lat), Number(j[0].lon)], 17); setMsg('');
    } catch { setMsg('Search is not reachable from here. Pan and zoom the map instead.'); }
  }
  function here() {
    if (!navigator.geolocation) return setMsg('This device cannot share its location.');
    navigator.geolocation.getCurrentPosition((p) => { S.current.map.setView([p.coords.latitude, p.coords.longitude], 18); setMsg(''); }, () => setMsg('Location was not shared. Pan and zoom the map instead.'), { timeout: 8000 });
  }

  return (
    <div className="infra-map-wrap" data-testid="live-map" style={{ height: 'auto', minHeight: 0 }}>
      <form onSubmit={search} className="lf-find" style={{ display: 'flex', gap: 6, padding: 6, flexWrap: 'wrap' }}>
        <input type="search" aria-label="Find a place on the map" data-testid="live-find" placeholder="Find a place or address…" value={find} onChange={(e) => setFind(e.target.value)} style={{ flex: '1 1 160px', minWidth: 0 }} />
        <button type="submit" className="btn secondary sm" data-testid="live-find-go">Find</button>
        <button type="button" className="btn secondary sm" data-testid="live-here" onClick={here}>📍 My location</button>
      </form>
      {msg && <div className="notice" data-testid="live-msg" style={{ margin: '0 6px 6px' }}>{msg}</div>}
      {align && (
        <div className="notice" data-testid="live-align-hint" style={{ margin: '0 6px 6px' }} role="status">
          {taps.length === 0 ? 'Tap the first spot on the map: the same place you chose on the plan (point A).' : 'Now tap the second spot (point B).'}
          <button type="button" className="btn secondary sm" style={{ marginLeft: 8 }} onClick={() => { setTaps([]); onCancelAlign?.(); }}>Cancel</button>
        </div>
      )}
      {geo && <button type="button" className="btn secondary sm" data-testid="live-fit" style={{ position: 'absolute', right: 10, top: 52, zIndex: 700 }} onClick={() => { const pts = [...(boundary || []), ...data.points.map((q) => [q.x, q.y])].map(([x, y]) => geo.toLL(x, y)); if (pts.length) S.current.map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 19 }); }}>⤢ Fit site</button>}
      <div ref={box} className="lf-box" data-testid="live-canvas" style={{ height: 'min(62vh, 560px)', minHeight: 300, width: '100%' }} />
    </div>
  );
}

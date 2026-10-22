import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import RecordModal from '../billing/RecordModal.jsx';
import Modal from '../../components/Modal.jsx';
import { SegTabs } from '../../components/ui.jsx';
import { takeHint } from '../../lib/openHint.js';
import { Equipment } from '../assets/AssetsModule.jsx';
import AssetTaskDialog from './AssetTaskDialog.jsx';
import HealthBoard from './HealthBoard.jsx';
import InfraSetup from './InfraSetup.jsx';
import { AssetPanel, CalibrateDialog, Overview } from './InfraPanels.jsx';
import { repairKindOf } from './AssetTaskDialog.jsx';
import { TICKET_CATEGORIES } from '../../lib/schema/registry.js';
import { buildLeafletData, sampleAssets } from './leafletModel.js';
import { makeGeo, parseGeoRef, geoRefJson, BASES } from '../../lib/infra/geo.js';
import { impactOf } from '../../lib/infra/impact.js';
import { nearestAssets } from '../../lib/infra/nearest.js';
import { restoreVersion, parseVersion } from '../../lib/infra/mapVersions.js';
import { storage } from '../../lib/storage/index.js';
import MapHistory from './MapHistory.jsx';
import {
  COND_COLOR, fmtLength, pathLength, assetsOnPlan, effectiveCondition, isOverdue, layerOf, mergeLayers, openTicketsByAsset, parseBoundary, parseBreaks, parseShape, pointInPoly, shapeJson, shapeOutside, snapToLine, units,
} from './infraModel.js';

const LeafletMap = lazy(() => import('./LeafletMap.jsx'));
const LiveMap = lazy(() => import('./LiveMap.jsx'));
/** Quantity suggested for a drawn line of identical items (street lights along a road): one per layer spacing. */
function suggestQty(shape, layer, plan) {
  if (shape.t !== 'line' || !layer.dots || !layer.spacing || !plan.metersPerPx) return 1;
  return Math.max(2, Math.round((pathLength(shape.c) * plan.metersPerPx) / layer.spacing) + 1);
}
/** Jump to a task in Maintenance. */
export function openTaskInMaintenance(t, onNavigate) {
  try { sessionStorage.setItem('communityos:openTicket', t.ticketNumber || t.shortId || ''); } catch { /* ignore */ }
  onNavigate?.('tickets');
}
const CONDS = ['All', 'Working', 'Needs attention', 'Under repair', 'Out of service', 'Overdue'];

/**
 * Site map: the same assets, plans and conditions as the Infrastructure page, drawn with Leaflet on a Canvas renderer.
 * Built for many assets (1,000+ stay smooth on a phone): pick by tap, filter by condition and kind, snap while drawing, measure.
 */
function MapTab({ areaFilter, setAreaFilter, startCalibrate, onSetup, onNavigate }) {
  const { currentUser, role } = useApp();
  const me = currentUser?.name || role?.name || '';
  const { records: assets, save: saveAsset, remove: removeAsset } = useCollection(COLLECTIONS.EQUIPMENT, 'Equipment');
  const { records: plans, save: savePlan } = useCollection(COLLECTIONS.INFRA_PLANS, 'Site plans');
  const { records: layerRows } = useCollection(COLLECTIONS.INFRA_LAYERS, 'Map layers');
  const { records: tickets } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const { records: log, save: saveLog } = useCollection(COLLECTIONS.INFRA_LOG, 'Condition log');
  const canEdit = canWriteCollection(COLLECTIONS.EQUIPMENT, getPrincipal());
  const layers = useMemo(() => mergeLayers(layerRows), [layerRows]);
  const sorted = useMemo(() => [...plans].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)), [plans]);
  const openMap = useMemo(() => openTicketsByAsset(tickets), [tickets]);
  const open = useMemo(() => new Set(openMap.keys()), [openMap]);
  const [planId, setPlanId] = useState('');
  const plan = sorted.find((p) => p.id === planId) || sorted[0] || null;
  const boundary = useMemo(() => parseBoundary(plan), [plan?.boundary]); // eslint-disable-line react-hooks/exhaustive-deps

  const [selectedId, setSelectedId] = useState('');
  const [hidden, setHidden] = useState(() => new Set());
  const [cond, setCond] = useState('All');
  const [draw, setDraw] = useState(null); // { kind: 'new'|'place'|'redraw'|'break'|'measure', layer, assetId }
  const [newShape, setNewShape] = useState(null);
  const [taskFor, setTaskFor] = useState(null);
  const [editing, setEditing] = useState(null);
  const [focus, setFocus] = useState(null);
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState(null);
  const [fade, setFade] = useState(0.6);
  const [perf, setPerf] = useState(0);
  const [boundaryAsk, setBoundaryAsk] = useState(null);
  const [calShape, setCalShape] = useState(null);
  const [stats, setStats] = useState(null);
  const [view, setView] = useState('plan'); // plan | street | satellite | custom
  const { roleId } = useApp();
  const isAdmin = roleId === 'super_admin';
  const { records: properties } = useCollection(COLLECTIONS.PROPERTIES, 'Properties & Residents');
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 900px)').matches);
  useEffect(() => { const m = window.matchMedia?.('(max-width: 900px)'); if (!m) return undefined; const f = () => setNarrow(m.matches); m.addEventListener?.('change', f); return () => m.removeEventListener?.('change', f); }, []);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  // the side panel (desktop) can be hidden to give the map the whole width; on a phone it is a sheet: a summary line, or open
  const [panelOpen, setPanelOpen] = useState(() => { try { return localStorage.getItem('communityos:smPanel') !== 'off'; } catch { return true; } });
  const setPanel = (v) => { setPanelOpen(v); try { localStorage.setItem('communityos:smPanel', v ? 'on' : 'off'); } catch { /* not kept */ } };
  const [sheet, setSheet] = useState('peek');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showImpact, setShowImpact] = useState(false);
  const [reportAt, setReportAt] = useState(null); // a spot held down or right-clicked on the map
  const [reportFor, setReportFor] = useState(null); // { asset | null, point }
  const [alignPts, setAlignPts] = useState(null); // the two plan spots chosen, waiting for the matching two taps on the real map
  const [tileDraft, setTileDraft] = useState('');
  const panelRef = useRef(null);

  const real = useMemo(() => (plan ? assetsOnPlan(assets, plan, sorted) : []), [assets, plan, sorted]);
  const sample = useMemo(() => (perf && plan ? sampleAssets(perf, plan, layers, boundary ? (p) => pointInPoly(p, boundary) : null) : []), [perf, plan, layers, boundary]);
  const inArea = useMemo(() => (areaFilter ? real.filter((a) => (a.area || '') === areaFilter) : real), [real, areaFilter]);
  const here = useMemo(() => (sample.length ? [...inArea, ...sample] : inArea), [inArea, sample]);
  const visibleSlugs = useMemo(() => new Set(layers.filter((l) => !hidden.has(l.slug)).map((l) => l.slug)), [layers, hidden]);
  const data = useMemo(() => buildLeafletData(here, { layers, openMap, visible: visibleSlugs, condFilter: cond }), [here, layers, openMap, visibleSlugs, cond]);
  const geo = useMemo(() => makeGeo(parseGeoRef(plan)), [plan?.geoRef]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = assets.find((a) => a.id === selectedId) || null;
  const selSample = sample.find((a) => a.id === selectedId) || null;
  const selShape = parseShape(selected || selSample);
  const unplaced = real.filter((a) => !parseShape(a));
  const activeFilters = (cond !== 'All' ? 1 : 0) + hidden.size + (areaFilter ? 1 : 0);
  const countOf = (c) => real.filter((a) => (c === 'Overdue' ? isOverdue(a) : effectiveCondition(a, open) === c)).length;
  const kindCounts = useMemo(() => { const m = new Map(); here.forEach((a) => { const s = layerOf(layers, a.type).slug; m.set(s, (m.get(s) || 0) + units(a)); }); return m; }, [here, layers]);
  const found = q.trim().length > 1 ? real.filter((a) => `${a.name} ${a.type} ${a.area} ${a.location || ''}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];

  useEffect(() => { if (startCalibrate && plan) { setDraw({ kind: 'calibrate' }); setSelectedId(''); } }, [startCalibrate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!areaFilter || !inArea.length) return;
    const pts = inArea.flatMap((a) => { const sh = parseShape(a); return sh ? (sh.t === 'point' ? [sh.c] : sh.c) : []; });
    if (pts.length) setFocus({ nonce: Date.now(), shape: { t: 'zone', c: [[Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))], [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))], [Math.max(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))]] } });
  }, [areaFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // arriving from a task: show its asset
    let id = ''; try { id = sessionStorage.getItem('communityos:siteMapAsset') || ''; } catch { /* ignore */ }
    const a = id && assets.find((x) => x.id === id); if (!a) return;
    try { sessionStorage.removeItem('communityos:siteMapAsset'); } catch { /* ignore */ }
    setSelectedId(a.id); const sh = parseShape(a); if (sh) setFocus({ nonce: Date.now(), shape: sh });
  }, [assets.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!notice) return undefined; const t = setTimeout(() => setNotice(null), notice.undo ? 14000 : 7000); return () => clearTimeout(t); }, [notice]);

  async function saveAlign(a, b) {
    const ap = alignPts; if (!ap) return;
    const A = { ...ap.a, lat: a.lat, lng: a.lng }; const B = { ...ap.b, lat: b.lat, lng: b.lng };
    const g = makeGeo({ a: A, b: B });
    if (!g) { setNotice({ kind: 'error', text: 'Those two spots are too close together to fix the position. Choose spots further apart.' }); return; }
    const mpp = Number(plan.metersPerPx) || 0;
    const off = mpp ? Math.abs(g.metersPerPx - mpp) / mpp : 0;
    const saved = await savePlan({ ...plan, geoRef: geoRefJson(A, B), ...(mpp ? {} : { metersPerPx: Math.round(g.metersPerPx * 1e4) / 1e4 }) });
    setAlignPts(null);
    if (saved) { if (off > 0.25) setNotice({ kind: 'error', text: `Plan placed on the map, but its scale differs from the one you set by ${Math.round(off * 100)}%. Check that you tapped the same two spots.` }); else undoNotice(plan.id, 'Plan placed on the real map. Pins, lines and the boundary now show at their real positions.', savePlan); }
  }
  const select = (id) => { setSelectedId(id || ''); if (id) { setSheet('open'); setPanelOpen(true); setFiltersOpen(false); setToolsOpen(false); } else setSheet('peek'); };
  const jump = (a) => { select(a.id); const s = parseShape(a); if (s) setFocus({ nonce: Date.now(), shape: s }); setQ(''); };
  const startDraw = (type) => { const L = layers.find((l) => l.type === type); if (L) { setSelectedId(''); setDraw({ kind: 'new', layer: L }); } };
  const startPlace = (a, redraw = false) => { setSelectedId(a.id); setDraw({ kind: redraw ? 'redraw' : 'place', layer: layerOf(layers, a.type), assetId: a.id }); };

  // ----- undo / share / report / who-is-affected -----
  async function undoNotice(recordId, text, saver) {
    let v = null;
    try { const rows = (await storage.list(COLLECTIONS.MAP_VERSIONS)).filter((r) => r.recordId === recordId).sort((a, b) => String(b.at).localeCompare(String(a.at))); v = rows[0] && parseVersion(rows[0]).before ? rows[0] : null; } catch { /* ignore */ }
    setNotice({ kind: 'success', text, undo: v ? { v, saver } : null });
  }
  async function doUndo(n) { const out = await restoreVersion(n.undo.v, n.undo.saver); setNotice({ kind: out ? 'success' : 'error', text: out ? 'Undone. The earlier version is back.' : 'That could not be undone.' }); }
  const linkFor = (assetId) => {
    const q = new URLSearchParams();
    if (assetId) q.set('asset', assetId); if (view !== 'plan') q.set('base', view); if (cond !== 'All') q.set('cond', cond); if (hidden.size) q.set('hide', [...hidden].join(',')); if (sorted.length > 1 && plan) q.set('plan', plan.id);
    const qs = q.toString(); return `${window.location.origin}${window.location.pathname}#/map${qs ? `?${qs}` : ''}`;
  };
  async function share(assetId) {
    const url = linkFor(assetId); if (import.meta.env.DEV) window.__lastMapLink = url;
    try { await navigator.clipboard.writeText(url); setNotice({ kind: 'success', text: 'Link copied. Anyone signed in with access opens the same view.' }); } catch { window.prompt?.('Copy this link', url); }
  }
  const linkRef = useRef(null);
  if (linkRef.current === null) { let qs = ''; try { qs = sessionStorage.getItem('communityos:mapLink') || ''; } catch { /* ignore */ } linkRef.current = qs ? new URLSearchParams(qs.replace(/^\?/, '')) : false; }
  useEffect(() => {
    const q = linkRef.current; if (!q || !plan || !assets.length) return;
    linkRef.current = false; try { sessionStorage.removeItem('communityos:mapLink'); } catch { /* ignore */ }
    const bp = q.get('plan'); if (bp && sorted.some((x) => x.id === bp)) setPlanId(bp);
    const base = q.get('base'); if (['plan', 'street', 'satellite', 'custom'].includes(base)) setView(base);
    const c = q.get('cond'); if (c && CONDS.includes(c)) setCond(c);
    const h = q.get('hide'); if (h) setHidden(new Set(h.split(',').filter(Boolean)));
    const aid = q.get('asset'); const a = aid && assets.find((x) => x.id === aid || x.shortId === aid);
    if (a) { setSelectedId(a.id); const sh = parseShape(a); if (sh) setFocus({ nonce: Date.now(), shape: sh }); } else if (aid) setNotice({ kind: 'error', text: 'The asset in that link no longer exists.' });
  }, [plan?.id, assets.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const placed = useMemo(() => real.map((a) => ({ asset: a, shape: parseShape(a) })).filter((x) => x.shape), [real]);
  const impactInfo = useMemo(() => (selected ? impactOf(selected, assets, properties) : null), [selected, assets, properties]);
  useEffect(() => { setShowImpact(false); }, [selectedId]);
  const impactDraw = useMemo(() => {
    if (!showImpact || !selected || !impactInfo) return null;
    const v = impactInfo.valve ? parseShape(impactInfo.valve) : null;
    return { valve: v?.t === 'point' ? { x: v.c[0], y: v.c[1], name: impactInfo.valve.name } : null, zoneNames: impactInfo.blocks.map((b) => String(b).trim().toLowerCase()), line: selShape?.t === 'line' ? selShape.c : null };
  }, [showImpact, selected, impactInfo, selShape]);

  async function saveBoundary(shape) {
    const saved = await savePlan({ ...plan, boundary: shape ? shapeJson(shape) : '' });
    if (saved) undoNotice(plan.id, shape ? 'Community boundary saved. Pins, lines and outlines can only be placed inside the dashed edge.' : 'Community boundary removed. Assets can be placed anywhere on the plan.', savePlan);
  }
  async function onDraw(shape) {
    const d = draw; setDraw(null); if (!d) return;
    if (d.kind === 'calibrate') { setCalShape(shape); return; }
    if (d.kind === 'georef') {
      const c = shape.c || []; if (c.length < 2 || Math.hypot(c[c.length - 1][0] - c[0][0], c[c.length - 1][1] - c[0][1]) < 20) { setNotice({ kind: 'error', text: 'Choose two spots that are well apart on the plan, for example the main gate and the far corner.' }); return; }
      setAlignPts({ a: { x: c[0][0], y: c[0][1] }, b: { x: c[c.length - 1][0], y: c[c.length - 1][1] } }); setView((v) => (v === 'plan' ? 'satellite' : v)); return;
    }
    if (d.kind === 'boundary') { const n = real.filter((a) => shapeOutside(parseShape(a), shape.c)).length; if (n) setBoundaryAsk({ shape, n }); else await saveBoundary(shape); return; }
    if (d.kind === 'break') {
      const a0 = assets.find((x) => x.id === d.assetId); const sh = parseShape(a0); if (!a0 || !sh || sh.t !== 'line') return;
      const snap = snapToLine(sh.c, shape.c);
      if (!snap || snap.dist > 120) { setNotice({ kind: 'error', text: 'Tap on or close to the pipe to mark the break.' }); return; }
      const next = [...parseBreaks(a0), { c: snap.c.map((v) => Math.round(v * 10) / 10), note: '', at: new Date().toISOString().slice(0, 10), by: me }];
      const saved = await saveAsset({ ...a0, breaks: JSON.stringify(next), status: ['Out of service', 'Under repair'].includes(a0.status) ? a0.status : 'Needs attention' });
      if (saved) { setSelectedId(a0.id); setFocus({ nonce: Date.now(), shape: { t: 'point', c: snap.c } }); undoNotice(a0.id, 'Break marked on the pipe. Raise a task to get it repaired.', saveAsset); }
      return;
    }
    if (boundary && shapeOutside(shape, boundary)) { setNotice({ kind: 'error', text: 'Not placed: part of that shape is outside the community boundary. Draw it again inside the dashed edge.' }); return; }
    if (d.kind === 'new') { setNewShape({ shape, layer: d.layer }); return; }
    const a = assets.find((x) => x.id === d.assetId); if (!a) return;
    const saved = await saveAsset({ ...a, shape: shapeJson(shape), planId: plan.id });
    if (saved) { setSelectedId(a.id); setFocus({ nonce: Date.now(), shape }); undoNotice(a.id, d.kind === 'redraw' ? 'Position updated.' : 'Placed on the plan.', saveAsset); }
  }
  const mode = !draw ? 'view' : draw.kind === 'measure' ? 'measure' : draw.kind === 'break' ? 'break' : draw.kind === 'calibrate' || draw.kind === 'georef' ? 'line' : draw.kind === 'boundary' ? 'zone' : (draw.layer?.geometry || 'Point').toLowerCase();
  const hint = draw?.kind === 'georef' ? 'Tap two spots you can also recognise on the real map (the main gate, a corner of the boundary), then Finish' : draw?.kind === 'calibrate' ? 'Tap two points a known distance apart, then Finish' : draw?.kind === 'boundary' ? 'Tap the corners of the community boundary, then Finish' : draw?.kind === 'break' ? 'Tap the pipe where it is broken' : draw?.kind === 'new' ? `Adding ${draw.layer.type}` : draw?.kind === 'place' || draw?.kind === 'redraw' ? `Place ${assets.find((a) => a.id === draw.assetId)?.name || ''}` : '';

  if (!plan) {
    return (
      <div>
        <div className="card" data-testid="sitemap-noplan"><h3 style={{ marginTop: 0 }}>No site plan yet</h3>{canEdit ? <><p className="muted">Upload the layout of the community (an image or a PDF of the layout drawing). Assets are then placed on it, so it does not need to be to scale.</p><button className="btn" data-testid="goto-setup" onClick={onSetup}>Upload a plan</button></> : <p className="muted">Ask the Facility Manager or the EC to upload the plan.</p>}</div>
      </div>
    );
  }

  return (
    <div>
      <div className={`sm-work${narrow ? ' narrow' : ''}${!narrow && !panelOpen ? ' no-panel' : ''}`} data-testid="sm-work">
      {/* one toolbar row: find, filters and the view on the left; adding and the tools on the right. Everything else lives in the ⋯ menu. */}
      <div className="sm-bar infra-toolbar sm-toolbar" data-testid="sm-toolbar">
        {sorted.length > 1 && <select aria-label="Plan" value={plan.id} onChange={(e) => { setPlanId(e.target.value); setSelectedId(''); }}>{sorted.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <div className="infra-search">
          <input type="search" placeholder="Find an asset…" aria-label="Find an asset" data-testid="lf-find" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.length > 0 && <div className="infra-found" role="listbox">{found.map((a) => <button key={a.id} type="button" role="option" onClick={() => (parseShape(a) ? jump(a) : select(a.id))}><span className="dot" style={{ background: COND_COLOR[effectiveCondition(a, open)] }} />{a.name}<small>{a.area}{parseShape(a) ? '' : ' · not on plan'}</small></button>)}</div>}
        </div>
        <button type="button" className={`btn secondary sm${filtersOpen ? ' on' : ''}`} data-testid="sm-filters-btn" aria-expanded={filtersOpen} onClick={() => { setFiltersOpen((o) => !o); setToolsOpen(false); }}>⚲ Filters{activeFilters ? <span className="seg-badge">{activeFilters}</span> : null}</button>
        {!narrow && (
          <div className="sm-seg" role="group" aria-label="Map background" data-testid="map-bases">
            {[['plan', 'Plan'], ...BASES.map((b) => [b.id, b.label]), ...(plan.tileUrl ? [['custom', 'Own tiles']] : [])].map(([k, label]) => (
              <button key={k} type="button" className={`infra-chip${view === k ? ' on' : ''}`} aria-pressed={view === k} data-testid={`base-${k}`} disabled={!!draw} onClick={() => setView(k)}>{label}</button>
            ))}
            {view !== 'plan' && canEdit && <button type="button" className="btn secondary sm" data-testid="live-align" disabled={!!draw || !!alignPts} onClick={() => { setSelectedId(''); setView('plan'); setDraw({ kind: 'georef' }); }}>🧭 {geo ? 'Re-align to the map' : 'Align plan to the map'}</button>}
          </div>
        )}
        <span className="sm-spacer" />
        {!narrow && <button type="button" className={`btn secondary sm${legendOpen ? ' on' : ''}`} data-testid="sm-legend-btn" aria-pressed={legendOpen} onClick={() => setLegendOpen((o) => !o)}>🎨 Legend</button>}
        {!narrow && (<>
        {canEdit && (
          <select className="infra-add" aria-label="Add on plan" data-testid="lf-add" disabled={view !== 'plan'} value="" onChange={(e) => { if (e.target.value) startDraw(e.target.value); }}>
            <option value="">＋ Add on plan…</option>
            {layers.map((l) => <option key={l.slug} value={l.type}>{l.icon} {l.type} ({l.geometry === 'Line' ? 'line' : l.geometry === 'Zone' ? 'outline' : 'pin'})</option>)}
          </select>
        )}
        </>)}
        <div className="sm-menu-wrap">
          <button type="button" className={`btn secondary sm${toolsOpen ? ' on' : ''}`} data-testid="sm-tools-btn" aria-expanded={toolsOpen} aria-label="More tools" onClick={() => { setToolsOpen((o) => !o); setFiltersOpen(false); }}>⋯{narrow ? '' : ' Tools'}</button>
          {toolsOpen && (
            <div className="sm-menu" data-testid="sm-tools" role="menu">
              {narrow && (<>
                <div className="sm-menu-h">View</div>
                <div className="sm-seg" role="group" aria-label="Map background" data-testid="map-bases">
            {[['plan', 'Plan'], ...BASES.map((b) => [b.id, b.label]), ...(plan.tileUrl ? [['custom', 'Own tiles']] : [])].map(([k, label]) => (
              <button key={k} type="button" className={`infra-chip${view === k ? ' on' : ''}`} aria-pressed={view === k} data-testid={`base-${k}`} disabled={!!draw} onClick={() => setView(k)}>{label}</button>
            ))}
            {view !== 'plan' && canEdit && <button type="button" className="btn secondary sm" data-testid="live-align" disabled={!!draw || !!alignPts} onClick={() => { setSelectedId(''); setView('plan'); setDraw({ kind: 'georef' }); }}>🧭 {geo ? 'Re-align to the map' : 'Align plan to the map'}</button>}
                </div>
                <button type="button" className="btn secondary sm" data-testid="sm-legend-btn" aria-pressed={legendOpen} onClick={() => { setLegendOpen((o) => !o); setToolsOpen(false); }}>🎨 {legendOpen ? 'Hide legend' : 'Legend'}</button>
                {canEdit && <div className="sm-menu-h">Add</div>}
        {canEdit && (
          <select className="infra-add" aria-label="Add on plan" data-testid="lf-add" disabled={view !== 'plan'} value="" onChange={(e) => { if (e.target.value) startDraw(e.target.value); }}>
            <option value="">＋ Add on plan…</option>
            {layers.map((l) => <option key={l.slug} value={l.type}>{l.icon} {l.type} ({l.geometry === 'Line' ? 'line' : l.geometry === 'Zone' ? 'outline' : 'pin'})</option>)}
          </select>
        )}
              </>)}
              <div className="sm-menu-h">Tools</div>
            {canEdit && <button type="button" className="btn secondary sm" data-testid="lf-calibrate" disabled={!!draw || view !== 'plan'} onClick={() => { setSelectedId(''); setNotice(null); setToolsOpen(false); setDraw({ kind: 'calibrate' }); }}>📐 {plan.metersPerPx ? 'Change scale' : 'Set scale'}</button>}
            {canEdit && <button type="button" className="btn secondary sm" data-testid="lf-boundary" disabled={!!draw || view !== 'plan'} onClick={() => { setSelectedId(''); setNotice(null); setToolsOpen(false); setDraw({ kind: 'boundary' }); }}>⬡ {boundary ? 'Redraw boundary' : 'Draw boundary'}</button>}
            {canEdit && boundary && <button type="button" className="btn secondary sm" data-testid="lf-boundary-remove" disabled={!!draw || view !== 'plan'} onClick={() => { setToolsOpen(false); setBoundaryAsk({ remove: true }); }}>Remove boundary</button>}
            <button type="button" className="btn secondary sm" data-testid="lf-measure" disabled={!!draw || view !== 'plan'} onClick={() => { setSelectedId(''); setToolsOpen(false); setDraw({ kind: 'measure' }); }}>📏 Measure</button>
            <button type="button" className="btn secondary sm" data-testid="sm-plan-history" onClick={() => { setToolsOpen(false); setHistoryOpen(true); }}>🕘 Plan history</button>
            <button type="button" className="btn secondary sm" data-testid="sm-share" onClick={() => share('')}>🔗 Share this view</button>
            <label className="lf-fade" title="How strong the plan drawing is"><small className="muted">Plan fade</small><input type="range" min="0.2" max="1" step="0.05" value={fade} aria-label="Plan fade" onChange={(e) => setFade(Number(e.target.value))} /></label>
          {view !== 'plan' && canEdit && (
            <details style={{ marginTop: 6 }} data-testid="live-tiles"><summary className="muted">Map tile source</summary>
              <p className="muted" style={{ margin: '4px 0' }}>Street uses OpenStreetMap and Satellite uses Esri imagery, both free to try. For daily use by many residents, their usage policies expect you to use a provider account of your own (Mapbox, MapTiler, Google, or your own tile server). Paste its tile address here.</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input aria-label="Own tile address" data-testid="tile-url" style={{ flex: '1 1 220px', minWidth: 0 }} placeholder="https://tiles.example.com/{z}/{x}/{y}.png?key=…" value={tileDraft || plan.tileUrl || ''} onChange={(e) => setTileDraft(e.target.value)} />
                <button type="button" className="btn secondary sm" data-testid="tile-save" onClick={async () => { const u = (tileDraft || '').trim(); if (u && !/^https:\/\/.+\{z\}.+\{x\}.+\{y\}/.test(u)) { setNotice({ kind: 'error', text: 'The address must start with https:// and contain {z}, {x} and {y}.' }); return; } if (await savePlan({ ...plan, tileUrl: u })) { setTileDraft(''); setNotice({ kind: 'success', text: u ? 'Saved. "Own tiles" now appears next to Street and Satellite.' : 'Removed.' }); if (u) setView('custom'); } }}>Save</button>
              </div>
            </details>
          )}
          {view === 'plan' && isAdmin && <div className="lf-foot" data-testid="lf-stats">
            <span>Leaflet · canvas</span>{stats && <span><b data-testid="lf-count">{stats.count.toLocaleString()}</b> shapes drawn in <b data-testid="lf-ms">{stats.ms}</b> ms</span>}
            <span className="lf-perf">Speed test:{[0, 1000, 5000].map((n) => <button key={n} type="button" className={`lf-perf-btn${perf === n ? ' on' : ''}`} data-testid={`lf-perf-${n}`} onClick={() => { setPerf(n); setSelectedId(''); }}>{n ? `+${n.toLocaleString()}` : 'Off'}</button>)}</span>
          </div>}
          {view === 'plan' && isAdmin && perf > 0 && <div className="notice" data-testid="lf-perf-note" style={{ marginTop: 6 }}>{perf.toLocaleString()} sample pins are drawn for testing only. They are not saved and do not touch your real assets.</div>}
            </div>
          )}
        </div>
        {!narrow && <button type="button" className="btn secondary sm" data-testid="sm-panel-toggle" aria-pressed={panelOpen} title={panelOpen ? 'Hide the side panel' : 'Show the side panel'} onClick={() => setPanel(!panelOpen)}>{panelOpen ? '⇥' : '⇤'}</button>}
      </div>
      {filtersOpen && (
        <div className="sm-pop" data-testid="sm-filters">
          <div className="sm-pop-head"><b>Show</b>{activeFilters > 0 && <button type="button" className="link-btn" data-testid="sm-filters-clear" onClick={() => { setCond('All'); setHidden(new Set()); setAreaFilter(''); }}>Clear all</button>}<button type="button" className="btn secondary sm" aria-label="Close filters" onClick={() => setFiltersOpen(false)}>✕</button></div>
          <div className="infra-chips" role="group" aria-label="Condition">
            {areaFilter && <button type="button" className="infra-chip on" data-testid="area-clear" onClick={() => setAreaFilter('')}>Area: {areaFilter} ✕</button>}
            {CONDS.map((c) => <button key={c} type="button" className={`infra-chip${cond === c ? ' on' : ''}`} aria-pressed={cond === c} data-testid={`lf-cond-${c.replace(/\s/g, '-')}`} onClick={() => setCond(c)}>{c !== 'All' && <span className="dot" style={{ background: c === 'Overdue' ? '#fff' : COND_COLOR[c], boxShadow: c === 'Overdue' ? '0 0 0 2px #e8a317 inset' : 'none' }} />}{c}{c !== 'All' && <small>{countOf(c)}</small>}</button>)}
          </div>
          <div className="infra-chips layers" role="group" aria-label="Show kinds">
            {layers.filter((l) => kindCounts.has(l.slug) || hidden.has(l.slug)).map((l) => (
              <button key={l.slug} type="button" className={`infra-chip${hidden.has(l.slug) ? ' off' : ''}`} aria-pressed={!hidden.has(l.slug)} data-testid={`lf-layer-${l.slug}`}
                onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(l.slug)) n.delete(l.slug); else n.add(l.slug); return n; })}>{l.icon} {l.type}<small>{kindCounts.get(l.slug) || 0}</small></button>
            ))}
          </div>
        </div>
      )}

      <div className="sm-body">
        <div className="sm-mapcol">
      {notice && (
        <div className={`sm-toast${notice.kind === 'error' ? ' error' : ''}`} role="status" data-testid="lf-notice">
          <span style={{ flex: 1 }}>{notice.text}</span>
          {notice.undo && <button type="button" data-testid="sm-undo" onClick={() => doUndo(notice)}>Undo</button>}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
          {view !== 'plan' && !geo && !alignPts && (
            <div className="card" data-testid="live-needs-align" style={{ marginBottom: 8 }}>
              <b>Place the plan on the real map first</b>
              <p className="muted" style={{ margin: '4px 0 8px' }}>Pick two spots you can recognise on both, such as the main gate and a far corner. Tap them on the plan, then tap the same two spots on the {view === 'satellite' ? 'satellite' : 'street'} map. Your boundary, lines and pins then appear at their real positions, and the plan's scale is set from it.</p>
              {canEdit ? <button type="button" className="btn" data-testid="live-align-start" onClick={() => { setView('plan'); setDraw({ kind: 'georef' }); }}>Start: tap two spots on the plan</button> : <span className="muted">Ask the Facility Manager or the EC to align the plan.</span>}
            </div>
          )}
          {view === 'plan' ? (
          <Suspense fallback={<div className="infra-map-wrap"><div className="infra-map-err">Loading the map…</div></div>}>
            <LeafletMap key={plan.id} plan={plan} data={data} boundary={boundary} selected={selectedId ? { id: selectedId, shape: selShape } : null} mode={mode} directional={draw?.layer?.slug === 'cctv-camera'}
              mpp={plan.metersPerPx || 0} hint={hint} fade={fade} focus={focus} onSelect={select} onDraw={onDraw} onCancel={() => setDraw(null)} onStats={setStats}
              impact={impactDraw} onReport={(pt) => setReportAt({ pt, near: nearestAssets(placed, pt, 3) })} />
          </Suspense>
          ) : (
          <Suspense fallback={<div className="infra-map-wrap"><div className="infra-map-err">Loading the map…</div></div>}>
            <LiveMap key={`${plan.id}-${view}`} plan={plan} data={data} boundary={boundary} geo={geo} base={view} customUrl={plan.tileUrl || ''} selected={selectedId ? { id: selectedId } : null} onSelect={select}
              align={alignPts} onAligned={saveAlign} onCancelAlign={() => setAlignPts(null)} />
          </Suspense>
          )}
          {legendOpen && (
            <div className="sm-legend" data-testid="sm-legend" role="dialog" aria-label="Legend">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Legend</b><button type="button" className="btn secondary sm" aria-label="Close legend" onClick={() => setLegendOpen(false)}>✕</button></div>
              {['Working', 'Needs attention', 'Under repair', 'Out of service'].map((c) => <div key={c} className="row"><span className="sw" style={{ background: COND_COLOR[c] }} />{c}</div>)}
              <div className="row"><span className="sw" style={{ border: '2px dashed #e8a317', background: '#fff' }} />Overdue check</div>
              <div className="row"><span className="sw" style={{ background: '#13917f', borderRadius: 3 }} />Number badge: several assets close together. Tap to zoom in.</div>
              <div className="row"><span className="sw" style={{ border: '2px dashed #13917f', background: '#fff' }} />Community boundary</div>
              <div className="row"><span className="sw" style={{ border: '2px solid #e5484d', background: '#fff' }} />Affected, or valve to close</div>
              <div style={{ marginTop: 6 }}>{layers.filter((l) => kindCounts.has(l.slug)).map((l) => <span key={l.slug} style={{ display: 'inline-block', marginRight: 8 }}>{l.icon} {l.type}</span>)}</div>
              <label className="lf-fade" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}><small className="muted">Plan fade</small><input type="range" min="0.2" max="1" step="0.05" value={fade} aria-label="Plan fade" onChange={(e) => setFade(Number(e.target.value))} /></label>
            </div>
          )}
          {view !== 'plan' && <div className="muted" style={{ fontSize: 13, marginTop: 6 }} data-testid="live-note">To place, move or redraw things, switch back to Plan. The real map shows them at their real positions.</div>}
        </div>
        <aside className={`infra-panel card sm-side${narrow ? ` sm-sheet ${sheet}` : ''}`} ref={panelRef} data-testid="lf-panel">
          {narrow && (
            <button type="button" className="sm-sheet-head" data-testid="sm-sheet-toggle" aria-expanded={sheet === 'open'} onClick={() => setSheet(sheet === 'open' ? 'peek' : 'open')}>
              <span className="sm-sheet-grab" aria-hidden="true" />
              <span className="sm-sheet-sum">{selected ? <><b>{selected.name}</b> · {effectiveCondition(selected, open)}</> : <><b>{real.length}</b> assets · <b>{countOf('Needs attention') + countOf('Out of service')}</b> need attention{unplaced.length ? <> · {unplaced.length} not placed</> : null}</>}</span>
              <span aria-hidden="true">{sheet === 'open' ? '▾' : '▴'}</span>
            </button>
          )}
          <div className="sm-side-body">
          {selected ? (
            <AssetPanel outside={!!(boundary && selShape && shapeOutside(selShape, boundary))} asset={selected} plan={plan} layers={layers} open={open} tickets={tickets} log={log} canEdit={canEdit} me={me}
              onClose={() => setSelectedId('')} onTask={() => setTaskFor(selected)} onOpenTask={(t) => openTaskInMaintenance(t, onNavigate)} onRedraw={() => startPlace(selected, true)} onBreak={() => setDraw({ kind: 'break', layer: { geometry: 'Point', type: 'Break' }, assetId: selected.id })} onFull={() => setEditing(selected)}
              onFocus={() => selShape && setFocus({ nonce: Date.now(), shape: selShape })} saveAsset={saveAsset} removeAsset={removeAsset} saveLog={saveLog} onSelect={select}
              impact={impactInfo} highlight={showImpact} onHighlight={(v) => { setShowImpact(v); if (v && impactInfo?.valve) { const vs = parseShape(impactInfo.valve); if (vs && selShape) { const pts = [...(selShape.t === 'point' ? [selShape.c] : selShape.c), ...(vs.t === 'point' ? [vs.c] : [])]; setFocus({ nonce: Date.now(), shape: { t: 'zone', c: [[Math.min(...pts.map((x) => x[0])), Math.min(...pts.map((x) => x[1]))], [Math.max(...pts.map((x) => x[0])), Math.min(...pts.map((x) => x[1]))], [Math.max(...pts.map((x) => x[0])), Math.max(...pts.map((x) => x[1]))], [Math.min(...pts.map((x) => x[0])), Math.max(...pts.map((x) => x[1]))]] } }); } } }}
              onFocusValve={() => { const vs = impactInfo?.valve && parseShape(impactInfo.valve); if (vs) { setShowImpact(true); setFocus({ nonce: Date.now(), shape: vs }); } }}
              onShare={() => share(selected.id)} onRestored={(text, ok) => setNotice({ kind: ok ? 'success' : 'error', text })} />
          ) : selSample ? (
            <div data-testid="lf-sample-panel"><div className="infra-panel-head"><h3 style={{ margin: 0 }}>{selSample.name}</h3><button type="button" className="btn secondary sm" onClick={() => setSelectedId('')}>Close</button></div>
              <p className="muted">Sample pin for the speed test. It is not a real asset.</p></div>
          ) : (
            <Overview {...{ hereAssets: real, open, countOf, unplaced, canEdit, plan, layers, boundary }} onFilter={setCond} onPlace={(a) => startPlace(a)} onPick={(a) => select(a.id)} />
          )}
          </div>
        </aside>
      </div>
      </div>
      {reportAt && !reportFor && (
        <Modal title="Report an issue here" subtitle={`Spot on the plan${plan.metersPerPx ? '' : ''}. Pick what it is about and a task is raised with this location.`} onClose={() => setReportAt(null)}>
          <div data-testid="report-modal" style={{ display: 'grid', gap: 8 }}>
            {reportAt.near.length === 0 && <p className="muted" style={{ margin: 0 }}>No asset is placed near this spot.</p>}
            {reportAt.near.map((n, i) => (
              <button key={n.asset.id} type="button" className={`btn${i ? ' secondary' : ''}`} data-testid="report-asset" onClick={() => { setReportFor({ asset: n.asset, point: reportAt.pt, away: fmtLength(n.d, plan.metersPerPx) }); }}>
                {i === 0 ? 'Nearest: ' : ''}{n.asset.name} <small>· {n.d < 1 ? 'here' : fmtLength(n.d, plan.metersPerPx)} away</small>
              </button>
            ))}
            <button type="button" className="btn secondary" data-testid="report-noasset" onClick={() => setReportFor({ asset: null, point: reportAt.pt })}>Something else here (no asset)</button>
          </div>
        </Modal>
      )}
      {reportFor && (
        <AssetTaskDialog asset={reportFor.asset || { id: '', name: 'Site map location', area: 'Common area', location: '', type: 'Other', status: 'Working' }} impact={reportFor.asset ? impactOf(reportFor.asset, assets, properties) : null}
          mapPoint={{ ...reportFor.point, away: reportFor.away, geo }} source="Site map · reported on the spot" onClose={() => { setReportFor(null); setReportAt(null); }}
          onDone={(t) => { setReportFor(null); setReportAt(null); setNotice({ kind: 'success', text: `Task ${t?.ticketNumber || ''} raised with this map location. It shows in Maintenance.` }); }} />
      )}
      {historyOpen && plan && (
        <Modal title="Plan history" subtitle="Changes to the boundary, the scale and the plan's place on the real map. Put back restores the version before a change." onClose={() => setHistoryOpen(false)}>
          <MapHistory recordId={plan.id} canEdit={canEdit} save={savePlan} title="Changes" open limit={30} onRestored={(text, ok) => { setNotice({ kind: ok ? 'success' : 'error', text }); setHistoryOpen(false); }} />
        </Modal>
      )}
      {boundaryAsk && (
        <Modal title={boundaryAsk.remove ? 'Remove the community boundary?' : 'Save this boundary?'} onClose={() => setBoundaryAsk(null)}
          subtitle={boundaryAsk.remove ? 'Pins, lines and outlines can then be placed anywhere on the plan.' : `${boundaryAsk.n} asset${boundaryAsk.n === 1 ? ' is' : 's are'} partly or wholly outside it. They stay on the plan and are flagged; redraw each one inside the boundary to edit it.`}>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn secondary" onClick={() => setBoundaryAsk(null)}>Cancel</button>
            <button type="button" className="btn" data-testid="boundary-confirm" onClick={async () => { const a = boundaryAsk; setBoundaryAsk(null); await saveBoundary(a.remove ? null : a.shape); }}>{boundaryAsk.remove ? 'Remove' : 'Save boundary'}</button>
          </div>
        </Modal>
      )}
      {calShape && <CalibrateDialog shape={calShape} plan={plan} onClose={() => setCalShape(null)} onSave={async (mpp) => { await savePlan({ ...plan, metersPerPx: mpp }); setCalShape(null); }} />}
      {newShape && (
        <RecordModal collection={COLLECTIONS.EQUIPMENT} label="Equipment & Assets" title={`New ${newShape.layer.type.toLowerCase()}`} subtitle="The same asset record as in Utilities & Plant → Equipment & assets. Once saved, the name is fixed; only an admin or an EC member can rename it."
          record={{ type: newShape.layer.type, shape: shapeJson(newShape.shape), planId: plan.id, status: 'Working', quantity: suggestQty(newShape.shape, newShape.layer, plan), repairCategory: repairKindOf({ type: newShape.layer.type }, TICKET_CATEGORIES) }}
          onSaved={(a) => select(a.id)} onClose={() => setNewShape(null)} />
      )}
      {taskFor && <AssetTaskDialog asset={taskFor} impact={impactOf(taskFor, assets, properties)} source="Site map" onClose={() => setTaskFor(null)} onDone={(t) => { setTaskFor(null); setNotice({ kind: 'success', text: `Task ${t?.ticketNumber || ''} raised from the Site map. It is linked to the asset and shows in Maintenance.` }); }} />}
      {editing && <RecordModal collection={COLLECTIONS.EQUIPMENT} label="Equipment" record={editing} allowDelete onClose={() => setEditing(null)} />}
    </div>
  );
}

/**
 * Site map: every asset in the community on the site plan, coloured by working condition (Leaflet, drawn on a Canvas so a thousand
 * assets stay smooth on a phone), with a health board by area, the full asset list, and the plans and kinds each community sets up.
 */
export default function SiteMap({ onNavigate }) {
  const { tabAllowed } = useApp();
  const { records: assets, save: saveAsset } = useCollection(COLLECTIONS.EQUIPMENT, 'Equipment');
  const { records: plans, save: savePlan, remove: removePlan } = useCollection(COLLECTIONS.INFRA_PLANS, 'Site plans');
  const { records: layerRows, save: saveLayerRow, remove: removeLayerRow } = useCollection(COLLECTIONS.INFRA_LAYERS, 'Map layers');
  const { records: tickets } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const canEdit = canWriteCollection(COLLECTIONS.EQUIPMENT, getPrincipal());
  const layers = useMemo(() => mergeLayers(layerRows), [layerRows]);
  const sortedPlans = useMemo(() => [...plans].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)), [plans]);
  const openMap = useMemo(() => openTicketsByAsset(tickets), [tickets]);
  const needAttention = useMemo(() => { const o = new Set(openMap.keys()); return assets.filter((a) => ['Needs attention', 'Out of service'].includes(effectiveCondition(a, o))).length; }, [assets, openMap]);
  const all = [['map', 'Map'], ['tasks', 'Tasks'], ['board', 'Health board'], ['list', 'All assets'], ['setup', 'Plans & layers']];
  const tabs = all.filter(([id]) => tabAllowed(`sitemap.${id}`) && (id !== 'setup' || canEdit));
  const [raw, setTab] = useState(() => takeHint(all.map(([id]) => id)) || 'map');
  const tab = tabs.some(([id]) => id === raw) ? raw : tabs[0]?.[0];
  const [areaFilter, setAreaFilter] = useState('');
  const [startCalibrate, setStartCalibrate] = useState(0);
  const planFor = (id) => sortedPlans.find((p) => p.id === id);
  return (
    <div data-testid="sitemap-page" className="sm-page">
      {/* one slim header: the title and the sections on a line, so the map gets the screen */}
      <div className="sm-head">
        <h2>Site map</h2>
        <span className="sm-intro muted">Every asset on the plan, coloured by condition. Tap one for its history or to raise a task.</span>
      </div>
      <SegTabs tabs={tabs.map(([key, label]) => ({ key, label, count: key === 'board' ? needAttention : undefined }))} value={tab} onChange={setTab} label="Site map sections" />
      {tab === 'map' && <MapTab key="map" {...{ areaFilter, setAreaFilter, startCalibrate, onNavigate }} onSetup={() => setTab('setup')} />}
      {tab === 'tasks' && <MapTasks tickets={tickets} assets={assets} onOpen={(t) => openTaskInMaintenance(t, onNavigate)} onShow={(a) => { try { sessionStorage.setItem('communityos:siteMapAsset', a.id); } catch { /* ignore */ } setTab('map'); }} />}
      {tab === 'board' && <HealthBoard assets={assets} openMap={openMap} onShow={(area) => { setAreaFilter(area); setTab('map'); }} />}
      {tab === 'list' && <Equipment />}
      {tab === 'setup' && <InfraSetup {...{ plans: sortedPlans, savePlan, removePlan, layerRows, saveLayerRow, removeLayerRow, assets, saveAsset, layers, canEdit, onCalibrate: (id) => { setStartCalibrate((n) => n + 1); setTab('map'); } }} />}
    </div>
  );
}


/** Every maintenance task tied to an asset on the map, each with its own record id (TKT-…) and a way into Maintenance. */
function MapTasks({ tickets, assets, onOpen, onShow }) {
  const rows = tickets.filter((t) => t.assetId).sort((a, b) => String(b.ticketNumber).localeCompare(String(a.ticketNumber)));
  const byId = new Map(assets.map((a) => [a.id, a]));
  return (
    <div className="card" data-testid="map-tasks">
      <h3 style={{ marginTop: 0 }}>Tasks on assets <small className="muted">· {rows.length}</small></h3>
      <p className="muted" style={{ marginTop: 0 }}>Every maintenance task linked to an asset. Each keeps its own task number. Tasks raised from the map are marked 🗺.</p>
      {rows.length === 0 ? <div className="empty">No task is linked to an asset yet. Open an asset on the map and tap Raise task.</div> : (
        <table className="table"><thead><tr><th>Task #</th><th>Asset</th><th>Kind of repair</th><th>Status</th><th>Raised from</th><th>Issue</th></tr></thead>
          <tbody>{rows.map((t) => {
            const a = byId.get(t.assetId);
            return (
              <tr key={t.id} data-testid="map-task-row">
                <td data-label="Task #"><button type="button" className="tag blue linklike" data-testid="map-task-id" onClick={() => onOpen(t)}>{t.ticketNumber}</button></td>
                <td data-label="Asset">{a ? <button type="button" className="linklike" onClick={() => onShow(a)}>{t.assetName || a.name}</button> : (t.assetName || '—')}{(a?.shortId || t.assetRef) && <small className="mono muted" style={{ display: 'block' }}>{a?.shortId || t.assetRef}</small>}</td>
                <td data-label="Kind of repair">{t.category}</td>
                <td data-label="Status"><span className="tag">{t.status}</span></td>
                <td data-label="Raised from">{t.source === 'Site map' ? '🗺 Site map' : 'Maintenance'}</td>
                <td data-label="Issue">{t.title}</td>
              </tr>
            );
          })}</tbody></table>
      )}
    </div>
  );
}

import { specNamesFor } from '../../lib/assets/specs.js';
import React, { useState } from 'react';
import { DEFAULT_LAYERS, mergeLayers, parseCsv, shapeJson, parseBoundary, pointInPoly } from './infraModel.js';
import { loadPlanSource, renderPlan } from './planImage.js';
import { useApp } from '../../context/AppContext.jsx';

const SAMPLE = 'name,type,area,quantity,faulty,status,x,y\nStreet lights Lane A,Street light,Lane A,12,0,Working,,\nFeeder pillar FP-1,Feeder pillar,Lane A,1,0,Working,42.5,31\nMain gate camera,CCTV camera,Main gate,1,0,Working,60,78\n';

/** Plans (upload, rename, scale), the kinds of asset a community draws, and a CSV import for a long register. */
export default function InfraSetup({ plans, savePlan, removePlan, layerRows, saveLayerRow, removeLayerRow, assets, saveAsset, layers, canEdit, onCalibrate }) {
  const { currentUser } = useApp();
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [source, setSource] = useState(null);
  const [trim, setTrim] = useState({ l: 0, t: 0, r: 0, b: 0 });
  const [reading, setReading] = useState(false);
  const [lighten, setLighten] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [rowEdit, setRowEdit] = useState(null);

  async function chooseFile(f) {
    setFile(f); setSource(null); setTrim({ l: 0, t: 0, r: 0, b: 0 }); setErr(''); setOk('');
    if (!f) return;
    setReading(true);
    try { setSource(await loadPlanSource(f)); } catch (x) { setErr(x.message || String(x)); setFile(null); }
    setReading(false);
  }
  async function addPlan(e) {
    e.preventDefault(); setErr(''); setOk('');
    if (!name.trim()) { setErr('Give the plan a name'); return; }
    if (!file || !source) { setErr('Choose the PDF or image of the plan'); return; }
    setBusy(true);
    try {
      await new Promise((r) => setTimeout(r, 30)); // let "Reading the plan…" paint before the heavy work
      const img = renderPlan(source, { crop: trim, lighten });
      const saved = await savePlan({ name: name.trim(), imageUrl: img.imageUrl, width: img.width, height: img.height, metersPerPx: 0, notes: `Uploaded from ${file.name}`, order: plans.length + 1 });
      if (!saved) throw new Error('The plan could not be saved. The browser storage may be full.');
      setName(''); setFile(null); setSource(null); setOk('Plan added. Open the Map tab and use Set scale to enter one distance you know.');
    } catch (x) { setErr(x.message || String(x)); }
    setBusy(false);
  }

  const allKinds = (() => {
    const rows = new Map(layerRows.map((r) => [String(r.type).toLowerCase(), r]));
    const defaults = DEFAULT_LAYERS.map((d) => ({ ...d, row: rows.get(d.type.toLowerCase()), custom: false }));
    const customs = layerRows.filter((r) => !DEFAULT_LAYERS.some((d) => d.type.toLowerCase() === String(r.type).toLowerCase())).map((r) => ({ type: r.type, geometry: r.geometry, icon: r.icon || '●', row: r, custom: true }));
    return [...defaults, ...customs];
  })();
  const [kind, setKind] = useState({ type: '', geometry: 'Point', icon: '' });
  const [kindErr, setKindErr] = useState('');
  async function toggle(k) {
    if (k.row) await saveLayerRow({ ...k.row, hidden: !k.row.hidden });
    else await saveLayerRow({ type: k.type, geometry: k.geometry, icon: k.icon, hidden: true });
  }
  async function addKind(e) {
    e.preventDefault(); setKindErr('');
    const t = kind.type.trim();
    if (!t) { setKindErr('Name the kind of asset'); return; }
    if (allKinds.some((k) => k.type.toLowerCase() === t.toLowerCase())) { setKindErr('That kind already exists'); return; }
    await saveLayerRow({ type: t, geometry: kind.geometry, icon: kind.icon.trim() || '●', hidden: false });
    setKind({ type: '', geometry: 'Point', icon: '' });
  }

  // ---- CSV import
  const [csv, setCsv] = useState('');
  const [csvMsg, setCsvMsg] = useState({ err: '', ok: '' });
  const [planFor, setPlanFor] = useState('');
  async function importCsv() {
    const { rows, error } = parseCsv(csv);
    if (error) { setCsvMsg({ err: error, ok: '' }); return; }
    const plan = plans.find((p) => p.id === planFor) || plans[0];
    let n = 0; let placed = 0; let outside = 0;
    const bound = parseBoundary(plan);
    for (const r of rows) {
      const L = layers.find((l) => l.type.toLowerCase() === r.type.toLowerCase());
      let canPin = plan && L?.geometry === 'Point' && Number.isFinite(r.xPct) && Number.isFinite(r.yPct);
      // with a community boundary set, a position outside it is not used: the asset is added unplaced
      if (canPin && bound && !pointInPoly([(r.xPct / 100) * plan.width, (r.yPct / 100) * plan.height], bound)) { canPin = false; outside += 1; }
      // eslint-disable-next-line no-await-in-loop
      const saved = await saveAsset({ name: r.name, type: L?.type || r.type, area: r.area || 'Unassigned', quantity: r.quantity, faulty: r.faulty, status: r.status, ...(plan ? { planId: plan.id } : {}), ...(canPin ? { shape: shapeJson({ t: 'point', c: [Math.round((r.xPct / 100) * plan.width), Math.round((r.yPct / 100) * plan.height)] }) } : {}) });
      if (saved) { n += 1; if (canPin) placed += 1; }
    }
    setCsvMsg({ err: '', ok: `${n} asset${n === 1 ? '' : 's'} imported${placed ? `, ${placed} placed on the plan` : ''}. ${outside ? `${outside} had a position outside the community boundary and were not placed. ` : ''}${n - placed ? `${n - placed} still need placing: open the Map tab and tap Place next to each.` : ''}` });
    setCsv('');
  }
  async function readCsvFile(f) { if (f) setCsv(await f.text()); }

  if (!canEdit) return <div className="card muted">Only the EC, Facility Manager and MEP can change plans and layers.</div>;
  return (
    <div data-testid="infra-setup">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Site plans</h3>
        <p className="muted" style={{ marginTop: 0 }}>The picture everything is drawn on. It does not need to be to scale; setting one known distance on the map lets the app measure pipe and cable lengths. A community can have several (the whole site, the STP room, the HT yard).</p>
        {plans.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Plan</th><th>Size</th><th>Scale</th><th /></tr></thead>
            <tbody>{plans.map((p) => {
              const n = assets.filter((a) => a.planId === p.id || (!a.planId && plans[0]?.id === p.id)).length;
              return (
                <tr key={p.id} data-testid={`plan-row-${p.name}`}>
                  <td>{rowEdit?.id === p.id ? <input aria-label="Plan name" value={rowEdit.name} onChange={(e) => setRowEdit({ ...rowEdit, name: e.target.value })} /> : <b>{p.name}</b>}<div className="muted" style={{ fontSize: 12 }}>{n} asset{n === 1 ? '' : 's'}</div></td>
                  <td className="muted">{p.width} × {p.height}</td>
                  <td>{p.metersPerPx > 0 ? <span className="tag green">{(p.metersPerPx * 100).toFixed(1)} cm per pixel</span> : <span className="tag amber">not set</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {rowEdit?.id === p.id ? <><button className="btn sm" onClick={async () => { if (rowEdit.name.trim()) await savePlan({ ...p, name: rowEdit.name.trim() }); setRowEdit(null); }}>Save</button> <button className="btn secondary sm" onClick={() => setRowEdit(null)}>Cancel</button></>
                      : <><button className="btn secondary sm" data-testid={`plan-scale-${p.name}`} onClick={() => onCalibrate(p.id)}>📏 Set scale</button> <button className="btn secondary sm" onClick={() => setRowEdit({ id: p.id, name: p.name })}>Rename</button> <button className="btn secondary sm" disabled={n > 0} title={n ? 'Move or delete its assets first' : ''} onClick={() => removePlan(p.id)}>Delete</button></>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        <form onSubmit={addPlan} style={{ marginTop: 12 }} data-testid="plan-form">
          <h4 style={{ margin: '0 0 6px' }}>Add a plan</h4>
          <div className="form-grid">
            <div className="field"><label>Name *</label><input aria-label="Plan name" data-testid="plan-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Site plan" /></div>
            <div className="field"><label>PDF or image *</label><input type="file" aria-label="Plan file" data-testid="plan-file" accept="application/pdf,image/*" onChange={(e) => chooseFile(e.target.files?.[0] || null)} /></div>
            {reading && <div className="muted" style={{ gridColumn: '1 / -1' }}>Reading the file…</div>}
            {source && (
              <div style={{ gridColumn: '1 / -1' }} data-testid="plan-trim">
                <label style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>Trim the sheet to the site itself (drop tables, notes, title block)</label>
                <div className="infra-trim">
                  <div className="infra-trim-view"><img src={source.preview} alt="Plan preview" /><span className="infra-trim-box" style={{ left: `${trim.l * 100}%`, top: `${trim.t * 100}%`, right: `${trim.r * 100}%`, bottom: `${trim.b * 100}%` }} /></div>
                  <div className="infra-trim-sliders">
                    {[['l', 'From the left'], ['t', 'From the top'], ['r', 'From the right'], ['b', 'From the bottom']].map(([k, lbl]) => (
                      <label key={k}><span>{lbl} <small className="muted">{Math.round(trim[k] * 100)}%</small></span><input type="range" min="0" max="80" step="1" aria-label={lbl} data-testid={`trim-${k}`} value={Math.round(trim[k] * 100)} onChange={(e) => setTrim({ ...trim, [k]: Number(e.target.value) / 100 })} /></label>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row', gridColumn: '1 / -1' }}>
              <input type="checkbox" checked={lighten} onChange={(e) => setLighten(e.target.checked)} style={{ width: 'auto' }} /> Fade the drawing to a soft grey so coloured pins stand out (recommended)
            </label>
          </div>
          {err && <div className="field-error" data-testid="plan-error" style={{ marginTop: 8 }}>{err}</div>}
          {ok && <div className="notice success" data-testid="plan-ok" style={{ marginTop: 8 }}>{ok}</div>}
          <div className="form-actions" style={{ marginTop: 10 }}><button className="btn" type="submit" data-testid="plan-add" disabled={busy || reading}>{busy ? 'Saving the plan…' : 'Add plan'}</button></div>
        </form>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Kinds of asset</h3>
        <p className="muted" style={{ marginTop: 0 }}>How each kind is drawn: a pin (camera, feeder), a line (road, pipe, cable) or an area (plant, clubhouse). Hide the ones this community does not have, or add your own. Changing how a kind is drawn affects assets you add from now on; assets already drawn keep their shape (delete and re-add to redraw them).</p>
        <div className="infra-kinds">
          {allKinds.map((k) => {
            const hidden = !!k.row?.hidden;
            return (
              <div key={k.type} className={`infra-kind${hidden ? ' off' : ''}`} data-testid={`kind-${k.type}`}>
                <span>{k.icon} <b>{k.type}</b>{k.custom && <small className="muted"> · yours</small>}</span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select aria-label={`${k.type} drawn as`} data-testid={`geom-${k.type}`} value={k.row?.geometry || k.geometry} style={{ width: 'auto' }}
                    onChange={(e) => saveLayerRow(k.row ? { ...k.row, geometry: e.target.value } : { type: k.type, icon: k.icon, hidden: false, geometry: e.target.value })}>
                    <option value="Point">Pin</option><option value="Line">Line</option><option value="Zone">Area</option></select>
                  <button className="btn secondary sm" type="button" onClick={() => toggle(k)}>{hidden ? 'Show' : 'Hide'}</button>
                  {k.custom && <button className="btn secondary sm" type="button" onClick={() => removeLayerRow(k.row.id)}>Remove</button>}
                </span>
                <div className="infra-kind-specs">
                  <label>Specs to record</label>
                  <input aria-label={`${k.type} specifications`} data-testid={`specs-${k.type}`} defaultValue={specNamesFor(k.type, layerRows).names.join(', ')} key={`${k.type}-${k.row?.specs || ''}`}
                    onBlur={(e) => { const v = e.target.value.trim(); const cur = specNamesFor(k.type, layerRows).names.join(', '); if (v !== cur) saveLayerRow(k.row ? { ...k.row, specs: v } : { type: k.type, icon: k.icon, geometry: k.geometry, hidden: false, specs: v }); }} />
                </div>
              </div>
            );
          })}
        </div>
        <form onSubmit={addKind} style={{ marginTop: 12 }}>
          <h4 style={{ margin: '0 0 6px' }}>Add a kind</h4>
          <div className="form-grid">
            <div className="field"><label>Name</label><input aria-label="Kind name" data-testid="kind-name" value={kind.type} onChange={(e) => setKind({ ...kind, type: e.target.value })} placeholder="Borewell, Speed breaker…" /></div>
            <div className="field"><label>Drawn as</label><select aria-label="Drawn as" data-testid="kind-geometry" value={kind.geometry} onChange={(e) => setKind({ ...kind, geometry: e.target.value })}><option>Point</option><option>Line</option><option>Zone</option></select></div>
            <div className="field"><label>Icon (emoji)</label><input aria-label="Icon" value={kind.icon} onChange={(e) => setKind({ ...kind, icon: e.target.value })} placeholder="●" /></div>
          </div>
          {kindErr && <div className="field-error" style={{ marginTop: 6 }}>{kindErr}</div>}
          <div className="form-actions" style={{ marginTop: 8 }}><button className="btn secondary" type="submit" data-testid="kind-add">Add kind</button></div>
        </form>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Import a list of assets</h3>
        <p className="muted" style={{ marginTop: 0 }}>For a long register (hundreds of lights, cameras, feeders). Columns: <code>name, type, area, quantity, faulty, status, x, y</code>. <code>x</code> and <code>y</code> are optional and mean percent across and down the plan; anything without them is added to “Not on the plan yet” so you can place it with one tap. Lines (roads, pipes) are drawn on the map.</p>
        <textarea aria-label="CSV" data-testid="csv-text" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={SAMPLE} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => readCsvFile(e.target.files?.[0])} />
          {plans.length > 1 && <select aria-label="Import onto plan" value={planFor} onChange={(e) => setPlanFor(e.target.value)}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          <button className="btn" type="button" data-testid="csv-go" disabled={!csv.trim()} onClick={importCsv}>Import</button>
          <a className="btn secondary sm" download="assets-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`}>Download a template</a>
        </div>
        {csvMsg.err && <div className="field-error" data-testid="csv-error" style={{ marginTop: 8 }}>{csvMsg.err}</div>}
        {csvMsg.ok && <div className="notice success" data-testid="csv-ok" style={{ marginTop: 8 }}>{csvMsg.ok}</div>}
        <small className="muted">Imported by {currentUser?.name || 'you'}. Each row becomes an Equipment &amp; assets record.</small>
      </div>
    </div>
  );
}

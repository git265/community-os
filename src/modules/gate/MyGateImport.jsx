import React, { useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { readInventoryFile, sheetGrid } from '../../lib/inventoryImport.js';
import { DATASETS, BUILDERS, TEMPLATE, autoMap, guessHeaderRow, exportGrid, visitKey } from '../../lib/migrate/mygate.js';
import UnitImport from '../setup/UnitImport.jsx';

const COLS = { dailyHelp: COLLECTIONS.GATE_PEOPLE, vehicles: COLLECTIONS.GATE_VEHICLES, visits: COLLECTIONS.GATE_VISITS };

async function saveGrid(grid, name, csv) {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet(grid); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, `${name}.${csv ? 'csv' : 'xlsx'}`, csv ? { bookType: 'csv' } : undefined);
}

/** Bring a MyGate export into CommunityOS: pick the list, upload the file MyGate gave you, check the match, review, import. */
export default function MyGateImport() {
  const { records: people, refresh: r1 } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const { records: links } = useCollection(COLLECTIONS.GATE_LINKS, 'Gate');
  const { records: vehicles } = useCollection(COLLECTIONS.GATE_VEHICLES, 'Gate');
  const { records: visits } = useCollection(COLLECTIONS.GATE_VISITS, 'Gate');
  const { records: props, refresh: r2 } = useCollection(COLLECTIONS.PROPERTIES, 'Properties');
  const { records: blocks } = useCollection(COLLECTIONS.BLOCKS, 'Blocks');
  const [dsId, setDsId] = useState(''); const [step, setStep] = useState('file');
  const [file, setFile] = useState(null); const [sheets, setSheets] = useState([]); const [sheet, setSheet] = useState(''); const [wbx, setWbx] = useState(null);
  const [grid, setGrid] = useState([]); const [headerRow, setHeaderRow] = useState(0); const [map, setMap] = useState({});
  const [opt, setOpt] = useState({ dial: '+91', status: 'Under review', keepPhones: false, confirmVetted: false });
  const [built, setBuilt] = useState(null); const [result, setResult] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [units, setUnits] = useState(false);
  const ds = DATASETS[dsId];

  const reset = () => { setDsId(''); setStep('file'); setFile(null); setBuilt(null); setResult(null); setErr(''); };
  async function pick(f) {
    if (!f) return; setErr(''); setBusy(true);
    try {
      const { wb, XLSX, sheets: names } = await readInventoryFile(f);
      setWbx({ wb, XLSX }); setFile(f); setSheets(names); setSheet(names[0]);
      const g = sheetGrid(XLSX, wb, names[0]); const h = guessHeaderRow(g, ds); setGrid(g); setHeaderRow(h); setMap(autoMap(g[h] || [], ds)); setStep('map');
    } catch { setErr('That file could not be read. Use the .xlsx or .csv file you downloaded from MyGate.'); }
    setBusy(false);
  }
  function changeSheet(n) { const g = sheetGrid(wbx.XLSX, wbx.wb, n); const h = guessHeaderRow(g, ds); setSheet(n); setGrid(g); setHeaderRow(h); setMap(autoMap(g[h] || [], ds)); }
  const headers = (grid[headerRow] || []).map((h, i) => ({ i, label: String(h || `Column ${i + 1}`) }));
  const missing = ds ? ds.fields.filter(([f, , req]) => req && !(map[f] >= 0)).map(([, l]) => l) : [];

  function review() {
    const ctx = {
      ...opt, existingPeople: people, existingLinks: links, existingVehicles: vehicles, existingKeys: visits.map(visitKey),
      units: new Set(props.map((p) => String(p.unit).trim().toLowerCase())),
    };
    setBuilt(BUILDERS[dsId](grid, headerRow, map, ctx)); setStep('review');
  }

  async function run() {
    setBusy(true); setErr('');
    try {
      const col = COLS[dsId]; const news = built.rows.filter((x) => x.isNew); const ups = built.rows.filter((x) => !x.isNew);
      const note = `Imported from MyGate (${file?.name || 'file'})`;
      let created = [];
      if (news.length) created = await secureStorage.createMany(col, news.map((x) => x.record), { label: ds.label, summary: `${note}: ${news.length} added` });
      if (ups.length) await secureStorage.updateMany(col, ups.map((x) => x.record), { label: ds.label, summary: `${note}: ${ups.length} updated` });
      let linked = 0;
      if (dsId === 'dailyHelp') {
        const byPhone = new Map([...people, ...created].map((p) => [p.phone, p]));
        const rows = [];
        for (const x of built.rows) {
          const p = x.isNew ? created.find((c) => c.phone === x.record.phone) : byPhone.get(people.find((q) => q.id === x.record.id)?.phone);
          if (p) for (const u of x.units) rows.push({ personId: p.id, personName: p.name, unit: props.find((q) => String(q.unit).toLowerCase() === u.toLowerCase())?.unit || u, days: [], fromTime: '', toTime: '', status: 'Active' });
        }
        if (rows.length) await secureStorage.createMany(COLLECTIONS.GATE_LINKS, rows, { label: 'Villa links', summary: `${note}: ${rows.length} villa links` });
        linked = rows.length;
      }
      setResult({ added: news.length, updated: ups.length, skipped: built.errors.length, linked }); setStep('done'); r1?.(); r2?.();
    } catch (e) { setErr(e.message || 'The import failed'); }
    setBusy(false);
  }

  if (units) return <UnitImport existing={props} blocks={blocks} onClose={() => setUnits(false)} onDone={() => r2?.()} />;

  return (
    <div data-testid="mygate-import">
      {!ds && (
        <div>
          <p className="muted" style={{ marginTop: 0 }}>Moving from MyGate? In the MyGate admin portal, download each list as Excel or CSV, then bring it in here. Nothing is connected to MyGate; you control the files. Plan and steps: <b>docs/MYGATE_MIGRATION.md</b>.</p>
          <ol className="muted" style={{ paddingLeft: 18 }}>
            <li>Residents and flats first (so villas exist), then daily help, vehicles, and last the visitor history.</li>
            <li>Each step shows what will happen before anything is written. You can run an import again: people, plates and visits already here are matched, not doubled.</li>
          </ol>
          <div className="gg-card" data-testid="mg-dataset-residents"><div className="gg-main"><b>1 · Residents & flats</b><span className="muted">Owners, tenants and phones. Uses the Unit import.</span></div><button type="button" className="btn secondary sm" data-testid="mg-open-units" onClick={() => setUnits(true)}>Open</button></div>
          {Object.values(DATASETS).map((d, i) => (
            <div className="gg-card" key={d.id} data-testid={`mg-dataset-${d.id}`}><div className="gg-main"><b>{i + 2} · {d.label}</b><span className="muted">{d.note}</span></div>
              <button type="button" className="btn secondary sm" data-testid={`mg-open-${d.id}`} onClick={() => { setDsId(d.id); setStep('file'); }}>Open</button></div>
          ))}
          <p className="muted" style={{ marginTop: 12 }}>Not imported yet: complaints, notices, payments and amenity bookings (see the plan for why and how).</p>
        </div>
      )}

      {ds && (
        <div>
          <div className="form-actions" style={{ marginBottom: 8 }}><button type="button" className="btn secondary sm" onClick={reset}>← All lists</button><b>{ds.label}</b></div>
          {err && <div className="notice error" role="alert" data-testid="mg-error">{err}</div>}

          {step === 'file' && (
            <div>
              <input type="file" accept=".xlsx,.xls,.csv" data-testid="mg-file" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
              <div className="form-actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn secondary sm" data-testid="mg-template" onClick={() => saveGrid(TEMPLATE[dsId], `${dsId}-template`)}>Download a template</button>
                <button type="button" className="btn secondary sm" data-testid="mg-export" onClick={() => saveGrid(exportGrid(dsId, { people, links, vehicles, visits }), `communityos-${dsId}`, true)}>Download what is here now (CSV)</button>
              </div>
              <small className="muted">The template and the download use the same columns this importer reads.</small>
            </div>
          )}

          {step === 'map' && (
            <div>
              <p className="muted">{file?.name} · {Math.max(0, grid.length - headerRow - 1)} rows. Check that each field matches the right column.</p>
              <div className="form-grid">
                {sheets.length > 1 && <div className="field"><label>Sheet</label><select value={sheet} onChange={(e) => changeSheet(e.target.value)}>{sheets.map((s) => <option key={s}>{s}</option>)}</select></div>}
                <div className="field"><label>Heading row</label><select value={headerRow} onChange={(e) => { const h = Number(e.target.value); setHeaderRow(h); setMap(autoMap(grid[h] || [], ds)); }}>{grid.slice(0, 15).map((r, i) => <option key={i} value={i}>Row {i + 1}: {String(r.filter(Boolean).slice(0, 3).join(' · ')).slice(0, 40)}</option>)}</select></div>
                {ds.fields.map(([f, label, req]) => (
                  <div className="field" key={f}><label>{label}{req ? ' *' : ''}</label>
                    <select data-testid={`mg-map-${f}`} value={map[f] ?? -1} onChange={(e) => setMap((m) => ({ ...m, [f]: Number(e.target.value) }))}>
                      <option value={-1}>— not in the file —</option>{headers.map((h) => <option key={h.i} value={h.i}>{h.label}</option>)}
                    </select></div>
                ))}
                <div className="field"><label>Country code for numbers without one</label><input data-testid="mg-dial" value={opt.dial} onChange={(e) => setOpt({ ...opt, dial: e.target.value })} /></div>
                {dsId === 'dailyHelp' && <div className="field"><label>Add new people as</label>
                  <select data-testid="mg-status" value={opt.status} onChange={(e) => setOpt({ ...opt, status: e.target.value, confirmVetted: false })}><option>Under review</option><option>Active</option></select>
                  <small className="muted">“Under review” means security checks them before they are let in. Choose Active only if MyGate vetting is enough for you.</small></div>}
                {dsId === 'visits' && <label className="gg-row" style={{ gridColumn: '1 / -1' }}><input type="checkbox" style={{ width: 'auto' }} checked={opt.keepPhones} onChange={(e) => setOpt({ ...opt, keepPhones: e.target.checked })} /> Keep visitors’ full mobile numbers (otherwise only the last 4 digits are kept)</label>}
              </div>
              {missing.length > 0 && <div className="notice error">Pick a column for: {missing.join(', ')}</div>}
              <div className="form-actions"><button type="button" className="btn" data-testid="mg-next" disabled={missing.length > 0} onClick={review}>Review</button><button type="button" className="btn secondary" onClick={() => setStep('file')}>Back</button></div>
            </div>
          )}

          {step === 'review' && built && (
            <div>
              <div className="kpi-row" data-testid="mg-review">
                <span className="tag green" data-testid="mg-review-new">{built.rows.filter((x) => x.isNew).length} new</span>{' '}
                <span className="tag" data-testid="mg-review-upd">{built.rows.filter((x) => !x.isNew).length} already here (updated)</span>{' '}
                <span className={`tag ${built.errors.length ? 'red' : ''}`} data-testid="mg-review-errors">{built.errors.length} skipped</span>{' '}
                {built.warnings.length > 0 && <span className="tag amber" data-testid="mg-review-warn">{built.warnings.length} warnings</span>}
              </div>
              {built.errors.length > 0 && <details open><summary>Skipped rows</summary><ul className="muted">{built.errors.slice(0, 30).map((e, i) => <li key={i}>Line {e.line} · {e.who}: {e.message}</li>)}{built.errors.length > 30 && <li>…and {built.errors.length - 30} more</li>}</ul></details>}
              {built.warnings.length > 0 && <details><summary>Warnings</summary><ul className="muted">{built.warnings.slice(0, 30).map((e, i) => <li key={i}>Line {e.line} · {e.who}: {e.message}</li>)}</ul></details>}
              {dsId === 'dailyHelp' && opt.status === 'Active' && built.rows.some((x) => x.isNew) && (
                <label className="gg-row"><input type="checkbox" data-testid="mg-confirm" style={{ width: 'auto' }} checked={opt.confirmVetted} onChange={(e) => setOpt({ ...opt, confirmVetted: e.target.checked })} /> I confirm these people were already vetted, so they may enter straight away.</label>
              )}
              <div className="form-actions"><button type="button" className="btn" data-testid="mg-run" disabled={busy || !built.rows.length || (dsId === 'dailyHelp' && opt.status === 'Active' && built.rows.some((x) => x.isNew) && !opt.confirmVetted)} onClick={run}>{busy ? 'Importing…' : `Import ${built.rows.length}`}</button><button type="button" className="btn secondary" onClick={() => setStep('map')}>Back</button></div>
            </div>
          )}

          {step === 'done' && result && (
            <div data-testid="mg-done"><div className="notice" role="status">Done: {result.added} added, {result.updated} updated{result.linked ? `, ${result.linked} villa links` : ''}{result.skipped ? `, ${result.skipped} skipped` : ''}.</div>
              <div className="form-actions"><button type="button" className="btn" onClick={reset}>Next list</button></div></div>
          )}
        </div>
      )}
    </div>
  );
}

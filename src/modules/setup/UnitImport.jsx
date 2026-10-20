import React, { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { readInventoryFile, sheetGrid } from '../../lib/inventoryImport.js';
import { UNIT_FIELDS, autoMapUnits, guessUnitHeaderRow, buildUnitRows, downloadUnitTemplate } from '../../lib/unitImport.js';
import { propertyTypes } from '../../lib/locale.js';

/** Import the unit directory from an Excel / CSV file: map columns, review problems, then add and update all units at once. */
export default function UnitImport({ existing, blocks, onClose, onDone }) {
  const [step, setStep] = useState('file');
  const [file, setFile] = useState(null); const [sheets, setSheets] = useState([]); const [sheet, setSheet] = useState(''); const [wbx, setWbx] = useState(null);
  const [grid, setGrid] = useState([]); const [headerRow, setHeaderRow] = useState(0); const [map, setMap] = useState({});
  const [result, setResult] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [addBlocks, setAddBlocks] = useState(true);

  async function pick(f) {
    if (!f) return; setErr(''); setBusy(true);
    try {
      const { wb, XLSX, sheets: names } = await readInventoryFile(f);
      setWbx({ wb, XLSX }); setFile(f); setSheets(names); setSheet(names[0]);
      const g = sheetGrid(XLSX, wb, names[0]); const h = guessUnitHeaderRow(g); setGrid(g); setHeaderRow(h); setMap(autoMapUnits(g[h] || [])); setStep('map');
    } catch (e) { setErr('That file could not be read. Use an .xlsx or .csv file.'); }
    setBusy(false);
  }
  function changeSheet(name) { const g = sheetGrid(wbx.XLSX, wbx.wb, name); const h = guessUnitHeaderRow(g); setSheet(name); setGrid(g); setHeaderRow(h); setMap(autoMapUnits(g[h] || [])); }
  const headers = (grid[headerRow] || []).map((h, i) => ({ i, label: String(h || `Column ${i + 1}`) }));
  const built = step === 'review' ? buildUnitRows(grid, headerRow, map, { existing, defaultType: propertyTypes()[0] }) : null;
  const missing = UNIT_FIELDS.filter(([f, , req]) => req && !(map[f] >= 0)).map(([, l]) => l);

  async function run() {
    setBusy(true); setErr('');
    try {
      const news = built.rows.filter((x) => x.isNew).map((x) => x.record); const ups = built.rows.filter((x) => !x.isNew).map((x) => x.record);
      if (addBlocks) {
        const have = new Set(blocks.map((b) => b.name)); const want = [...new Set(built.rows.map((x) => x.record.zone).filter((z) => z && !have.has(z)))];
        if (want.length) await secureStorage.createMany(COLLECTIONS.BLOCKS, want.map((name) => ({ name, kind: 'Other', active: true, plannedUnits: built.rows.filter((x) => x.record.zone === name).length })), { label: 'Blocks & Towers', summary: `Added ${want.length} blocks from the unit file` });
      }
      if (news.length) await secureStorage.createMany(COLLECTIONS.PROPERTIES, news.map((r) => ({ ...r, residentsCount: 0, outstanding: 0 })), { label: 'Properties & Residents', summary: `Imported ${news.length} units from Excel` });
      if (ups.length) await secureStorage.updateMany(COLLECTIONS.PROPERTIES, ups, { label: 'Properties & Residents', summary: `Updated ${ups.length} units from Excel` });
      setResult({ added: news.length, updated: ups.length, skipped: built.errors.length }); setStep('done'); onDone?.();
    } catch (e) { setErr(e.message || 'The import failed'); }
    setBusy(false);
  }

  return (
    <Modal title="Import units from Excel" subtitle="One row per unit. New units are added; units already in the directory (same unit number) are updated." onClose={onClose}>
      <div data-testid="unit-import">
        {err && <div className="notice error">{err}</div>}
        {step === 'file' && (
          <div>
            <input type="file" accept=".xlsx,.xls,.csv" data-testid="uimp-file" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
            <p className="muted">Columns it recognises: unit, block / tower, type, owner, owner phone, e-mail, occupancy, tenant, tenant phone, area, bedrooms, parking. <button type="button" className="link-btn" data-testid="uimp-template" onClick={downloadUnitTemplate}>Download a template</button></p>
          </div>
        )}
        {step === 'map' && (
          <div>
            <p className="muted">{file?.name} · {grid.length} rows</p>
            <div className="form-grid">
              {sheets.length > 1 && <div className="field"><label>Sheet</label><select value={sheet} onChange={(e) => changeSheet(e.target.value)}>{sheets.map((s) => <option key={s}>{s}</option>)}</select></div>}
              <div className="field"><label>Heading row</label><input type="number" min="1" value={headerRow + 1} onChange={(e) => { const h = Math.max(0, Number(e.target.value) - 1); setHeaderRow(h); setMap(autoMapUnits(grid[h] || [])); }} /></div>
              {UNIT_FIELDS.map(([f, label, req]) => (
                <div className="field" key={f}><label>{label}{req ? ' *' : ''}</label>
                  <select data-testid={`umap-${f}`} value={map[f] ?? -1} onChange={(e) => setMap((m) => ({ ...m, [f]: Number(e.target.value) }))}><option value={-1}>— not in the file —</option>{headers.map((h) => <option key={h.i} value={h.i}>{h.label}</option>)}</select></div>
              ))}
            </div>
            {missing.length > 0 && <div className="field-error">Map: {missing.join(', ')}</div>}
            <div className="form-actions"><button className="btn" data-testid="uimp-next" disabled={missing.length > 0} onClick={() => setStep('review')}>Review</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
          </div>
        )}
        {step === 'review' && built && (
          <div>
            <div className="notice" data-testid="uimp-summary"><b>{built.news}</b> new unit{built.news === 1 ? '' : 's'} · <b>{built.updates}</b> to update · <b>{built.errors.length}</b> row{built.errors.length === 1 ? '' : 's'} with a problem (skipped)</div>
            {built.errors.length > 0 && (
              <div style={{ maxHeight: 200, overflow: 'auto', marginTop: 8 }} data-testid="uimp-errors">
                <table className="resp-table"><thead><tr><th>Row</th><th>Unit</th><th>Problem</th></tr></thead>
                  <tbody>{built.errors.slice(0, 200).map((e) => <tr key={e.line}><td data-label="Row">{e.line}</td><td data-label="Unit">{e.unit}</td><td data-label="Problem">{e.message}</td></tr>)}</tbody></table>
                {built.errors.length > 200 && <small className="muted">…and {built.errors.length - 200} more</small>}
              </div>
            )}
            <label className="check" style={{ display: 'block', marginTop: 10 }}><input type="checkbox" checked={addBlocks} onChange={(e) => setAddBlocks(e.target.checked)} /> Add any block / tower names from the file that are not in the list yet</label>
            <div className="form-actions"><button className="btn" data-testid="uimp-go" disabled={busy || built.rows.length === 0} onClick={run}>{busy ? 'Importing…' : `Import ${built.rows.length} units`}</button><button className="btn secondary" onClick={() => setStep('map')}>Back</button></div>
          </div>
        )}
        {step === 'done' && result && (
          <div><div className="notice" data-testid="uimp-done">✅ {result.added} added · {result.updated} updated{result.skipped ? ` · ${result.skipped} skipped` : ''}.</div><div className="form-actions"><button className="btn" onClick={onClose}>Close</button></div></div>
        )}
      </div>
    </Modal>
  );
}

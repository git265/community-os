import React, { useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import InventoryRules from './InventoryRules.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { FIELDS, autoMap, guessHeaderRow, buildLines, suggestKeyword, readInventoryFile, sheetGrid, downloadTemplate, DEFAULT_RULES } from '../../lib/inventoryImport.js';
import { stockStatusFor } from './InventoryModule.jsx';

const UOMS = ['Nos', 'Kg', 'Litres', 'Metres', 'Boxes', 'Sets'];
const sig = (headers) => `communityos:invColMap:${headers.map((h) => String(h).trim().toLowerCase()).filter(Boolean).join('|').slice(0, 300)}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Import inventory from Excel / CSV: pick the file -> check the column mapping (guessed from the headers) -> review every line,
 * already tagged with a category by the mapping rules -> import. Corrections can be remembered as new rules.
 */
export default function ExcelImport({ onClose }) {
  const { schemaFor } = useApp();
  const { records: stock, save } = useCollection(C.INVENTORY, 'Inventory');
  const { records: storedRules, save: saveRule, refresh: refreshRules } = useCollection(C.INVENTORY_RULES, 'Inventory import rules');
  const categories = schemaFor(C.INVENTORY)?.fields.find((f) => f.key === 'category')?.options || ['General'];
  const rules = storedRules.length ? storedRules : DEFAULT_RULES;
  const [step, setStep] = useState('pick'); // pick | map | review | saving | done
  const [err, setErr] = useState('');
  const [file, setFile] = useState(null);
  const [book, setBook] = useState(null); // { wb, XLSX, sheets }
  const [sheet, setSheet] = useState('');
  const [grid, setGrid] = useState([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState({});
  const [remember, setRemember] = useState(true);
  const [lines, setLines] = useState([]);
  const [skippedBlank, setSkippedBlank] = useState(0);
  const [existingMode, setExistingMode] = useState('set');
  const [view, setView] = useState('all');
  const [showRules, setShowRules] = useState(false);
  const [result, setResult] = useState(null);
  const inp = useRef(null);

  const headers = grid[headerRow] || [];
  async function pickFile(f) {
    if (!f) return;
    setErr('');
    try {
      const b = await readInventoryFile(f);
      setFile(f); setBook(b); useSheet(b, b.sheets[0]);
      setStep('map');
    } catch (e) { setErr(`Could not read that file: ${e?.message || 'unsupported format'}. Use .xlsx, .xls or .csv.`); }
    finally { if (inp.current) inp.current.value = ''; }
  }
  function useSheet(b, name) {
    const g = sheetGrid(b.XLSX, b.wb, name); const hr = guessHeaderRow(g);
    setSheet(name); setGrid(g); setHeaderRow(hr);
    let m = autoMap(g[hr] || []);
    try { const saved = JSON.parse(localStorage.getItem(sig(g[hr] || [])) || 'null'); if (saved) m = { ...m, ...saved }; } catch { /* ignore */ }
    setMap(m);
  }
  function changeHeaderRow(n) {
    const hr = Math.max(0, Number(n) - 1 || 0); setHeaderRow(hr); setMap(autoMap(grid[hr] || []));
  }
  const sample = (f) => { const i = map[f]; if (i === undefined || i < 0) return ''; const r = grid.slice(headerRow + 1).find((x) => String(x[i] ?? '').trim() !== ''); return r ? String(r[i]).slice(0, 28) : ''; };
  const mapOk = map.item >= 0 && map.quantity >= 0;

  function toReview() {
    if (remember) { try { localStorage.setItem(sig(headers), JSON.stringify(map)); } catch { /* ignore */ } }
    const out = buildLines(grid, headerRow, map, { rules, categories, stock });
    setLines(out.lines); setSkippedBlank(out.skipped); setStep('review');
  }
  const upd = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const needs = lines.filter((l) => l.how === 'none');
  const shown = lines.filter((l) => view === 'all' || (view === 'needs' ? l.how === 'none' : view === 'existing' ? !!l.existingId : !l.existingId));
  const chosen = lines.filter((l) => l.include && l.item.trim() && !(l.existingId && existingMode === 'skip'));
  const changed = (l) => l.category !== l.auto;

  async function doImport() {
    setStep('saving'); setErr('');
    try {
      let added = 0; let updated = 0; let skipped = 0; let rulesMade = 0;
      for (const l of lines) {
        if (!l.include) { skipped += 1; continue; }
        const ex = l.existingId ? stock.find((s) => s.id === l.existingId) : null;
        if (ex && existingMode === 'skip') { skipped += 1; continue; }
        const qty = ex ? (existingMode === 'add' ? (Number(ex.quantity) || 0) + (Number(l.quantity) || 0) : Number(l.quantity) || 0) : Number(l.quantity) || 0;
        const min = l.minStock !== '' && l.minStock !== undefined ? Number(l.minStock) || 0 : Number(ex?.minStock) || 0;
        const rec = {
          ...(ex || {}), item: ex?.item || l.item.trim(), category: l.category, location: l.location || ex?.location || 'Main store', quantity: qty, uom: l.uom || ex?.uom || 'Nos', minStock: min,
          stockStatus: stockStatusFor(qty, min), vendor: l.vendor || ex?.vendor || '', lastRestocked: l.lastRestocked || ex?.lastRestocked || '',
          warrantyUntil: l.warrantyUntil || ex?.warrantyUntil || '', notes: l.notes ? `<p>${esc(l.notes)}</p>` : (ex?.notes || ''), attachments: ex?.attachments || [],
        };
        const ok = await save(rec); if (ok) { if (ex) updated += 1; else added += 1; }
      }
      // corrections the person asked to remember become rules (above the standard ones)
      const have = new Set(storedRules.flatMap((r) => (Array.isArray(r.keywords) ? r.keywords : []).map((k) => String(k).toLowerCase())));
      const made = new Set();
      for (const l of lines.filter((x) => x.include && x.remember !== false && changed(x))) {
        const k = suggestKeyword(l.item); if (!k || have.has(k) || made.has(k)) continue;
        if (await saveRule({ name: `${k} → ${l.category}`, matchOn: 'Item description', keywords: [k], category: l.category, priority: 80, active: true })) { rulesMade += 1; made.add(k); }
      }
      if (rulesMade) refreshRules();
      setResult({ added, updated, skipped, rulesMade }); setStep('done');
    } catch (e) { setErr(`Could not import: ${e?.message || 'error'}`); setStep('review'); }
  }

  const stepNo = { pick: 1, map: 2, review: 3, saving: 3, done: 3 }[step];
  return (
    <>
      <Modal title="Import inventory from Excel" subtitle="Upload a stock list, check the columns, review the categories, then import." onClose={onClose} wide>
        <div className="muted" data-testid="imp-steps" style={{ marginBottom: 8, fontSize: 13 }}>Step {stepNo} of 3 · {['Choose file', 'Match columns', 'Review & import'][stepNo - 1]}</div>
        {err && <div className="notice error" data-testid="imp-error">{err}</div>}

        {step === 'pick' && (
          <div>
            <label className="btn" data-testid="imp-choose" style={{ display: 'inline-block', cursor: 'pointer' }}>
              Choose Excel / CSV file
              <input ref={inp} type="file" data-testid="imp-file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files?.[0])} />
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button type="button" className="btn secondary sm" data-testid="imp-template" onClick={downloadTemplate}>⬇ Download template</button>
              <button type="button" className="btn secondary sm" data-testid="imp-rules" onClick={() => setShowRules(true)}>⚙ Mapping rules</button>
            </div>
            <p className="muted" style={{ marginTop: 10 }}>Any column order works: headers like “Item”, “Description”, “Qty”, “UOM” are recognised. Items are filed under a category from their description using your mapping rules; you can correct any of them before importing.</p>
          </div>
        )}

        {step === 'map' && (
          <div data-testid="imp-map">
            <div className="exp-tools" style={{ marginBottom: 8 }}>
              <b>{file?.name}</b>
              {book?.sheets.length > 1 && <select aria-label="Sheet" data-testid="imp-sheet" value={sheet} onChange={(e) => useSheet(book, e.target.value)}>{book.sheets.map((s) => <option key={s}>{s}</option>)}</select>}
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Header row <input type="number" min="1" aria-label="Header row" data-testid="imp-header-row" style={{ width: 64 }} value={headerRow + 1} onChange={(e) => changeHeaderRow(e.target.value)} /></label>
            </div>
            <div className="form-grid">
              {FIELDS.map(([f, label, req]) => (
                <div className="field" key={f}>
                  <label>{label}{req ? ' *' : ''}</label>
                  <select aria-label={`Column for ${label}`} data-testid={`map-${f}`} value={map[f] ?? -1} onChange={(e) => setMap({ ...map, [f]: Number(e.target.value) })}>
                    <option value={-1}>{req ? 'Choose column…' : '— not in file —'}</option>
                    {headers.map((h, i) => (String(h).trim() ? <option key={i} value={i}>{String(h)}</option> : null))}
                  </select>
                  {sample(f) && <small className="muted">e.g. {sample(f)}</small>}
                </div>
              ))}
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this column match for files with the same headers</label>
            {!mapOk && <div className="field-error">Match at least the Item and Quantity columns.</div>}
            <div className="form-actions"><button type="button" className="btn" data-testid="imp-next" disabled={!mapOk} onClick={toReview}>Continue</button><button type="button" className="btn secondary" onClick={() => setStep('pick')}>Back</button></div>
          </div>
        )}

        {(step === 'review' || step === 'saving') && (
          <div data-testid="imp-review">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }} data-testid="imp-summary">
              <span className="tag">{lines.length} lines</span>
              <span className="tag green">{lines.length - needs.length} tagged automatically</span>
              <span className={`tag ${needs.length ? 'orange' : ''}`}>{needs.length} need a category check</span>
              <span className="tag blue">{lines.filter((l) => l.existingId).length} already in stock</span>
              {skippedBlank > 0 && <span className="tag">{skippedBlank} blank rows ignored</span>}
            </div>
            <div className="exp-tools" style={{ marginBottom: 8 }}>
              <select aria-label="Show" data-testid="imp-view" value={view} onChange={(e) => setView(e.target.value)}><option value="all">All lines</option><option value="needs">Need a check</option><option value="existing">Already in stock</option><option value="new">New items</option></select>
              <select aria-label="If an item is already in stock" data-testid="imp-existing" style={{ maxWidth: "none", width: "auto" }} value={existingMode} onChange={(e) => setExistingMode(e.target.value)}>
                <option value="set">Already in stock: set quantity to the file’s</option><option value="add">Already in stock: add to the quantity</option><option value="skip">Already in stock: leave as is</option>
              </select>
              {needs.length > 0 && (
                <select aria-label="Set all unmatched to" data-testid="imp-bulk" value="" onChange={(e) => { const v = e.target.value; if (v) setLines((ls) => ls.map((l) => (l.how === 'none' ? { ...l, category: v } : l))); }}>
                  <option value="">Set all unmatched to…</option>{categories.map((c) => <option key={c}>{c}</option>)}
                </select>
              )}
              <button type="button" className="btn secondary sm" onClick={() => setShowRules(true)}>⚙ Rules</button>
            </div>
            <div className="table-wrap card" style={{ padding: 0, maxHeight: '46vh', overflow: 'auto' }}>
              <table className="resp-table" data-testid="imp-table">
                <thead><tr><th></th><th>Item</th><th>Category</th><th>Qty</th><th>Unit</th><th>Kept at</th><th>Status</th></tr></thead>
                <tbody>
                  {shown.map((l) => (
                    <tr key={l.key} data-testid="imp-row" style={{ opacity: l.include ? 1 : 0.5 }}>
                      <td data-label="Import"><input type="checkbox" aria-label={`Import ${l.item}`} checked={l.include} onChange={(e) => upd(l.key, { include: e.target.checked })} /></td>
                      <td data-label="Item"><b>{l.item}</b>{l.dup && <><br /><small className="muted">Repeated in the file</small></>}</td>
                      <td data-label="Category">
                        <select aria-label={`Category for ${l.item}`} data-testid="imp-cat" value={l.category} onChange={(e) => upd(l.key, { category: e.target.value })}>{categories.map((c) => <option key={c}>{c}</option>)}</select>
                        <br />
                        {changed(l) ? <label className="muted" style={{ fontSize: 12 }}><input type="checkbox" checked={l.remember !== false} onChange={(e) => upd(l.key, { remember: e.target.checked })} /> remember as a rule</label>
                          : l.how === 'rule' ? <small className="muted" data-testid="imp-why">rule “{l.rule}” · “{l.keyword}”</small>
                          : l.how === 'file-category' ? <small className="muted" data-testid="imp-why">from the file’s category</small>
                          : <small style={{ color: 'var(--viz-warn, #b45309)' }} data-testid="imp-why">no rule matched — please check</small>}
                      </td>
                      <td data-label="Qty"><input type="number" min="0" aria-label={`Quantity for ${l.item}`} style={{ width: 80 }} value={l.quantity} onChange={(e) => upd(l.key, { quantity: e.target.value })} /></td>
                      <td data-label="Unit"><select aria-label={`Unit for ${l.item}`} value={l.uom} onChange={(e) => upd(l.key, { uom: e.target.value })}>{UOMS.map((u) => <option key={u}>{u}</option>)}</select></td>
                      <td data-label="Kept at"><input aria-label={`Kept at for ${l.item}`} value={l.location} onChange={(e) => upd(l.key, { location: e.target.value })} /></td>
                      <td data-label="Status">{l.existingId ? <span className="tag blue" data-testid="imp-exists">In stock: {l.existingQty}</span> : <span className="tag green">New</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn" data-testid="imp-confirm" disabled={step === 'saving' || !chosen.length} onClick={doImport}>{step === 'saving' ? 'Importing…' : `Import ${chosen.length} item${chosen.length === 1 ? '' : 's'}`}</button>
              <button type="button" className="btn secondary" onClick={() => setStep('map')}>Back</button>
            </div>
          </div>
        )}

        {step === 'done' && result && (
          <div data-testid="imp-done">
            <div className="notice success"><b>Import finished.</b> {result.added} added · {result.updated} updated · {result.skipped} left out{result.rulesMade ? ` · ${result.rulesMade} new rule${result.rulesMade === 1 ? '' : 's'} saved` : ''}.</div>
            <div className="form-actions"><button type="button" className="btn" data-testid="imp-close" onClick={onClose}>Done</button></div>
          </div>
        )}
      </Modal>
      {showRules && <InventoryRules onClose={() => setShowRules(false)} />}
    </>
  );
}

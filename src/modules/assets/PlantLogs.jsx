import React, { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { MoneyTiles } from '../../components/ui.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { METERS, klOf, withKl, validate, stockWarnings, suggestOpening, checks, stockOf, monthTotals, monthOfDate, parseWorkbook } from '../../lib/plantLogs.js';
import { readWorkbook } from '../../lib/files/xlsxRead.js';
import { CHEMICALS, plantItem, issueForLog, movesInMonth } from '../../lib/plantStock.js';
import { money } from '../../lib/locale.js';

const n0 = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const inr = (n) => money(n);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (m) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const dm = (d) => `${d.slice(8)} ${MON[Number(d.slice(5, 7)) - 1]}`;
const today = () => new Date().toISOString().slice(0, 10);
const has = (v) => v !== '' && v != null;

// ------------------------------------------------------------------ period picker (year + month dropdowns, prev / next)
function PeriodPicker({ months, month, onPick, testid = 'plant-months' }) {
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse();
  const y = month.slice(0, 4);
  const inYear = months.filter((m) => m.startsWith(y)).sort();
  const idx = months.indexOf(month);
  return (
    <div className="pick-row" data-testid={testid}>
      <button type="button" className="btn secondary sm" aria-label="Previous month" data-testid="pm-prev" disabled={idx <= 0} onClick={() => onPick(months[idx - 1])}>‹</button>
      {years.length > 1 && (
        <select className="pick-year" aria-label="Year" data-testid="plant-year" value={y} onChange={(e) => onPick(months.filter((m) => m.startsWith(e.target.value)).sort().pop())}>
          {years.map((yr) => <option key={yr} value={yr}>{yr}</option>)}
        </select>
      )}
      <select className="pick-year" aria-label="Month" data-testid="plant-month" value={month} onChange={(e) => onPick(e.target.value)}>
        {inYear.map((m) => <option key={m} value={m}>{years.length > 1 ? MON[Number(m.slice(5, 7)) - 1] : monthLabel(m)}</option>)}
        {!months.includes(month) && <option value={month}>{monthLabel(month)}</option>}
      </select>
      <button type="button" className="btn secondary sm" aria-label="Next month" data-testid="pm-next" disabled={idx < 0 || idx >= months.length - 1} onClick={() => onPick(months[idx + 1])}>›</button>
    </div>
  );
}

// ------------------------------------------------------------------ daily chart
function DailyChart({ rows, month }) {
  const [y, mo] = month.split('-').map(Number);
  const days = new Date(y, mo, 0).getDate();
  const series = METERS.map((m) => ({ ...m, pts: rows.filter((r) => monthOfDate(r.date) === month).map((r) => ({ d: Number(r.date.slice(8)), v: klOf(r, m) })).filter((p) => p.v != null) })).filter((s) => s.pts.length);
  if (!series.length) return <div className="empty">No meter readings in {monthLabel(month)} yet.</div>;
  const max = Math.max(...series.flatMap((s) => s.pts.map((p) => p.v))) * 1.1 || 1;
  const w = 640; const h = 220; const L = 40; const B = 24; const T = 8; const R = 10;
  const x = (d) => L + ((d - 1) / Math.max(1, days - 1)) * (w - L - R);
  const yy = (v) => T + (1 - v / max) * (h - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  return (
    <div data-testid="plant-chart">
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{series.map((s) => <span key={s.id} style={{ marginRight: 14 }}><span style={{ color: s.color }}>●</span> {s.label} (KL / day)</span>)}</div>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Daily water KL, ${monthLabel(month)}`} style={{ width: '100%', height: 'auto' }}>
        {ticks.map((t) => <g key={t}><line x1={L} x2={w - R} y1={yy(t)} y2={yy(t)} stroke="#e2e8f0" /><text x={L - 4} y={yy(t) + 3} textAnchor="end" fontSize="10" fill="#64748b">{t}</text></g>)}
        {[1, 5, 10, 15, 20, 25, days].map((d) => <text key={d} x={x(d)} y={h - 8} textAnchor="middle" fontSize="10" fill="#64748b">{d}</text>)}
        {series.map((s) => (
          <g key={s.id}>
            <polyline fill="none" stroke={s.color} strokeWidth="2" points={s.pts.map((p) => `${x(p.d)},${yy(p.v)}`).join(' ')} />
            {s.pts.map((p) => <circle key={p.d} cx={x(p.d)} cy={yy(p.v)} r="2.5" fill={s.color}><title>{`${s.label} ${p.d} ${monthLabel(month)}: ${Math.round(p.v)} KL`}</title></circle>)}
          </g>
        ))}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ entry dialog
function LogDialog({ rows, initial, onClose, onSaved, save, inventory = [] }) {
  // the stock at the start of a new day is what Inventory holds now (the store's one figure); an existing log keeps what it says
  const storeStock = () => Object.fromEntries(CHEMICALS.map((c) => [c, plantItem(inventory, c)]).filter(([, i]) => i && i.quantity !== '' && i.quantity != null).map(([c, i]) => [c.stock, Number(i.quantity)]));
  const [d, setD] = useState(() => ({ date: today(), ...suggestOpening(rows, today()), ...storeStock(), ...(initial || {}) }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = rows.find((r) => r.date === d.date && r.id !== initial?.id);
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const setDate = (date) => {
    const hit = rows.find((r) => r.date === date);
    setD(hit ? { ...hit } : { date, ...suggestOpening(rows, date), ...storeStock() });
  };
  const draft = withKl(d);
  const num = (k, label, ph) => <div className="field" key={k}><label>{label}</label><input type="number" inputMode="decimal" aria-label={label} placeholder={ph} value={d[k] ?? ''} onChange={(e) => set(k, e.target.value === '' ? '' : e.target.value)} /></div>;
  async function go() {
    const NUM = ['bhOpen', 'bhClose', 'wtpOpen', 'wtpClose', 'stpOpen', 'stpClose', 'saltStock', 'saltUsed', 'chlorineStock', 'chlorineUsed'];
    const clean = Object.fromEntries(Object.entries(withKl(d)).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, NUM.includes(k) ? Number(v) : v]));
    const bad = validate(clean);
    if (bad) return setErr(bad);
    setBusy(true);
    const target = rows.find((r) => r.date === clean.date);
    const out = await save(target ? { ...target, ...clean } : clean);
    const said = out ? [...stockWarnings(clean), ...await issueForLog(target || null, out).catch(() => [])] : [];   // the day's salt and chlorine come out of Inventory
    setBusy(false);
    if (out) onSaved(out, said); else setErr('Not saved. Only the EC, Facility Manager, MEP or the people who record meter readings can change the plant logs.');
  }
  return (
    <Modal title={initial?.id ? 'Edit plant log' : 'Add plant log'} subtitle="Readings are taken once a day. Opening readings are filled from the last closing." onClose={onClose}>
      <div data-testid="plant-dialog">
        {err && <div className="notice error" data-testid="plant-error">{err}</div>}
        <div className="form-grid">
          <div className="field"><label>Log date</label><input type="date" aria-label="Log date" value={d.date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        {existing && <div className="notice" data-testid="plant-exists">A log for this date already exists — saving updates it.</div>}
        {METERS.map((m) => (
          <fieldset key={m.id} style={{ border: '1px solid var(--border, #e2e8f0)', borderRadius: 8, margin: '10px 0', padding: '6px 12px 10px' }}>
            <legend><b>{m.label}</b>{m.factor !== 1 && <span className="muted"> · meter reads in units of {m.factor} KL</span>}</legend>
            <div className="form-grid">
              {num(m.open, `${m.label} opening`)}
              {num(m.close, `${m.label} closing`)}
              <div className="field"><label>Water (KL)</label><div style={{ padding: '8px 0', fontWeight: 600 }} data-testid={`kl-${m.id}`}>{has(draft[m.kl]) ? n0(draft[m.kl]) : '—'}</div></div>
            </div>
          </fieldset>
        ))}
        <fieldset style={{ border: '1px solid var(--border, #e2e8f0)', borderRadius: 8, margin: '10px 0', padding: '6px 12px 10px' }}>
          <legend><b>Salt &amp; chlorine</b></legend>
          <div className="form-grid">
            {num('saltStock', 'Salt stock at start (kg)')}
            {num('saltUsed', 'Salt used (kg)')}
            {num('chlorineStock', 'Chlorine stock at start (L)')}
            {num('chlorineUsed', 'Chlorine used (L)')}
          </div>
          <div className="muted" data-testid="plant-store" style={{ fontSize: 12.5 }}>
            {CHEMICALS.map((c) => { const i = plantItem(inventory, c); return <div key={c.key}>{c.label}: {i ? <>taken from <b>{i.item}</b> in Inventory · <b>{n0(i.quantity)} {i.uom || c.unit}</b> in store now</> : 'no Inventory item yet (add one under Inventory, category Water & Sewage)'}</div>; })}
            <div>What you enter as used is taken out of Inventory when you save. Record deliveries in Inventory.</div>
          </div>
          {stockWarnings(withKl(d)).length > 0 && <div className="notice warn" data-testid="plant-stock-warn" style={{ marginTop: 6 }}>{stockWarnings(withKl(d)).join(' ')} You can still save the log.</div>}
        </fieldset>
        <div className="field"><label>Remarks</label><input aria-label="Remarks" maxLength={2000} value={d.remarks || ''} onChange={(e) => set('remarks', e.target.value)} placeholder="e.g. pump tripped, tanker delivery" /></div>
        <div className="form-actions"><button className="btn good" disabled={busy} data-testid="plant-save" onClick={go}>{busy ? 'Saving…' : 'Save log'}</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ importer
function ImportDialog({ rows, onClose, onDone, save }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function pick(e) {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const XLSX = await import('xlsx');
      const wb = await readWorkbook(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const out = parseWorkbook(XLSX, wb);
      if (!out.rows.length) return setErr('No plant log sheets found. Name the sheets bhagiratha, wtp, stp and salt, each with a DATE column.');
      setErr(''); setState(out);
    } catch { setErr('That file could not be read as an Excel workbook.'); }
  }
  async function go() {
    setBusy(true);
    const have = new Map(rows.map((r) => [r.date, r]));
    const fresh = state.rows.filter((r) => !have.has(r.date));
    const upd = state.rows.filter((r) => have.has(r.date));
    try {
      if (fresh.length) await secureStorage.importMany(C.PLANT_LOGS, fresh, { label: 'Plant Log', summary: `Imported ${fresh.length} daily plant logs` });
      for (const r of upd) await save({ ...have.get(r.date), ...r });
      onDone(state.rows.length);
    } catch (x) { setErr(x?.message || 'Import failed.'); setBusy(false); }
  }
  const dates = state?.rows.map((r) => r.date) || [];
  const exist = state ? state.rows.filter((r) => rows.some((x) => x.date === r.date)).length : 0;
  return (
    <Modal title="Import plant logs from Excel" subtitle="One workbook with sheets named bhagiratha, wtp, stp and salt." onClose={onClose}>
      <div data-testid="plant-import">
        {err && <div className="notice error">{err}</div>}
        <input type="file" accept=".xlsx,.xls" aria-label="Plant log workbook" data-testid="plant-file" onChange={pick} />
        {state && (
          <div style={{ marginTop: 10 }} data-testid="plant-import-preview">
            <p><b>{state.rows.length} days</b> from {dm(dates[0])} {dates[0].slice(0, 4)} to {dm(dates[dates.length - 1])} {dates[dates.length - 1].slice(0, 4)} · sheets: {state.used.join(', ')}.</p>
            {exist > 0 && <p className="muted">{exist} of these dates already have a log; the sheet's readings are merged into them.</p>}
            <button className="btn good" disabled={busy} data-testid="plant-import-go" onClick={go}>{busy ? 'Importing…' : `Import ${state.rows.length} days`}</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ the daily tab
export default function PlantLogs() {
  const { records, save, remove } = useCollection(C.PLANT_LOGS, 'Plant Log');
  const { records: inventory } = useCollection(C.INVENTORY, 'Inventory');
  const canWrite = canWriteCollection(C.PLANT_LOGS, getPrincipal());
  const rows = useMemo(() => [...records].sort((a, b) => (a.date < b.date ? -1 : 1)), [records]);
  const months = useMemo(() => [...new Set(rows.map((r) => monthOfDate(r.date)))].sort(), [rows]);
  const [pick, setPick] = useState('');
  const month = months.includes(pick) ? pick : months[months.length - 1] || today().slice(0, 7);
  const [edit, setEdit] = useState(null);
  const [imp, setImp] = useState(false);
  const [toast, setToast] = useState('');
  const t = monthTotals(rows, month);
  const flags = useMemo(() => checks(rows, month), [rows, month]);
  const salt = stockOf(rows, 'salt'); const chl = stockOf(rows, 'chlorine');
  const inMonth = rows.filter((r) => monthOfDate(r.date) === month);
  const low = (s) => s.days != null && s.days <= 7;
  const tiles = [
    { label: 'Bhagiratha received', value: t.hasMeters ? `${n0(t.bh)} KL` : '—', sub: t.hasMeters && t.bh ? `${n0(t.bh / Math.max(1, inMonth.filter((r) => klOf(r, METERS[0]) != null).length))} KL / day` : '' },
    { label: 'WTP treated', value: t.hasMeters ? `${n0(t.wtp)} KL` : '—', sub: t.hasMeters && t.wtp ? `${n0(t.wtp / Math.max(1, inMonth.filter((r) => klOf(r, METERS[1]) != null).length))} KL / day` : '' },
    { label: 'STP treated', value: t.hasMeters ? `${n0(t.stp)} KL` : '—', sub: t.stpPct != null ? `${t.stpPct.toFixed(0)}% of WTP water` : '' },
    { label: 'Salt used', value: t.hasChem ? `${n0(t.salt)} kg` : '—', sub: '' },
    { label: 'Chlorine used', value: t.hasChem ? `${n0(t.chlorine)} L` : '—', sub: '' },
  ];
  return (
    <div data-testid="plant-logs">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div><h2 style={{ margin: 0 }}>Water &amp; sewage plants</h2><div className="muted">Daily Bhagiratha supply, WTP and STP treated water, and salt &amp; chlorine stock.</div></div>
        {canWrite && <div style={{ display: 'flex', gap: 8 }}><button className="btn secondary" data-testid="plant-import-btn" onClick={() => setImp(true)}>Import Excel</button><button className="btn" data-testid="plant-add" onClick={() => setEdit({})}>+ Add today's log</button></div>}
      </div>
      {toast && <div className="notice" data-testid="plant-toast" style={{ marginTop: 8 }}>{toast}</div>}
      <PeriodPicker months={months} month={month} onPick={setPick} />
      <MoneyTiles items={tiles} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12, margin: '12px 0' }} data-testid="stock-cards">
        {[salt, chl].map((s) => (
          <div key={s.label} className="card" data-testid={`stock-${s.label.toLowerCase()}`} style={low(s) ? { borderColor: '#e5484d' } : undefined}>
            <b>{s.label} stock</b>
            {(() => { const c = CHEMICALS.find((x) => x.label === s.label); const i = c && plantItem(inventory, c); return i ? <div className="muted" data-testid={`store-${s.label.toLowerCase()}`} style={{ fontSize: 12.5 }}>In Inventory ({i.item}): <b>{n0(i.quantity)} {i.uom || s.unit}</b></div> : null; })()}
            {s.left == null ? <div className="muted">No stock readings yet.</div> : (
              <>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{n0(s.left)} {s.unit}</div>
                <div className="muted">After use on {dm(s.date)} · about {s.daily ? s.daily.toFixed(s.daily < 10 ? 1 : 0) : '—'} {s.unit}/day</div>
                {s.days != null && <div data-testid={`days-${s.label.toLowerCase()}`}><span className={`tag ${low(s) ? 'red' : 'green'}`}>{s.days} days left</span>{low(s) && <b style={{ color: '#e5484d', marginLeft: 8 }}>Order now</b>}</div>}
                {s.restocks.length > 0 && <small className="muted" data-testid={`restocks-${s.label.toLowerCase()}`}>Last delivery: {dm(s.restocks[s.restocks.length - 1].date)} · +{n0(s.restocks[s.restocks.length - 1].qty)} {s.unit}</small>}
              </>
            )}
          </div>
        ))}
      </div>
      {flags.length > 0 && (
        <div className="notice" data-testid="plant-flags" style={{ marginBottom: 12 }}>
          <b>Worth a look in {monthLabel(month)}</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{flags.slice(0, 8).map((f, i) => <li key={i} data-testid="plant-flag">{f.text}</li>)}</ul>
        </div>
      )}
      <div className="card"><DailyChart rows={rows} month={month} /></div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Daily log — {monthLabel(month)}</h3>
        {inMonth.length === 0 ? <div className="empty">No logs this month.</div> : (
          <div className="table-wrap pl-table-wrap"><table className="resp-table" data-testid="plant-table">
            <thead><tr><th>Date</th><th>Bhagiratha KL</th><th>WTP KL</th><th>STP KL</th><th>Salt used (kg)</th><th>Salt stock</th><th>Chlorine used (L)</th><th>Chlorine stock</th><th>Remarks</th><th /></tr></thead>
            <tbody>
              {[...inMonth].reverse().map((r) => {
                const fl = flags.filter((f) => f.date === r.date);
                return (
                  <tr key={r.id} data-testid="plant-row" style={fl.length ? { background: '#fff7ed' } : undefined}>
                    <td data-label="Date">{dm(r.date)}</td>
                    <td data-label="Bhagiratha">{klOf(r, METERS[0]) != null ? n0(klOf(r, METERS[0])) : '—'}</td>
                    <td data-label="WTP">{klOf(r, METERS[1]) != null ? n0(klOf(r, METERS[1])) : '—'}</td>
                    <td data-label="STP">{klOf(r, METERS[2]) != null ? <>{n0(klOf(r, METERS[2]))}{fl.some((f) => f.kind === 'outlier' && f.meter === 'stp') && <span className="tag red" title="Far from the usual">!</span>}</> : '—'}</td>
                    <td data-label="Salt used">{has(r.saltUsed) ? n0(r.saltUsed) : '—'}</td>
                    <td data-label="Salt stock">{has(r.saltStock) ? n0(r.saltStock) : '—'}</td>
                    <td data-label="Chlorine used">{has(r.chlorineUsed) ? n0(r.chlorineUsed) : '—'}</td>
                    <td data-label="Chlorine stock">{has(r.chlorineStock) ? n0(r.chlorineStock) : '—'}</td>
                    <td data-label="Remarks">{r.remarks || ''}</td>
                    <td>{canWrite && <button className="btn secondary sm" data-testid="plant-edit" onClick={() => setEdit(r)}>Edit</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
        <div className="pl-cards" data-testid="plant-cards">
          {[...inMonth].reverse().map((r) => {
            const fl = flags.filter((f) => f.date === r.date);
            const k = (m) => (klOf(r, m) != null ? n0(klOf(r, m)) : '—');
            return (
              <div key={r.id} className={`pl-card${fl.length ? ' flag' : ''}`} data-testid="plant-card">
                <div className="hd"><span>{dm(r.date)}{fl.length > 0 && <span className="tag red" style={{ marginLeft: 6 }}>check</span>}</span>{canWrite && <button className="btn secondary sm" onClick={() => setEdit(r)}>Edit</button>}</div>
                <div className="kl"><div><small>Bhagiratha KL</small><b>{k(METERS[0])}</b></div><div><small>WTP KL</small><b>{k(METERS[1])}</b></div><div><small>STP KL</small><b>{k(METERS[2])}</b></div></div>
                {(has(r.saltUsed) || has(r.chlorineUsed)) && <div className="chem">Salt {has(r.saltUsed) ? `${n0(r.saltUsed)} kg` : '—'}{has(r.saltStock) ? ` (stock ${n0(r.saltStock)})` : ''} · Chlorine {has(r.chlorineUsed) ? `${n0(r.chlorineUsed)} L` : '—'}{has(r.chlorineStock) ? ` (stock ${n0(r.chlorineStock)})` : ''}</div>}
                {r.remarks && <div className="chem">{r.remarks}</div>}
              </div>
            );
          })}
        </div>
        <small className="muted">Bhagiratha KL = (closing − opening) × 10. WTP and STP KL = closing − opening. Rows shaded orange have a reading worth checking.</small>
      </div>
      {edit && <LogDialog rows={rows} inventory={inventory} initial={edit.id ? edit : null} save={save} onClose={() => setEdit(null)} onSaved={(o, said = []) => { setEdit(null); setPick(monthOfDate(o.date)); setToast(`Saved the log for ${dm(o.date)}.${said.length ? ` ${said.join(' ')}` : ''}`); }} />}
      {imp && <ImportDialog rows={rows} save={save} onClose={() => setImp(false)} onDone={(c) => { setImp(false); setToast(`Imported ${c} days.`); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ monthly summary
const monthKey = (s) => (s ? String(s).slice(0, 7) : '');
const billedMonth = (d) => (/^\d{4}-\d{2}$/.test(d.billedMonth || '') ? d.billedMonth : monthKey(d.dueDate));

const PLANT_SERVICES = ['WTP', 'STP'];   // the plants' own electricity connections
const isPlantBill = (b) => PLANT_SERVICES.includes(String(b.service || '').trim().toUpperCase());

/** What the plant log says each chemical used in a month, against what Inventory issued for it (the server keeps the movements). */
function MonthChemicals({ month, plant, inventory }) {
  const [moves, setMoves] = useState(null);
  const items = useMemo(() => CHEMICALS.map((c) => ({ c, item: plantItem(inventory, c) })), [inventory]);
  useEffect(() => {
    let on = true;
    Promise.all(items.map(({ item }) => movesInMonth(item, month).catch(() => null))).then((r) => { if (on) setMoves(r); });
    return () => { on = false; };
  }, [items, month]);
  const days = plant.filter((r) => monthOfDate(r.date) === month);
  return (
    <div data-testid="summary-chemicals"><b>Chemicals</b>
      {items.map(({ c, item }, ix) => {
        const used = days.reduce((n, r) => n + (has(r[c.used]) ? Number(r[c.used]) : 0), 0);
        const mv = moves?.[ix];
        const issued = mv ? mv.filter((m) => m.kind === 'Issued').reduce((n, m) => n + Number(m.quantity || 0), 0) : null;
        const received = mv ? mv.filter((m) => m.kind === 'Received').reduce((n, m) => n + Number(m.quantity || 0), 0) : null;
        return (
          <div key={c.key} data-testid={`summary-chem-${c.key}`}>
            {c.label}: <b>{n0(used)} {c.unit}</b> used (plant log)
            {item ? <> · {item.item}: <b>{n0(item.quantity)} {item.uom || c.unit}</b> in store now{issued != null && <> · issued {n0(issued)}, received {n0(received)} this month{Math.abs(issued - used) > 0.5 && <span className="tag orange" style={{ marginLeft: 6 }} title="The plant log and Inventory differ">differs by {n0(Math.abs(issued - used))}</span>}</>}</>
              : <span className="muted"> · no Inventory item</span>}
          </div>
        );
      })}
    </div>
  );
}

export function MonthlySummary() {
  const { records: plant } = useCollection(C.PLANT_LOGS, 'Plant Log');
  const { records: fuel } = useCollection(C.DG_FUEL_LOGS, 'DG Fuel Log');
  const { records: eb } = useCollection(C.ELECTRICITY_BILLS, 'Electricity Bill');
  const { records: dues } = useCollection(C.DUES, 'Billing & Finance');
  const { records: inventory } = useCollection(C.INVENTORY, 'Inventory');
  const data = useMemo(() => {
    const m = {};
    const row = (k) => (m[k] ||= { month: k, litres: 0, diesel: 0, refills: 0, dg: 0, ebUnits: 0, eb: 0, ebBills: 0, ebPlant: 0, ebPlantUnits: 0 });
    fuel.forEach((f) => { const r = row(monthKey(f.date)); r.litres += Number(f.litres || 0); r.diesel += Number(f.amount || 0); r.refills += 1; });
    dues.filter((d) => d.category === 'DG').forEach((d) => { const k = billedMonth(d); if (k) row(k).dg += Number(d.amount || 0); });
    eb.forEach((b) => { const r = row(b.period); r.ebUnits += Number(b.units || 0); r.eb += Number(b.amount || 0); r.ebBills += 1; if (isPlantBill(b)) { r.ebPlant += Number(b.amount || 0); r.ebPlantUnits += Number(b.units || 0); } });
    [...new Set(plant.map((p) => monthKey(p.date)))].forEach((k) => { Object.assign(row(k), monthTotals(plant, k)); });
    return Object.values(m).filter((r) => /^\d{4}-\d{2}$/.test(r.month)).sort((a, b) => (a.month < b.month ? 1 : -1));
  }, [plant, fuel, eb, dues]);
  const dash = (v, f = n0) => (v ? f(v) : '—');
  const perKl = (r) => (r.ebPlant && r.wtp ? `₹${(r.ebPlant / r.wtp).toFixed(2)}` : '—');
  const [open, setOpen] = useState('');
  const [focus, setFocus] = useState('');
  const years = [...new Set(data.map((r) => r.month.slice(0, 4)))].sort().reverse();
  const [yr, setYr] = useState('');
  const sel = years.includes(yr) ? yr : years[0];
  const shown = data.filter((r) => r.month.startsWith(sel || '____'));
  const tot = (k) => shown.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const COLS = [['Bhagiratha KL', (r) => dash(r.bh)], ['WTP KL', (r) => dash(r.wtp)], ['STP KL', (r) => dash(r.stp)], ['STP % of WTP', (r) => (r.stpPct != null ? `${r.stpPct.toFixed(0)}%` : '—')],
    ['Salt kg', (r) => (r.hasChem ? n0(r.salt) : '—')], ['Chlorine L', (r) => (r.hasChem ? n0(r.chlorine) : '—')], ['Diesel L', (r) => dash(r.litres)], ['Diesel ₹', (r) => dash(r.diesel, inr)],
    ['DG billed ₹', (r) => dash(r.dg, inr)], ['EB units', (r) => dash(r.ebUnits)], ['EB bills ₹', (r) => dash(r.eb, inr)], ['Plant power ₹', (r) => dash(r.ebPlant, inr)], ['Plant ₹ per KL', perKl]];
  const GROUPS = [['Water (KL)', [0, 1, 2, 3]], ['Chemicals', [4, 5]], ['Diesel & DG', [6, 7, 8]], ['Electricity', [9, 10, 11, 12]]];
  // per KL over the months that have both a plant bill and treated water (a month with bills but no logs would overstate it)
  const both = shown.filter((r) => r.ebPlant > 0 && r.wtp > 0);
  const bothKl = both.reduce((n, r) => n + r.wtp, 0);
  const plantPerKl = bothKl > 0 ? ` · ₹${(both.reduce((n, r) => n + r.ebPlant, 0) / bothKl).toFixed(2)} per KL` : '';
  // each tile opens what is behind it: the months it adds up, and the records themselves
  const TILES = [
    { key: 'water', label: `${sel} water`, value: `${n0(tot('wtp'))} KL`, sub: `WTP treated · STP ${n0(tot('stp'))} KL`, cols: [['WTP KL', (r) => dash(r.wtp)], ['STP KL', (r) => dash(r.stp)], ['Days logged', (r) => dash(r.days)]] },
    { key: 'bh', label: 'Bhagiratha', value: `${n0(tot('bh'))} KL`, sub: '', cols: [['Bhagiratha KL', (r) => dash(r.bh)], ['Days logged', (r) => dash(r.days)]] },
    { key: 'chem', label: 'Salt / chlorine', value: `${n0(tot('salt'))} kg`, sub: `${n0(tot('chlorine'))} L chlorine`, cols: [['Salt kg', (r) => (r.hasChem ? n0(r.salt) : '—')], ['Chlorine L', (r) => (r.hasChem ? n0(r.chlorine) : '—')]] },
    { key: 'diesel', label: 'Diesel', value: inr(tot('diesel')), sub: `${n0(tot('litres'))} L`, cols: [['Refills', (r) => dash(r.refills)], ['Diesel L', (r) => dash(r.litres)], ['Diesel ₹', (r) => dash(r.diesel, inr)]] },
    { key: 'eb', label: 'Electricity bills', value: inr(tot('eb')), sub: `${n0(tot('ebUnits'))} kWh · plant ${inr(tot('ebPlant'))}${plantPerKl}`, cols: [['Bills', (r) => dash(r.ebBills)], ['EB bills ₹', (r) => dash(r.eb, inr)], ['Plant power ₹', (r) => dash(r.ebPlant, inr)], ['Plant ₹ per KL', perKl]] },
  ];
  const ft = TILES.find((t) => t.key === focus);
  const yearFuel = fuel.filter((f) => String(f.date || '').startsWith(sel || '____')).sort((a, b) => (a.date < b.date ? 1 : -1));
  const yearBills = eb.filter((b) => String(b.period || '').startsWith(sel || '____')).sort((a, b) => (a.period < b.period ? 1 : -1));
  return (
    <div data-testid="monthly-summary">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, flex: 1 }}>Monthly summary</h2>
        {years.length > 0 && <select className="pick-year" aria-label="Year" data-testid="summary-year" value={sel} onChange={(e) => { setYr(e.target.value); setOpen(''); setFocus(''); }}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>}
      </div>
      <div className="muted" style={{ marginBottom: 10 }}>Plant logs, DG fuel, DG bills and electricity bills for each month, side by side. Tap a figure or a month for the records behind it.</div>
      {shown.length > 0 && <div data-testid="summary-year-tiles"><MoneyTiles items={TILES.map((t) => ({ ...t, testid: `summary-tile-${t.key}`, active: focus === t.key, onClick: () => setFocus(focus === t.key ? '' : t.key) }))} /></div>}
      {ft && (
        <div className="card" style={{ marginTop: 10 }} data-testid="summary-behind">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><h3 style={{ margin: 0 }}>Behind “{ft.label}” · {sel}</h3><button type="button" className="btn secondary sm" onClick={() => setFocus('')}>Close</button></div>
          <div className="table-wrap" style={{ marginTop: 8 }}><table className="resp-table" data-testid="summary-behind-table">
            <thead><tr><th>Month</th>{ft.cols.map(([h]) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{shown.map((r) => <tr key={r.month} onClick={() => setOpen(r.month)} style={{ cursor: 'pointer' }}><td data-label="Month"><b>{monthLabel(r.month)}</b></td>{ft.cols.map(([h, f]) => <td key={h} data-label={h}>{f(r)}</td>)}</tr>)}</tbody>
          </table></div>
          {ft.key === 'diesel' && <div style={{ marginTop: 8 }} data-testid="summary-behind-rows"><b>Refills</b>{yearFuel.length ? yearFuel.map((f) => <div key={f.id}>{dm(f.date)} {f.date.slice(0, 4)}: {n0(f.litres)} L · {inr(f.amount)}{f.supplier ? ` · ${f.supplier}` : ''}</div>) : <div className="muted">None this year.</div>}</div>}
          {ft.key === 'eb' && <div style={{ marginTop: 8 }} data-testid="summary-behind-rows"><b>Bills</b>{yearBills.length ? yearBills.map((b) => <div key={b.id}><b>{monthLabel(b.period)}</b> · {b.service || 'Supply'}: {n0(b.units)} kWh · {inr(b.amount)}{isPlantBill(b) && <span className="tag blue" style={{ marginLeft: 6 }}>plant</span>} <span className="tag">{b.status}</span></div>) : <div className="muted">None this year.</div>}</div>}
          <small className="muted">Tap a month for its daily logs, bills and refills.</small>
        </div>
      )}
      {shown.length === 0 ? <div className="empty">Nothing logged yet.</div> : (
        <>
          <div className="table-wrap sum-table-wrap" style={{ marginTop: 10 }}><table className="resp-table" data-testid="summary-table">
            <thead><tr><th>Month</th>{COLS.map(([h]) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.month} data-testid="summary-row" data-month={r.month} onClick={() => setOpen(open === r.month ? '' : r.month)} style={{ cursor: 'pointer' }} className={open === r.month ? 'row-sel' : ''}>
                  <td data-label="Month"><b>{monthLabel(r.month)}</b></td>
                  {COLS.map(([h, f]) => <td key={h} data-label={h}>{f(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="sum-cards" data-testid="summary-cards" style={{ marginTop: 10 }}>
            {shown.map((r) => (
              <div key={r.month} className="pl-card" data-testid="summary-card" onClick={() => setOpen(open === r.month ? '' : r.month)}>
                <div className="hd"><span>{monthLabel(r.month)}</span><span className="muted" style={{ fontSize: 12 }}>{open === r.month ? 'Hide' : 'Details'}</span></div>
                {GROUPS.map(([g, ix]) => (
                  <div key={g} className="chem" style={{ marginTop: 4 }}><b>{g}:</b> {ix.map((i) => `${COLS[i][0].replace(/ (KL|kg|L|₹)$/, '')} ${COLS[i][1](r)}`).join(' · ')}</div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
      {open && (() => {
        const r = data.find((x) => x.month === open); if (!r) return null;
        const bills = eb.filter((b) => b.period === open);
        const refills = fuel.filter((f) => monthKey(f.date) === open).sort((a, b) => (a.date < b.date ? -1 : 1));
        const days = plant.filter((p) => monthOfDate(p.date) === open).sort((a, b) => (a.date < b.date ? -1 : 1));
        const kl = (p, m) => (klOf(p, m) != null ? n0(klOf(p, m)) : '—');
        return (
          <div className="card" style={{ marginTop: 12 }} data-testid="summary-detail">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><h3 style={{ margin: 0 }}>{monthLabel(open)}</h3><button type="button" className="btn secondary sm" onClick={() => setOpen('')}>Close</button></div>
            <div style={{ marginTop: 8 }} data-testid="summary-days">
              <b>Daily plant logs ({days.length} days)</b>
              {days.length === 0 ? <div className="muted">No plant logs this month.</div> : (
                <div className="table-wrap"><table className="resp-table">
                  <thead><tr><th>Date</th><th>Bhagiratha KL</th><th>WTP KL</th><th>STP KL</th><th>Salt kg</th><th>Chlorine L</th><th>Remarks</th></tr></thead>
                  <tbody>
                    {days.map((p) => <tr key={p.id}><td data-label="Date">{dm(p.date)}</td><td data-label="Bhagiratha">{kl(p, METERS[0])}</td><td data-label="WTP">{kl(p, METERS[1])}</td><td data-label="STP">{kl(p, METERS[2])}</td><td data-label="Salt">{has(p.saltUsed) ? n0(p.saltUsed) : '—'}</td><td data-label="Chlorine">{has(p.chlorineUsed) ? n0(p.chlorineUsed) : '—'}</td><td data-label="Remarks">{p.remarks || ''}</td></tr>)}
                    <tr data-testid="summary-days-total"><td data-label="Total"><b>Total</b></td><td data-label="Bhagiratha"><b>{dash(r.bh)}</b></td><td data-label="WTP"><b>{dash(r.wtp)}</b></td><td data-label="STP"><b>{dash(r.stp)}</b></td><td data-label="Salt"><b>{r.hasChem ? n0(r.salt) : '—'}</b></td><td data-label="Chlorine"><b>{r.hasChem ? n0(r.chlorine) : '—'}</b></td><td /></tr>
                  </tbody>
                </table></div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14, marginTop: 12 }}>
              <div data-testid="summary-plant-power"><b>Plant electricity (WTP, STP)</b>{bills.filter(isPlantBill).length ? bills.filter(isPlantBill).map((b) => <div key={b.id}>{b.service}: {n0(b.units)} kWh · {inr(b.amount)} <span className="tag">{b.status}</span></div>) : <div className="muted">No WTP or STP bill this month.</div>}{r.ebPlant > 0 && r.wtp > 0 && <div>Cost per KL treated: <b>{perKl(r)}</b></div>}</div>
              <MonthChemicals month={open} plant={plant} inventory={inventory} />
              <div><b>Other electricity bills</b>{bills.filter((b) => !isPlantBill(b)).length ? bills.filter((b) => !isPlantBill(b)).map((b) => <div key={b.id}>{b.service || 'Supply'}: {n0(b.units)} kWh · {inr(b.amount)} <span className="tag">{b.status}</span></div>) : <div className="muted">None recorded.</div>}</div>
              <div><b>Diesel refills</b>{refills.length ? refills.map((f) => <div key={f.id}>{dm(f.date)}: {n0(f.litres)} L · {inr(f.amount)}</div>) : <div className="muted">None this month.</div>}</div>
              <div><b>Cost per unit</b><div>{r.ebUnits ? `Electricity ₹${(r.eb / r.ebUnits).toFixed(2)} / kWh` : '—'}</div><div>{r.litres ? `Diesel ₹${(r.diesel / r.litres).toFixed(2)} / L` : ''}</div></div>
            </div>
          </div>
        );
      })()}
      <small className="muted" style={{ display: 'block', marginTop: 8 }}>“—” means nothing is recorded for that month. Plant power is the WTP and STP electricity bills; DG billed is what was billed to villas (Billing &amp; Finance, category DG). The chemicals used are taken out of Inventory when the daily log is saved.</small>
    </div>
  );
}

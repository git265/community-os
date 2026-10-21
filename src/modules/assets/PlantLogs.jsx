import React, { useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { MoneyTiles } from '../../components/ui.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { METERS, klOf, withKl, validate, suggestOpening, checks, stockOf, monthTotals, monthOfDate, parseWorkbook } from '../../lib/plantLogs.js';
import { readWorkbook } from '../../lib/files/xlsxRead.js';

const n0 = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const inr = (n) => `₹${n0(n)}`;
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
function LogDialog({ rows, initial, onClose, onSaved, save }) {
  const [d, setD] = useState(() => ({ date: today(), ...suggestOpening(rows, today()), ...(initial || {}) }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = rows.find((r) => r.date === d.date && r.id !== initial?.id);
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const setDate = (date) => {
    const hit = rows.find((r) => r.date === date);
    setD(hit ? { ...hit } : { date, ...suggestOpening(rows, date) });
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
    setBusy(false);
    if (out) onSaved(out); else setErr('Not saved. Only the EC, Facility Manager, MEP or the people who record meter readings can change the plant logs.');
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
          <small className="muted">After a delivery, enter the new total stock — the restock is picked up from the jump.</small>
        </fieldset>
        <div className="field"><label>Remarks</label><input aria-label="Remarks" value={d.remarks || ''} onChange={(e) => set('remarks', e.target.value)} placeholder="e.g. pump tripped, tanker delivery" /></div>
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
  const canWrite = canWriteCollection(getPrincipal(), C.PLANT_LOGS);
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
      {edit && <LogDialog rows={rows} initial={edit.id ? edit : null} save={save} onClose={() => setEdit(null)} onSaved={(o) => { setEdit(null); setPick(monthOfDate(o.date)); setToast(`Saved the log for ${dm(o.date)}.`); }} />}
      {imp && <ImportDialog rows={rows} save={save} onClose={() => setImp(false)} onDone={(c) => { setImp(false); setToast(`Imported ${c} days.`); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ monthly summary
const monthKey = (s) => (s ? String(s).slice(0, 7) : '');
const billedMonth = (d) => (/^\d{4}-\d{2}$/.test(d.billedMonth || '') ? d.billedMonth : monthKey(d.dueDate));

export function MonthlySummary() {
  const { records: plant } = useCollection(C.PLANT_LOGS, 'Plant Log');
  const { records: fuel } = useCollection(C.DG_FUEL_LOGS, 'DG Fuel Log');
  const { records: eb } = useCollection(C.ELECTRICITY_BILLS, 'Electricity Bill');
  const { records: dues } = useCollection(C.DUES, 'Billing & Finance');
  const data = useMemo(() => {
    const m = {};
    const row = (k) => (m[k] ||= { month: k, litres: 0, diesel: 0, refills: 0, dg: 0, ebUnits: 0, eb: 0, ebBills: 0 });
    fuel.forEach((f) => { const r = row(monthKey(f.date)); r.litres += Number(f.litres || 0); r.diesel += Number(f.amount || 0); r.refills += 1; });
    dues.filter((d) => d.category === 'DG').forEach((d) => { const k = billedMonth(d); if (k) row(k).dg += Number(d.amount || 0); });
    eb.forEach((b) => { const r = row(b.period); r.ebUnits += Number(b.units || 0); r.eb += Number(b.amount || 0); r.ebBills += 1; });
    [...new Set(plant.map((p) => monthKey(p.date)))].forEach((k) => { Object.assign(row(k), monthTotals(plant, k)); });
    return Object.values(m).filter((r) => /^\d{4}-\d{2}$/.test(r.month)).sort((a, b) => (a.month < b.month ? 1 : -1));
  }, [plant, fuel, eb, dues]);
  const dash = (v, f = n0) => (v ? f(v) : '—');
  const [open, setOpen] = useState('');
  const years = [...new Set(data.map((r) => r.month.slice(0, 4)))].sort().reverse();
  const [yr, setYr] = useState('');
  const sel = years.includes(yr) ? yr : years[0];
  const shown = data.filter((r) => r.month.startsWith(sel || '____'));
  const tot = (k) => shown.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const COLS = [['Bhagiratha KL', (r) => dash(r.bh)], ['WTP KL', (r) => dash(r.wtp)], ['STP KL', (r) => dash(r.stp)], ['STP % of WTP', (r) => (r.stpPct != null ? `${r.stpPct.toFixed(0)}%` : '—')],
    ['Salt kg', (r) => (r.hasChem ? n0(r.salt) : '—')], ['Chlorine L', (r) => (r.hasChem ? n0(r.chlorine) : '—')], ['Diesel L', (r) => dash(r.litres)], ['Diesel ₹', (r) => dash(r.diesel, inr)],
    ['DG billed ₹', (r) => dash(r.dg, inr)], ['EB units', (r) => dash(r.ebUnits)], ['EB bills ₹', (r) => dash(r.eb, inr)]];
  const GROUPS = [['Water (KL)', [0, 1, 2, 3]], ['Chemicals', [4, 5]], ['Diesel & DG', [6, 7, 8]], ['Electricity', [9, 10]]];
  return (
    <div data-testid="monthly-summary">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, flex: 1 }}>Monthly summary</h2>
        {years.length > 0 && <select className="pick-year" aria-label="Year" data-testid="summary-year" value={sel} onChange={(e) => { setYr(e.target.value); setOpen(''); }}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>}
      </div>
      <div className="muted" style={{ marginBottom: 10 }}>Plant logs, DG fuel, DG bills and electricity bills for each month, side by side.</div>
      {shown.length > 0 && <div data-testid="summary-year-tiles"><MoneyTiles items={[
        { label: `${sel} water`, value: `${n0(tot('wtp'))} KL`, sub: `WTP treated · STP ${n0(tot('stp'))} KL` },
        { label: 'Bhagiratha', value: `${n0(tot('bh'))} KL`, sub: '' },
        { label: 'Salt / chlorine', value: `${n0(tot('salt'))} kg`, sub: `${n0(tot('chlorine'))} L chlorine` },
        { label: 'Diesel', value: inr(tot('diesel')), sub: `${n0(tot('litres'))} L` },
        { label: 'Electricity bills', value: inr(tot('eb')), sub: `${n0(tot('ebUnits'))} kWh` },
      ]} /></div>}
      {shown.length === 0 ? <div className="empty">Nothing logged yet.</div> : (
        <>
          <div className="table-wrap sum-table-wrap" style={{ marginTop: 10 }}><table className="resp-table" data-testid="summary-table">
            <thead><tr><th>Month</th>{COLS.map(([h]) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.month} data-testid="summary-row" data-month={r.month} onClick={() => setOpen(open === r.month ? '' : r.month)} style={{ cursor: 'pointer' }}>
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
        return (
          <div className="card" style={{ marginTop: 12 }} data-testid="summary-detail">
            <h3 style={{ marginTop: 0 }}>{monthLabel(open)}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14 }}>
              <div><b>Electricity bills</b>{bills.length ? bills.map((b) => <div key={b.id}>{b.service}: {n0(b.units)} kWh · {inr(b.amount)} <span className="tag">{b.status}</span></div>) : <div className="muted">None recorded.</div>}</div>
              <div><b>Diesel refills</b>{refills.length ? refills.map((f) => <div key={f.id}>{dm(f.date)}: {n0(f.litres)} L · {inr(f.amount)}</div>) : <div className="muted">None this month.</div>}</div>
              <div><b>Cost per unit</b><div>{r.ebUnits ? `Electricity ₹${(r.eb / r.ebUnits).toFixed(2)} / kWh` : '—'}</div><div>{r.litres ? `Diesel ₹${(r.diesel / r.litres).toFixed(2)} / L` : ''}</div></div>
            </div>
          </div>
        );
      })()}
      <small className="muted" style={{ display: 'block', marginTop: 8 }}>Click a month for the bills and refills behind it. “—” means nothing is recorded for that month; DG billed is what was billed to villas (Billing &amp; Finance, category DG).</small>
    </div>
  );
}

import React, { useMemo, useState } from 'react';
import { takeHint } from '../../lib/openHint.js';
import SectionPage from '../../components/SectionPage.jsx';
import Modal from '../../components/Modal.jsx';
import InventoryModule from '../inventory/InventoryModule.jsx';
import PlantLogs, { MonthlySummary } from './PlantLogs.jsx';
import CustomLog, { ManageLogs } from './CustomLogs.jsx';
import RecordModal from '../billing/RecordModal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import ServiceVisits from '../infra/ServiceVisits.jsx';
import { fyRange, currentFy, actualsByHead } from '../../lib/bank/analysis.js';
import { readWorkbook } from '../../lib/files/xlsxRead.js';
import { fmtDate, money } from '../../lib/locale.js';

const inr = (n) => money(n);
const num = (n, d = 1) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const dmy = (iso) => fmtDate(iso, { empty: '—' });
const today = () => new Date().toISOString().slice(0, 10);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Plant & Assets (formerly Plant Logs / Infrastructure): daily water & sewage plant logs, monthly summary, DG fuel log with performance, electricity bills, villa electricity, inventory and the equipment & assets register. */
export default function AssetsModule({ only = '' }) {
  const { tabAllowed, roleId, hasPermission } = useApp();
  const { records: logTypes, save: saveLogType } = useCollection(COLLECTIONS.LOG_TYPES, 'Log Types');
  const canLogTypes = roleId === 'super_admin' || hasPermission('MANAGE_UTILITY_TYPES');
  const [manageLogs, setManageLogs] = useState(false);
  const activeLogs = logTypes.filter((t) => t.active !== false);
  const ALL = [['plant', 'Water & sewage plants'], ['summary', 'Monthly summary'], ['dg', 'DG fuel log'], ['electricity', 'Electricity bills'], ['villas', 'Villa electricity'], ['inventory', 'Inventory'], ['equipment', 'Equipment & assets']];
  // two levels so no tab strip ever has to scroll sideways: the group first, then its pages (each page keeps its own per-role tab switch)
  const GROUPS = [['ops', '⚙ Plant & operations', ['plant', 'summary', 'dg', 'electricity', 'villas', 'logs', ...activeLogs.map((t) => `log:${t.id}`)]], ['assets', '🧰 Inventory & Assets', ['inventory', 'equipment']]].filter(([gid]) => !only || gid === only);
  const logsOn = tabAllowed('assets.logs') && (activeLogs.length > 0 || canLogTypes);
  const tabs = [...ALL.filter(([id]) => tabAllowed(`assets.${id}`)), ...(logsOn ? [['logs', 'Other logs'], ...activeLogs.map((t) => [`log:${t.id}`, `${t.icon || '📝'} ${t.name}`])] : [])];
  const first = only === 'assets' ? 'inventory' : 'plant';
  const [raw, setTab] = useState(() => takeHint([...ALL.map(([id]) => id), 'logs']) || first);
  const tab = tabs.some(([id]) => id === raw) ? raw : tabs[0]?.[0];
  const groups = GROUPS.map(([gid, label, ids]) => ({ gid, label, pages: tabs.filter(([id]) => ids.includes(id)) })).filter((g) => g.pages.length);
  const group = groups.find((g) => g.pages.some(([id]) => id === tab)) || groups[0];
  return (
    <div>
      {!only && <div className="sub-tabs plant-groups" aria-label="Plant log sections" data-testid="plant-groups">
        {groups.map((g) => <button key={g.gid} type="button" aria-pressed={g.gid === group?.gid} className={g.gid === group?.gid ? 'active' : ''} data-testid={`pgroup-${g.gid}`} onClick={() => setTab(g.pages[0][0])}>{g.label}</button>)}
      </div>}
      {group && group.pages.length > 1 && (
        <div className="sub-tabs plant-pages" aria-label={group.label} data-testid="plant-pages">
          {group.pages.filter(([id]) => id !== 'logs' || !activeLogs.length).map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} className={tab === id ? 'active' : ''} data-testid={`ptab-${id}`} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      )}
      {tab === 'logs' && (
        <div className="card" data-testid="logs-home">
          <h3 style={{ marginTop: 0 }}>Other logs</h3>
          <p className="muted">{canLogTypes ? 'Create a log for anything the team has to keep dated records of - pest control, generator service, chemical dosing. It then appears here as its own page.' : 'No other logs have been set up yet.'}</p>
          {canLogTypes && <button className="btn" data-testid="manage-logs" onClick={() => setManageLogs(true)}>⚙ Manage logs</button>}
        </div>
      )}
      {tab.startsWith('log:') && activeLogs.find((t) => `log:${t.id}` === tab) && (<>
        {canLogTypes && <div style={{ textAlign: 'right', marginBottom: 6 }}><button className="btn secondary sm" data-testid="manage-logs" onClick={() => setManageLogs(true)}>⚙ Manage logs</button></div>}
        <CustomLog type={activeLogs.find((t) => `log:${t.id}` === tab)} />
      </>)}
      {manageLogs && <ManageLogs types={logTypes} save={saveLogType} onPicked={(id) => setTab(`log:${id}`)} onClose={() => setManageLogs(false)} />}
      {tab === 'plant' && <PlantLogs />}
      {tab === 'summary' && <MonthlySummary />}
      {tab === 'dg' && <DgFuel />}
      {tab === 'electricity' && <ElectricityBills />}
      {tab === 'villas' && <VillaElectricity />}
      {tab === 'inventory' && <InventoryModule />}
      {tab === 'equipment' && <Equipment />}
    </div>
  );
}

// ---------------------------------------------------------------- DG fuel log + performance
/** Consumption between consecutive refills. A refill's litres are what the set burned since the previous refill, so it only
 * counts when both tanks were filled to full. */
export function dgPerformance(logs) {
  const sorted = [...logs].sort((a, b) => (a.date === b.date ? Number(a.hoursReading) - Number(b.hoursReading) : a.date < b.date ? -1 : 1));
  const rows = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]; const b = sorted[i];
    const hours = Number(b.hoursReading) - Number(a.hoursReading);
    const kwh = a.kwhReading !== '' && a.kwhReading != null && b.kwhReading !== '' && b.kwhReading != null ? Number(b.kwhReading) - Number(a.kwhReading) : null;
    const counted = hours > 0 && !a.partial && !b.partial;
    const litres = Number(b.litres);
    rows.push({ id: b.id, date: b.date, from: a.date, hours, kwh, litres, rate: Number(b.rate), counted,
      lph: counted ? litres / hours : null, lpk: counted && kwh > 0 ? litres / kwh : null, cpk: counted && kwh > 0 ? (litres / kwh) * Number(b.rate) : null, cph: counted ? (litres * Number(b.rate)) / hours : null });
  }
  const ok = rows.filter((r) => r.counted);
  const sum = (f) => ok.reduce((s, r) => s + f(r), 0);
  const kOk = ok.filter((r) => r.kwh > 0);
  const avg = {
    lph: ok.length ? sum((r) => r.litres) / sum((r) => r.hours) : null,
    lpk: kOk.length ? kOk.reduce((s, r) => s + r.litres, 0) / kOk.reduce((s, r) => s + r.kwh, 0) : null,
    cpk: kOk.length ? kOk.reduce((s, r) => s + r.litres * r.rate, 0) / kOk.reduce((s, r) => s + r.kwh, 0) : null,
  };
  rows.forEach((r) => { r.high = r.counted && ((avg.lpk && r.lpk && r.lpk > avg.lpk * 1.12) || (avg.lph && r.lph > avg.lph * 1.15)); });
  return { rows, avg };
}

function DgFuel() {
  const { records: logs } = useCollection(COLLECTIONS.DG_FUEL_LOGS, 'DG Fuel Log');
  const { records: txns } = useCollection(COLLECTIONS.BANK_TXNS, 'Bank Statement');
  const { records: dues } = useCollection(COLLECTIONS.DUES, 'Billing & Finance');
  const fy = currentFy();
  const { from, to } = fyRange(fy);
  const perf = useMemo(() => dgPerformance(logs), [logs]);
  const inFy = logs.filter((l) => l.date >= from && l.date <= to);
  const litres = inFy.reduce((s, l) => s + Number(l.litres || 0), 0);
  const spend = inFy.reduce((s, l) => s + Number(l.amount || 0), 0);
  const stmtDiesel = (actualsByHead(txns, fy).Diesel || 0);
  const billed = dues.filter((d) => d.category === 'DG' && d.dueDate >= from && d.dueDate <= to).reduce((s, d) => s + Number(d.amount || 0), 0);

  const cards = () => [
    { label: `Diesel bought ${fy}`, value: `${num(litres, 0)} L`, sub: `${inr(spend)} per the fuel log` },
    { label: 'Average litres / hour', value: perf.avg.lph ? num(perf.avg.lph) : '—', sub: 'across full-tank intervals' },
    { label: 'Litres per kWh', value: perf.avg.lpk ? num(perf.avg.lpk, 3) : '—', sub: perf.avg.lpk ? '' : 'needs the kWh meter reading' },
    { label: 'Diesel cost per kWh', value: perf.avg.cpk ? `₹${num(perf.avg.cpk, 2)}` : '—', sub: 'at the rates paid' },
    { label: 'Diesel on bank statements', value: inr(stmtDiesel), sub: `${fy} · compare with the log` },
    { label: 'DG billed to villas', value: inr(billed), sub: spend ? `${Math.round((billed / spend) * 100)}% of the diesel cost` : '' },
  ];
  const before = (draft, all) => {
    const others = all.filter((l) => l.id !== draft.id && l.generator === draft.generator);
    const prev = others.filter((l) => l.date < draft.date || (l.date === draft.date && Number(l.hoursReading) <= Number(draft.hoursReading))).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const next = others.filter((l) => l.date > draft.date).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    if (prev && Number(draft.hoursReading) < Number(prev.hoursReading)) return `The run-hour meter (${draft.hoursReading}) is lower than the ${dmy(prev.date)} reading (${prev.hoursReading}).`;
    if (next && Number(draft.hoursReading) > Number(next.hoursReading)) return `The run-hour meter (${draft.hoursReading}) is higher than the later ${dmy(next.date)} reading (${next.hoursReading}).`;
    if (prev && draft.kwhReading !== '' && draft.kwhReading != null && prev.kwhReading !== '' && prev.kwhReading != null && Number(draft.kwhReading) < Number(prev.kwhReading)) return `The kWh meter (${draft.kwhReading}) is lower than the ${dmy(prev.date)} reading (${prev.kwhReading}).`;
    if (Number(draft.litres) <= 0 || Number(draft.rate) <= 0) return 'Litres and rate must be more than zero.';
    if (draft.amount === '' || draft.amount == null) draft.amount = Math.round(Number(draft.litres) * Number(draft.rate));
    return '';
  };
  return (
    <>
      <SectionPage
        sectionId={COLLECTIONS.DG_FUEL_LOGS}
        title="DG fuel log"
        description="Log every diesel refill with the run-hour (and kWh) meter reading. Performance is worked out between full-tank refills."
        recordName="refill"
        formHelp="Fill the tank to full each time and tick “Partial fill” only when you could not; the readings are taken at the moment of refill."
        statCards={cards}
        filters={[{ key: 'generator', label: 'All generators' }]}
        dateFields={[{ key: 'date', label: 'Refill date' }]} defaultRange="last12"
        baseSort={{ key: 'date', dir: 'desc' }}
        onBeforeSave={before}
      />
      <div className="card" style={{ marginTop: 16 }} data-testid="dg-perf">
        <h2 style={{ marginTop: 0 }}>Performance between refills</h2>
        {perf.rows.length === 0 ? <div className="empty">Log at least two refills to see performance.</div> : (
          <div className="table-wrap"><table className="resp-table">
            <thead><tr><th>Interval</th><th>Hours run</th><th>kWh made</th><th>Diesel (L)</th><th>L / hour</th><th>L / kWh</th><th>₹ / kWh</th><th /></tr></thead>
            <tbody>
              {[...perf.rows].reverse().map((r) => (
                <tr key={r.id}>
                  <td data-label="Interval">{dmy(r.from)} → {dmy(r.date)}</td>
                  <td data-label="Hours">{num(r.hours)}</td>
                  <td data-label="kWh">{r.kwh === null ? '—' : num(r.kwh, 0)}</td>
                  <td data-label="Diesel">{num(r.litres, 0)}</td>
                  <td data-label="L/hour">{r.lph === null ? '—' : num(r.lph)}</td>
                  <td data-label="L/kWh">{r.lpk === null ? '—' : num(r.lpk, 3)}</td>
                  <td data-label="₹/kWh">{r.cpk === null ? '—' : num(r.cpk, 2)}</td>
                  <td>{r.high && <span className="tag red">High use</span>}{!r.counted && <span className="tag">Not counted (partial fill)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <small className="muted">“High use” = more than 12% above the average litres per kWh (or 15% above litres per hour). A jump usually means a leak, theft, a failing injector or running at light load.</small>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Electricity bills
function ElectricityBills() {
  const fy = currentFy();
  const { from, to } = fyRange(fy);
  const cards = (rows) => {
    const r = rows.filter((x) => x.billDate >= from && x.billDate <= to);
    const amt = r.reduce((s, x) => s + Number(x.amount || 0), 0);
    const units = r.reduce((s, x) => s + Number(x.units || 0), 0);
    const exported = r.reduce((s, x) => s + Number(x.exportUnits || 0), 0);
    const credit = r.reduce((s, x) => s + Number(x.creditAmount || 0), 0);
    const unpaid = rows.filter((x) => x.status !== 'Paid');
    const next = unpaid.map((x) => x.dueDate).sort()[0];
    return [
      { label: `Billed ${fy}`, value: inr(amt), sub: `${r.length} bills` },
      { label: 'Units imported', value: `${num(units, 0)} kWh`, sub: units ? `₹${num(amt / units, 2)} per unit` : '' },
      { label: 'Exported / credit', value: `${num(exported, 0)} kWh`, sub: `${inr(credit)} credit on bills` },
      { label: 'Unpaid', value: inr(unpaid.reduce((s, x) => s + Number(x.amount || 0), 0)), sub: `${unpaid.length} bill${unpaid.length === 1 ? '' : 's'}` },
      { label: 'Next due', value: next ? dmy(next) : '—', sub: next && next < today() ? 'Overdue' : '' },
    ];
  };
  const before = (d) => {
    if (!MONTH_RE.test(String(d.period || ''))) return 'Bill month must look like 2026-09.';
    if (Number(d.amount) <= 0) return 'Total payable must be more than zero.';
    const parts = [d.fixedCharges, d.energyCharges, d.otherCharges];
    const credit = Number(d.creditAmount || 0);
    if (Number(d.exportUnits) < 0 || credit < 0) return 'Exported units and credit cannot be negative.';
    if (parts.every((x) => x !== '' && x != null) && Math.abs(parts.reduce((s, x) => s + Number(x), 0) - credit - Number(d.amount)) > 2) {
      return `The charges add up to ${inr(parts.reduce((s, x) => s + Number(x), 0))}${credit ? ` less the ${inr(credit)} credit` : ''} but the total payable is ${inr(d.amount)}. Check the bill.`;
    }
    if (d.status === 'Paid' && (!d.paidOn || !d.paidFrom)) return 'For a paid bill, enter the paid-on date and the account it was paid from.';
    d.costPerUnit = Number(d.units) > 0 ? Math.round((Number(d.amount) / Number(d.units)) * 100) / 100 : 0;
    return '';
  };
  return (
    <SectionPage
      sectionId={COLLECTIONS.ELECTRICITY_BILLS}
      title="Electricity bills"
      description="Every supply bill in one place — connection number, units, demand, charges, due date, payment and a copy of the bill."
      recordName="electricity bill"
      formHelp="Copy the key facts from the bill. The total should match the charges; cost per unit is worked out for you."
      statCards={cards}
      filters={[{ key: 'service', label: 'All supplies' }, { key: 'status', label: 'All status' }]}
      periodFilter={{ key: 'period', label: 'Bill' }} defaultRange="last12"
      baseSort={{ key: 'dueDate', dir: 'desc' }}
      onBeforeSave={before}
    />
  );
}

// ---------------------------------------------------------------- Villa electricity (+ Excel import)
const ALIAS = { unit: ['villa', 'unit', 'villa no', 'villa number', 'house'], month: ['month', 'period', 'bill month'], units: ['units', 'kwh', 'units consumed', 'consumption', 'import units', 'units imported'], exportUnits: ['export', 'export units', 'units exported', 'exported'], creditUnits: ['credit units', 'units credit'], creditAmount: ['credit', 'credit amount', 'credit (rs)', 'credit ₹', 'adjustment'], amount: ['amount', 'bill amount', 'bill'], none: ['__none__'], mdKw: ['md', 'md (kw)', 'max demand', 'maximum demand', 'recorded md', 'kw'] };
function monthOf(v) {
  if (v instanceof Date) { const d = new Date(v.getTime() + 12 * 3600e3); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
  const t = String(v ?? '').trim();
  if (MONTH_RE.test(t)) return t;
  const m = /^([A-Za-z]{3})[a-z]*[ -]+(\d{2,4})$/.exec(t);
  if (m) { const i = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase()); if (i >= 0) return `${m[2].length === 2 ? 2000 + Number(m[2]) : m[2]}-${String(i + 1).padStart(2, '0')}`; }
  return '';
}

function VillaImport({ existing, onClose }) {
  const { records: rules } = useCollection(COLLECTIONS.VILLA_IMPORT_RULES, 'Villa Electricity Import Rules');
  const [ruleId, setRuleId] = useState('');
  const [file, setFile] = useState(null);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [managing, setManaging] = useState(false);
  const isAdmin = canWriteCollection(COLLECTIONS.VILLA_IMPORT_RULES, getPrincipal());
  const rule = rules.find((r) => r.id === ruleId) || null; // null = auto-detect common headings

  async function parse(f, r) {
    setErr(''); setRes(null);
    if (!f) return;
    try {
      const XLSX = await import('xlsx');
      const wb = await readWorkbook(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const sheetName = r?.sheet && wb.SheetNames.includes(r.sheet) ? r.sheet : wb.SheetNames[0];
      if (r?.sheet && !wb.SheetNames.includes(r.sheet)) throw new Error(`The file has no sheet called “${r.sheet}”. Sheets found: ${wb.SheetNames.join(', ')}.`);
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      const headIdx = Math.max(0, Number(r?.headerRow || 1) - 1);
      const head = (grid[headIdx] || []).map((h) => String(h).trim().toLowerCase());
      const pick = (ruleCol, aliasKey) => {
        if (r) return ruleCol ? head.indexOf(String(ruleCol).trim().toLowerCase()) : -1;
        return head.findIndex((h) => ALIAS[aliasKey].includes(h));
      };
      const col = {
        unit: pick(r?.unitCol, 'unit'), month: pick(r?.monthCol, 'month'), units: pick(r?.unitsCol, 'units'), exportUnits: pick(r?.exportCol, 'exportUnits'),
        creditUnits: pick(r?.creditUnitsCol, 'creditUnits'), amount: pick(r?.amountCol, 'amount'), creditAmount: pick(r?.creditAmountCol, 'creditAmount'), mdKw: pick(r?.mdCol, 'mdKw'), sanctioned: r ? pick(r.sanctionedCol, 'none') : -1,
      };
      if (col.unit < 0 || col.month < 0 || col.units < 0) {
        const missing = [col.unit < 0 && (r ? `“${r.unitCol}” (Villa)` : 'Villa'), col.month < 0 && (r ? `“${r.monthCol}” (Month)` : 'Month'), col.units < 0 && (r ? `“${r.unitsCol}” (Units)` : 'Units')].filter(Boolean).join(', ');
        throw new Error(`Could not find the column${missing.includes(',') ? 's' : ''} ${missing} in row ${headIdx + 1}. Found: ${(grid[headIdx] || []).filter(Boolean).join(', ') || 'nothing'}.${isAdmin ? '' : ' Ask the Super Admin to check the import rule.'}`);
      }
      const have = new Set(existing.map((x) => `${x.unit}|${x.month}`));
      const rows = []; let dupes = 0; let bad = 0;
      const val = (row, i) => (i >= 0 && row[i] !== '' ? Number(row[i]) : '');
      for (const row of grid.slice(headIdx + 1)) {
        const rawUnit = String(row[col.unit] ?? '').trim();
        if (!rawUnit) continue;
        const unit = /^\d+$/.test(rawUnit) ? `${r ? (r.unitPrefix ?? 'Villa ') : 'Villa '}${rawUnit}` : rawUnit;
        const month = monthOf(row[col.month]);
        const units = Number(row[col.units]);
        if (!month || !Number.isFinite(units)) { bad++; continue; }
        if (have.has(`${unit}|${month}`)) { dupes++; continue; }
        have.add(`${unit}|${month}`);
        rows.push({ unit, month, units, exportUnits: val(row, col.exportUnits), creditUnits: val(row, col.creditUnits), creditAmount: val(row, col.creditAmount), amount: val(row, col.amount), mdKw: val(row, col.mdKw), sanctionedKw: val(row, col.sanctioned), notes: '' });
      }
      setRes({ rows, dupes, bad, name: f.name });
    } catch (e) { setErr(e.message || 'Could not read the file.'); }
  }
  async function run() {
    const n = await secureStorage.importMany(COLLECTIONS.VILLA_ELECTRICITY, res.rows, { label: 'Villa Electricity', summary: `Imported ${res.rows.length} villa-month readings from ${res.name}` });
    onClose(`Imported ${n} villa-month rows${res.dupes ? ` (${res.dupes} already present were skipped)` : ''}.`);
  }
  return (
    <Modal title="Import villa electricity" subtitle="Choose the Excel file and the import rule that says which column holds what." onClose={() => onClose('')}>
      {err && <div className="notice error">{err}</div>}
      <div className="form-grid">
        <div className="field"><label>Import rule</label>
          <select aria-label="Villa import rule" value={ruleId} onChange={(e) => { setRuleId(e.target.value); parse(file, rules.find((x) => x.id === e.target.value) || null); }}>
            <option value="">Auto-detect common headings</option>
            {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Excel file (.xlsx / .xls) *</label><input type="file" aria-label="Villa electricity file" accept=".xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0] || null; setFile(f); parse(f, rule); }} /></div>
      </div>
      {isAdmin && <p style={{ margin: '6px 0' }}><button type="button" className="btn secondary" onClick={() => setManaging(true)}>Manage import rules</button></p>}
      {res && <p data-testid="villa-import-preview"><b>{res.rows.length}</b> new rows · {res.dupes} already present · {res.bad} rows skipped (missing month or units)</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn" disabled={!res?.rows.length} onClick={run}>Import {res?.rows.length || ''} rows</button>
        <button type="button" className="btn secondary" onClick={() => onClose('')}>Cancel</button>
      </div>
      {managing && <VillaRules rules={rules} onClose={() => setManaging(false)} />}
    </Modal>
  );
}

function VillaRules({ rules, onClose }) {
  const [editing, setEditing] = useState(null);
  return (
    <Modal title="Villa electricity import rules" subtitle="Type each column’s exact heading from the Excel file. Leave a column blank if the file doesn’t have it." onClose={onClose}>
      <div className="table-wrap"><table className="resp-table">
        <thead><tr><th>Rule</th><th>Header row</th><th>Villa / Month / Units</th><th /></tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}><td data-label="Rule"><b>{r.name}</b></td><td data-label="Header row">{r.headerRow}</td><td data-label="Columns"><small>{[r.unitCol, r.monthCol, r.unitsCol].filter(Boolean).join(' / ')}</small></td>
              <td><button type="button" className="btn secondary" onClick={() => setEditing(r)}>Edit</button></td></tr>
          ))}
        </tbody>
      </table></div>
      <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => setEditing({ headerRow: 1, unitPrefix: 'Villa ' })}>+ Add rule</button></div>
      {editing && <RecordModal collection={COLLECTIONS.VILLA_IMPORT_RULES} label="Villa Electricity Import Rules" record={editing} allowDelete onClose={() => setEditing(null)} />}
    </Modal>
  );
}

function VillaElectricity() {
  const { records } = useCollection(COLLECTIONS.VILLA_ELECTRICITY, 'Villa Electricity');
  const canWrite = canWriteCollection(COLLECTIONS.VILLA_ELECTRICITY, getPrincipal());
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState('');
  const cards = (rows) => {
    const latest = rows.map((r) => r.month).sort().pop();
    const m = rows.filter((r) => r.month === latest);
    const units = m.reduce((s, r) => s + Number(r.units || 0), 0);
    const top = [...m].sort((a, b) => Number(b.units) - Number(a.units))[0];
    const over = m.filter((r) => Number(r.sanctionedKw) > 0 && Number(r.mdKw) > Number(r.sanctionedKw)).length;
    return [
      { label: 'Latest month', value: latest || '—', sub: `${m.length} villas recorded` },
      { label: 'Total units', value: `${num(units, 0)} kWh`, sub: m.length ? `${num(units / m.length, 0)} per villa` : '' },
      { label: 'Exported / credit', value: `${num(m.reduce((s, r) => s + Number(r.exportUnits || 0), 0), 0)} kWh`, sub: `${inr(m.reduce((s, r) => s + Number(r.creditAmount || 0), 0))} credit` },
      { label: 'Highest', value: top ? top.unit : '—', sub: top ? `${num(top.units, 0)} kWh` : '' },
      { label: 'Above sanctioned load', value: over, sub: 'recorded MD over sanctioned kW' },
    ];
  };
  const before = (d, all) => {
    if (!MONTH_RE.test(String(d.month || ''))) return 'Month must look like 2026-09.';
    if (Number(d.exportUnits) < 0 || Number(d.creditAmount) < 0) return 'Exported units and credit cannot be negative.';
    if (all.some((r) => r.id !== d.id && r.unit === d.unit && r.month === d.month)) return `${d.unit} already has a reading for ${d.month}. Edit that row instead.`;
    return '';
  };
  return (
    <>
      {msg && <div className="notice" data-testid="villa-notice">{msg}</div>}
      <SectionPage
        sectionId={COLLECTIONS.VILLA_ELECTRICITY}
        title="Villa electricity"
        description="Monthly units, bill amount and recorded maximum demand per villa — add one by one or import from Excel."
        recordName="villa reading"
        statCards={cards}
        headerExtra={canWrite ? <button type="button" className="btn secondary" onClick={() => setImporting(true)}>Import Excel</button> : null}
        periodFilter={{ key: 'month', label: 'Month' }} defaultRange="last12"
        baseSort={{ key: 'month', dir: 'desc' }}
        onBeforeSave={before}
      />
      {importing && <VillaImport existing={records} onClose={(m) => { setImporting(false); if (m) setMsg(m); }} />}
    </>
  );
}

// ---------------------------------------------------------------- Equipment register
export function Equipment() {
  const cards = (rows) => {
    const live = rows.filter((r) => r.status !== 'Retired');
    const overdue = live.filter((r) => r.nextService && r.nextService < today());
    const in60 = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    const warranty = live.filter((r) => r.warrantyUntil && r.warrantyUntil >= today() && r.warrantyUntil <= in60);
    return [
      { label: 'Items (rows / units)', value: `${live.length} / ${live.reduce((s, r) => s + (Number(r.quantity) || 1), 0)}`, sub: `${new Set(live.map((r) => r.area)).size} areas` },
      { label: 'CCTV cameras', value: live.filter((r) => r.type === 'CCTV camera').reduce((s, r) => s + (Number(r.quantity) || 1), 0), sub: `${live.filter((r) => r.type === 'UPS / battery').length} UPS rows` },
      { label: 'Street lights', value: live.filter((r) => r.type === 'Street light').reduce((s, r) => s + (Number(r.quantity) || 1), 0) },
      { label: 'Needs attention / repair', value: live.filter((r) => r.status === 'Needs attention' || r.status === 'Under repair').length },
      { label: 'Service overdue', value: overdue.length, sub: overdue.slice(0, 2).map((r) => r.name).join(', ') },
      { label: 'Warranty ending in 60 days', value: warranty.length },
    ];
  };
  return (
    <SectionPage
      sectionId={COLLECTIONS.EQUIPMENT}
      title="Equipment & assets"
      description="Everything installed across the community — STP/WTP motors, clubhouse ACs, CCTV cameras and their UPS, street lights, panels. Identical items can share one row with a quantity."
      recordName="equipment or asset"
      statCards={cards}
      filters={[{ key: 'area', label: 'All areas' }, { key: 'type', label: 'All types' }, { key: 'status', label: 'All conditions' }]}
      dateFields={[{ key: 'nextService', label: 'Next service' }]}
      baseSort={{ key: 'nextService', dir: 'asc' }}
      formExtra={(rec) => (rec?.id ? <ServiceVisits asset={rec} canEdit={canWriteCollection(COLLECTIONS.EQUIPMENT, getPrincipal())} /> : null)}
    />
  );
}

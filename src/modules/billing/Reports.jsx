// Billing & Finance -> Reports: income & expenditure, fund statement, levy collection, unit statement, TDS and the cash book.
// Every figure is computed from the ledger, the bills and the credit account - nothing is typed in twice. Tables print with the 🖨 Print button; CSV downloads the same rows.
import React, { useEffect, useMemo, useState } from 'react';
import { SegTabs, MoneyTiles } from '../../components/ui.jsx';
import Modal from '../../components/Modal.jsx';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { fyRange, fyOfDate, currentFy } from '../../lib/bank/analysis.js';
import { inr, dmy, todayIso, r2, levyProgress, TDS_SECTIONS } from '../../lib/finance/rules.js';
import { recordPayment, MODES } from '../../lib/paymentEngine.js';
import { downloadCsv } from '../../lib/finance/csv.js';

const sum = (rows, f) => r2(rows.reduce((n, r) => n + (Number(f(r)) || 0), 0));
const groupBy = (rows, key) => { const m = new Map(); rows.forEach((r) => { const k = key(r) || 'Other'; m.set(k, [...(m.get(k) || []), r]); }); return [...m.entries()]; };
const Csv = ({ name, header, rows }) => <button type="button" className="btn secondary sm" data-testid="csv" onClick={() => downloadCsv(name, header, rows)}>⬇ CSV</button>;
const gross = (l) => (Number(l.amount) || 0) + (Number(l.tdsAmount) || 0);

function useFy(ledger) {
  const options = useMemo(() => [...new Set([currentFy(), ...ledger.map((l) => l.date && fyOfDate(l.date)).filter(Boolean)])].sort().reverse(), [ledger]);
  const [fy, setFy] = useState(currentFy());
  const range = fyRange(fy);
  const label = (x) => { const r = fyRange(x); return `${x} (${dmy(r.from)} – ${dmy(r.to)})`; };
  const picker = <div className="field" style={{ maxWidth: 360 }}><label>Financial year</label><select data-testid="rep-fy" value={fy} onChange={(e) => setFy(e.target.value)}>{options.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></div>;
  return { fy, range, picker };
}

/* ----------------------------------------------- income & expenditure -- */
function IncomeExpenditure({ ledger, accounts }) {
  const { fy, range, picker } = useFy(ledger);
  const rows = ledger.filter((l) => !l.internal && l.date >= range.from && l.date <= range.to);
  const inc = groupBy(rows.filter((l) => l.type === 'Credit'), (l) => l.category || l.module).map(([k, v]) => [k, sum(v, (l) => l.amount)]).sort((a, b) => b[1] - a[1]);
  const exp = groupBy(rows.filter((l) => l.type === 'Debit'), (l) => l.category || l.module).map(([k, v]) => [k, sum(v, gross)]).sort((a, b) => b[1] - a[1]);
  const ti = sum(inc, (x) => x[1]); const te = sum(exp, (x) => x[1]);
  const byAcc = accounts.map((a) => { const r = rows.filter((l) => l.account === a.name); return [a.name, sum(r.filter((l) => l.type === 'Credit'), (l) => l.amount), sum(r.filter((l) => l.type === 'Debit'), (l) => l.amount)]; }).filter((x) => x[1] || x[2]);
  return (
    <div data-testid="rep-ie">
      {picker}
      <MoneyTiles items={[{ label: 'Income', value: inr(ti), tone: 'good' }, { label: 'Expenditure', value: inr(te) }, { label: ti >= te ? 'Surplus' : 'Deficit', value: inr(Math.abs(ti - te)), tone: ti >= te ? 'good' : 'bad' }]} />
      <div style={{ display: 'flex', gap: 8, margin: '6px 0' }}><Csv name={`income-expenditure-${fy}`} header={['Type', 'Head', 'Amount']} rows={[...inc.map(([k, v]) => ['Income', k, v]), ...exp.map(([k, v]) => ['Expenditure', k, v])]} /></div>
      <h3>Income & expenditure · {fy}</h3>
      <table className="table resp-table" data-testid="rep-ie-table">
        <thead><tr><th>Head</th><th style={{ textAlign: 'right' }}>Income</th><th style={{ textAlign: 'right' }}>Expenditure</th></tr></thead>
        <tbody>
          {inc.map(([k, v]) => <tr key={`i${k}`}><td data-label="Head">{k}</td><td data-label="Income" style={{ textAlign: 'right' }}>{inr(v)}</td><td /></tr>)}
          {exp.map(([k, v]) => <tr key={`e${k}`}><td data-label="Head">{k}</td><td /><td data-label="Expenditure" style={{ textAlign: 'right' }}>{inr(v)}</td></tr>)}
          <tr><td><b>Total</b></td><td style={{ textAlign: 'right' }}><b>{inr(ti)}</b></td><td style={{ textAlign: 'right' }}><b>{inr(te)}</b></td></tr>
          <tr><td><b>{ti >= te ? 'Surplus for the year' : 'Deficit for the year'}</b></td><td colSpan={2} style={{ textAlign: 'right' }}><b>{inr(Math.abs(ti - te))}</b></td></tr>
        </tbody>
      </table>
      <h3 style={{ marginTop: 18 }}>Receipts & payments by bank account</h3>
      <table className="table resp-table" data-testid="rep-acc-table">
        <thead><tr><th>Account</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Net</th></tr></thead>
        <tbody>{byAcc.map(([n, c, d]) => <tr key={n}><td data-label="Account">{n}</td><td data-label="Received" style={{ textAlign: 'right' }}>{inr(c)}</td><td data-label="Paid" style={{ textAlign: 'right' }}>{inr(d)}</td><td data-label="Net" style={{ textAlign: 'right' }}>{inr(c - d)}</td></tr>)}</tbody>
      </table>
      <p className="muted" style={{ fontSize: 12 }}>Expenditure includes tax deducted at source (TDS) that was held back from vendors. Internal entries (no bank movement) are left out. This is a cash-basis statement from the ledger, not a full double-entry trial balance - your auditor prepares the statutory accounts.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- funds -- */
function Funds({ ledger }) {
  const { records: funds } = useCollection(C.FUNDS, 'Fund Position');
  const { fy, range, picker } = useFy(ledger);
  const live = ledger.filter((l) => !l.internal);
  const before = (f) => live.filter((l) => (l.fund || '') === f && l.date < range.from);
  const within = (f) => live.filter((l) => (l.fund || '') === f && l.date >= range.from && l.date <= range.to);
  const rowFor = (name, kind, opening) => {
    const o = r2(opening + sum(before(name), (l) => (l.type === 'Credit' ? l.amount : -l.amount)));
    const rc = sum(within(name).filter((l) => l.type === 'Credit'), (l) => l.amount); const pd = sum(within(name).filter((l) => l.type === 'Debit'), gross);
    return { name, kind, opening: o, rc, pd, closing: r2(o + rc - pd) };
  };
  const list = [...funds.map((f) => rowFor(f.name, f.kind || '', Number(f.balance) || 0)), rowFor('', 'Not assigned', 0)].filter((r) => r.opening || r.rc || r.pd || r.name);
  list.forEach((r) => { if (!r.name) r.name = 'No fund chosen'; });
  const byKind = groupBy(list.filter((r) => r.kind && r.kind !== 'Not assigned'), (r) => r.kind).map(([k, v]) => [k, sum(v, (r) => r.closing)]);
  return (
    <div data-testid="rep-funds">
      {picker}
      <MoneyTiles items={byKind.map(([k, v]) => ({ label: `${k} funds`, value: inr(v) }))} />
      <div style={{ margin: '6px 0' }}><Csv name={`fund-statement-${fy}`} header={['Fund', 'Kind', 'Opening', 'Received', 'Paid', 'Closing']} rows={list.map((r) => [r.name, r.kind, r.opening, r.rc, r.pd, r.closing])} /></div>
      <h3>Fund statement · {fy}</h3>
      <table className="table resp-table" data-testid="rep-funds-table">
        <thead><tr><th>Fund</th><th>Kind</th><th style={{ textAlign: 'right' }}>Opening</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Closing</th></tr></thead>
        <tbody>{list.map((r) => <tr key={r.name}><td data-label="Fund">{r.name}</td><td data-label="Kind">{r.kind}</td><td data-label="Opening" style={{ textAlign: 'right' }}>{inr(r.opening)}</td><td data-label="Received" style={{ textAlign: 'right' }}>{inr(r.rc)}</td><td data-label="Paid" style={{ textAlign: 'right' }}>{inr(r.pd)}</td><td data-label="Closing" style={{ textAlign: 'right' }}><b>{inr(r.closing)}</b></td></tr>)}</tbody>
      </table>
      <p className="muted" style={{ fontSize: 12 }}>Opening = the fund’s opening balance plus earlier receipts and payments tagged to it. Tag a fund on a payment (Make a payment → Fund) or let a special levy post to its fund automatically.</p>
    </div>
  );
}

/* --------------------------------------------------------------- levies -- */
function Levies() {
  const { records: levies } = useCollection(C.LEVIES, 'Special levies');
  const { records: dues } = useCollection(C.DUES, 'Billing & Finance');
  const rows = levyProgress(levies, dues);
  return (
    <div data-testid="rep-levies">
      <h3>Special levy collection</h3>
      {rows.length === 0 ? <p className="muted">No special levy has been raised yet. Use Dues → Special levy.</p> : (
        <table className="table resp-table" data-testid="rep-levy-table">
          <thead><tr><th>Levy</th><th>Fund</th><th>Payable by</th><th style={{ textAlign: 'right' }}>Units</th><th style={{ textAlign: 'right' }}>Raised</th><th style={{ textAlign: 'right' }}>Collected</th><th style={{ textAlign: 'right' }}>Pending</th><th>Paid</th></tr></thead>
          <tbody>{rows.map((l) => (
            <tr key={l.id} data-testid="levy-row"><td data-label="Levy"><b>{l.name}</b><div className="muted" style={{ fontSize: 12 }}>{l.purpose}</div></td><td data-label="Fund">{l.fund || '—'}</td><td data-label="Payable by">{dmy(l.dueDate)}</td>
              <td data-label="Units" style={{ textAlign: 'right' }}>{l.units}</td><td data-label="Raised" style={{ textAlign: 'right' }}>{inr(l.raised)}</td><td data-label="Collected" style={{ textAlign: 'right' }}>{inr(l.collected)}</td><td data-label="Pending" style={{ textAlign: 'right' }}>{inr(l.pending)}</td>
              <td data-label="Paid">{l.paidUnits}/{l.units} units ({l.raised ? Math.round((l.collected / l.raised) * 100) : 0}%)</td></tr>))}</tbody>
        </table>
      )}
      <div style={{ marginTop: 8 }}><Csv name="levies" header={['Levy', 'Purpose', 'Fund', 'Due', 'Units', 'Raised', 'Collected', 'Pending']} rows={rows.map((l) => [l.name, l.purpose, l.fund, l.dueDate, l.units, l.raised, l.collected, l.pending])} /></div>
    </div>
  );
}

/* ------------------------------------------------------------ unit statement -- */
function UnitStatement() {
  const { records: dues } = useCollection(C.DUES, 'Billing & Finance');
  const { records: credits } = useCollection(C.UNIT_CREDITS, 'Unit Credits');
  const { records: props } = useCollection(C.PROPERTIES, 'Properties & Residents');
  const [unit, setUnit] = useState('');
  const known = props.some((p) => p.unit === unit);
  const mine = dues.filter((d) => d.unit === unit).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  let run = 0;
  const lines = mine.map((d) => {
    const charged = Number(d.grossAmount) || Number(d.amount) || 0;
    const credit = Number(d.creditApplied) || 0;
    const paidCash = d.status === 'Paid' && d.paymentMode !== 'Unit credit' ? Number(d.amount) || 0 : 0;
    const outstanding = d.status === 'Paid' ? 0 : Number(d.amount) || 0;
    run = r2(run + outstanding);
    return { d, charged, credit, paidCash, outstanding, run };
  });
  const cmoves = credits.filter((c) => c.unit === unit).sort((a, b) => String(a.recordCreatedAt).localeCompare(String(b.recordCreatedAt)));
  const held = r2(cmoves.reduce((n, c) => n + (c.type === 'Credit' ? 1 : -1) * (Number(c.amount) || 0), 0));
  const prop = props.find((p) => p.unit === unit);
  return (
    <div data-testid="rep-unit">
      <div className="field" style={{ maxWidth: 320 }}><label>Unit</label><input list="rep-units" data-testid="rep-unit-input" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Type or choose a unit" /><datalist id="rep-units">{props.slice(0, 3000).map((p) => <option key={p.id} value={p.unit} />)}</datalist></div>
      {!known ? <p className="muted">Choose a unit to see everything billed to it, what it paid and what is outstanding.</p> : (
        <>
          <MoneyTiles items={[{ label: 'Billed', value: inr(sum(lines, (l) => l.charged)) }, { label: 'Paid', value: inr(sum(lines, (l) => l.paidCash)) }, { label: 'Credit used', value: inr(sum(lines, (l) => l.credit)) }, { label: 'Outstanding', value: inr(run), tone: run > 0 ? 'bad' : 'good' }, { label: 'Credit held', value: inr(held) }]} />
          <div style={{ margin: '6px 0' }}><Csv name={`statement-${unit}`} header={['Bill', 'Description', 'Due', 'Status', 'Billed', 'Credit used', 'Paid', 'Outstanding']} rows={lines.map((l) => [l.d.shortId, `${l.d.category} ${l.d.billedMonth || ''}`, l.d.dueDate, l.d.status, l.charged, l.credit, l.paidCash, l.outstanding])} /></div>
          <h3>Statement of account · {unit}{prop?.owner ? ` · ${prop.billTo === 'Tenant' && prop.tenant ? prop.tenant : prop.owner}` : ''}</h3>
          <table className="table resp-table" data-testid="rep-unit-table">
            <thead><tr><th>Bill</th><th>For</th><th>Due</th><th>Status</th><th style={{ textAlign: 'right' }}>Billed</th><th style={{ textAlign: 'right' }}>Credit used</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Owing</th></tr></thead>
            <tbody>{lines.map((l) => <tr key={l.d.id}><td data-label="Bill" className="mono">{l.d.shortId}</td><td data-label="For">{l.d.category}{l.d.billedMonth ? ` · ${l.d.billedMonth}` : ''}</td><td data-label="Due">{dmy(l.d.dueDate)}</td><td data-label="Status">{l.d.status}{l.d.paidAt ? ` ${dmy(l.d.paidAt)}` : ''}</td><td data-label="Billed" style={{ textAlign: 'right' }}>{inr(l.charged)}</td><td data-label="Credit used" style={{ textAlign: 'right' }}>{l.credit ? inr(l.credit) : '—'}</td><td data-label="Paid" style={{ textAlign: 'right' }}>{l.paidCash ? inr(l.paidCash) : '—'}</td><td data-label="Owing" style={{ textAlign: 'right' }}>{l.outstanding ? inr(l.outstanding) : '—'}</td></tr>)}</tbody>
          </table>
          {cmoves.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>Credit account</h3>
              <table className="table resp-table"><thead><tr><th>Date</th><th>Entry</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
                <tbody>{cmoves.map((c) => <tr key={c.id}><td data-label="Date">{dmy(c.date || String(c.recordCreatedAt).slice(0, 10))}</td><td data-label="Entry">{c.reason}</td><td data-label="Amount" style={{ textAlign: 'right' }}>{c.type === 'Credit' ? '+' : '−'}{inr(c.amount)}</td></tr>)}</tbody></table>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ TDS -- */
function Tds({ ledger, accounts }) {
  const { fy, range, picker } = useFy(ledger);
  const [dlg, setDlg] = useState(false);
  const rows = ledger.filter((l) => !l.internal && l.date >= range.from && l.date <= range.to);
  const ded = rows.filter((l) => Number(l.tdsAmount) > 0);
  const dep = rows.filter((l) => l.category === 'TDS deposit' && l.type === 'Debit');
  const groups = groupBy(ded, (l) => `${l.vendor || '—'}|${l.tdsSection || '—'}`).map(([k, v]) => ({ vendor: k.split('|')[0], section: k.split('|')[1], n: v.length, gross: sum(v, gross), tds: sum(v, (l) => l.tdsAmount), net: sum(v, (l) => l.amount) }));
  const totalTds = sum(groups, (g) => g.tds); const deposited = sum(dep, (l) => l.amount);
  return (
    <div data-testid="rep-tds">
      {picker}
      <MoneyTiles items={[{ label: 'TDS deducted', value: inr(totalTds) }, { label: 'Deposited to government', value: inr(deposited) }, { label: 'Still to deposit', value: inr(totalTds - deposited), tone: totalTds - deposited > 0 ? 'bad' : 'good' }]} />
      <div style={{ display: 'flex', gap: 8, margin: '6px 0' }}><button className="btn" data-testid="tds-deposit-open" onClick={() => setDlg(true)}>Record TDS deposit</button><Csv name={`tds-${fy}`} header={['Vendor', 'Section', 'Payments', 'Gross', 'TDS', 'Paid to vendor']} rows={groups.map((g) => [g.vendor, g.section, g.n, g.gross, g.tds, g.net])} /></div>
      <h3>TDS deducted · {fy}</h3>
      {groups.length === 0 ? <p className="muted">No TDS was deducted this year. Tick “Deduct TDS” when you make a payment to a contractor, professional or landlord.</p> : (
        <table className="table resp-table" data-testid="rep-tds-table">
          <thead><tr><th>Vendor</th><th>Section</th><th style={{ textAlign: 'right' }}>Payments</th><th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>TDS</th><th style={{ textAlign: 'right' }}>Paid to vendor</th></tr></thead>
          <tbody>{groups.map((g) => <tr key={g.vendor + g.section}><td data-label="Vendor">{g.vendor}</td><td data-label="Section">{g.section}</td><td data-label="Payments" style={{ textAlign: 'right' }}>{g.n}</td><td data-label="Gross" style={{ textAlign: 'right' }}>{inr(g.gross)}</td><td data-label="TDS" style={{ textAlign: 'right' }}>{inr(g.tds)}</td><td data-label="Paid to vendor" style={{ textAlign: 'right' }}>{inr(g.net)}</td></tr>)}</tbody>
        </table>
      )}
      {dep.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Deposits: {dep.map((d) => `${dmy(d.date)} ${inr(d.amount)}${d.ref ? ` (challan ${d.ref})` : ''}`).join(' · ')}</p>}
      <p className="muted" style={{ fontSize: 12 }}>Rates are the usual defaults ({TDS_SECTIONS.map((s) => `${s.code} ${s.rate}%`).join(', ')}); thresholds and lower-deduction certificates are not applied - confirm with your CA before filing.</p>
      {dlg && <TdsDeposit accounts={accounts} due={r2(totalTds - deposited)} onClose={() => setDlg(false)} />}
    </div>
  );
}
function TdsDeposit({ accounts, due, onClose }) {
  const [amount, setAmount] = useState(due > 0 ? due : '');
  const [account, setAccount] = useState(''); const [mode, setMode] = useState('Bank transfer'); const [ref, setRef] = useState(''); const [date, setDate] = useState(todayIso()); const [err, setErr] = useState('');
  async function go() {
    const r = await recordPayment({ area: 'Other', type: 'Debit', amount, account, date, mode, ref, vendor: 'Income Tax Department', description: 'TDS deposit', category: 'TDS deposit', sourceType: 'tdsDeposit', sourceId: `tds:${Date.now()}` });
    if (r.error) setErr(r.error); else onClose();
  }
  return (
    <Modal title="Record TDS deposit" subtitle="Tax deducted from vendors, paid to the government (challan)." onClose={onClose}>
      {err && <div className="notice error">{err}</div>}
      <div className="form-grid">
        <div className="field"><label>Amount (₹) *</label><input type="number" data-testid="tdsd-amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label>Bank account *</label><select data-testid="tdsd-account" value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Choose…</option>{accounts.map((a) => <option key={a.id}>{a.name}</option>)}</select></div>
        <div className="field"><label>Mode</label><select value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
        <div className="field"><label>Challan / UTR</label><input data-testid="tdsd-ref" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
        <div className="field"><label>Date</label><input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></div>
      </div>
      <div className="form-actions"><button className="btn" data-testid="tdsd-go" disabled={!(Number(amount) > 0) || !account} onClick={go}>Record deposit</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

/* ------------------------------------------------------------- cash book -- */
function CashBook({ ledger }) {
  const { records: counts, save } = useCollection(C.CASH_COUNTS, 'Cash counts');
  const cash = ledger.filter((l) => !l.internal && l.mode === 'Cash').sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.recordCreatedAt).localeCompare(String(b.recordCreatedAt)));
  let bal = 0;
  const lines = cash.map((l) => { bal = r2(bal + (l.type === 'Credit' ? 1 : -1) * (Number(l.amount) || 0)); return { l, bal }; });
  const [counted, setCounted] = useState(''); const [date, setDate] = useState(todayIso()); const [notes, setNotes] = useState(''); const [msg, setMsg] = useState('');
  const asOf = (d) => r2(cash.filter((l) => l.date <= d).reduce((n, l) => n + (l.type === 'Credit' ? 1 : -1) * (Number(l.amount) || 0), 0));
  const expected = asOf(date);
  async function record() {
    const diff = r2(Number(counted) - expected);
    const ok = await save({ date, counted: Number(counted), expected, difference: diff, notes });
    if (ok) { setMsg(diff === 0 ? 'Cash agrees with the book.' : `Recorded - cash is ${inr(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the book.`); setCounted(''); setNotes(''); }
  }
  return (
    <div data-testid="rep-cash">
      <MoneyTiles items={[{ label: 'Cash in hand (book)', value: inr(bal) }, { label: 'Cash entries', value: String(cash.length) }]} />
      <div className="notice" style={{ margin: '8px 0' }}>
        <b>Count the cash</b>
        <div className="form-grid" style={{ marginTop: 6 }}>
          <div className="field"><label>Counted on</label><input type="date" data-testid="cc-date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field"><label>Cash counted (₹)</label><input type="number" min="0" data-testid="cc-counted" value={counted} onChange={(e) => setCounted(e.target.value)} /></div>
          <div className="field"><label>Notes</label><input data-testid="cc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <p className="muted" data-testid="cc-diff" style={{ margin: '6px 0' }}>Book says {inr(expected)} on {dmy(date)}{counted !== '' ? ` · difference ${inr(Number(counted) - expected)}` : ''}.</p>
        <button className="btn" data-testid="cc-save" disabled={counted === ''} onClick={record}>Save cash count</button>
        {msg && <span className="muted" data-testid="cc-msg" style={{ marginLeft: 10 }}>{msg}</span>}
      </div>
      <div style={{ margin: '6px 0' }}><Csv name="cash-book" header={['Date', 'Description', 'Received', 'Paid', 'Balance']} rows={lines.map(({ l, bal: b }) => [l.date, l.description, l.type === 'Credit' ? l.amount : '', l.type === 'Debit' ? l.amount : '', b])} /></div>
      <h3>Cash book</h3>
      <table className="table resp-table" data-testid="rep-cash-table">
        <thead><tr><th>Date</th><th>Description</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
        <tbody>{lines.slice(-200).map(({ l, bal: b }) => <tr key={l.id}><td data-label="Date">{dmy(l.date)}</td><td data-label="Description">{l.description}</td><td data-label="Received" style={{ textAlign: 'right' }}>{l.type === 'Credit' ? inr(l.amount) : ''}</td><td data-label="Paid" style={{ textAlign: 'right' }}>{l.type === 'Debit' ? inr(l.amount) : ''}</td><td data-label="Balance" style={{ textAlign: 'right' }}>{inr(b)}</td></tr>)}</tbody>
      </table>
      {counts.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>Cash counts</h3>
          <table className="table resp-table" data-testid="rep-counts-table"><thead><tr><th>Date</th><th style={{ textAlign: 'right' }}>Counted</th><th style={{ textAlign: 'right' }}>Book</th><th style={{ textAlign: 'right' }}>Difference</th><th>Notes</th></tr></thead>
            <tbody>{[...counts].sort((a, b) => String(b.date).localeCompare(String(a.date))).map((c) => <tr key={c.id}><td data-label="Date">{dmy(c.date)}</td><td data-label="Counted" style={{ textAlign: 'right' }}>{inr(c.counted)}</td><td data-label="Book" style={{ textAlign: 'right' }}>{inr(c.expected)}</td><td data-label="Difference" style={{ textAlign: 'right', color: Number(c.difference) ? '#c7364a' : undefined }}>{inr(c.difference)}</td><td data-label="Notes">{c.notes}</td></tr>)}</tbody></table>
        </>
      )}
    </div>
  );
}

export default function Reports() {
  const { records: ledger } = useCollection(C.LEDGER, 'Payments Cross-check');
  const { records: accounts } = useCollection(C.BANK_ACCOUNTS, 'Bank Accounts');
  const [tab, setTab] = useState('ie');
  useEffect(() => { /* keep */ }, []);
  return (
    <div data-testid="reports">
      <SegTabs label="Reports" value={tab} onChange={setTab} tabs={[{ key: 'ie', label: 'Income & expenditure' }, { key: 'funds', label: 'Funds' }, { key: 'levies', label: 'Levies' }, { key: 'unit', label: 'Unit statement' }, { key: 'tds', label: 'TDS' }, { key: 'cash', label: 'Cash book' }]} />
      {tab === 'ie' && <IncomeExpenditure ledger={ledger} accounts={accounts} />}
      {tab === 'funds' && <Funds ledger={ledger} />}
      {tab === 'levies' && <Levies />}
      {tab === 'unit' && <UnitStatement />}
      {tab === 'tds' && <Tds ledger={ledger} accounts={accounts} />}
      {tab === 'cash' && <CashBook ledger={ledger} />}
    </div>
  );
}

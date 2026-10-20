import React, { useMemo, useRef, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { htmlToText } from '../../lib/richtext/sanitize.js';
import Modal from '../../components/Modal.jsx';
import RecordModal from './RecordModal.jsx';
import Statements from './BankStatements.jsx';
import { TableExportIcon } from '../../components/ExportIcon.jsx';
import { actualsByHead, sumHeads, balanceAsOf, fyOptions, fyRange, prevFy, currentFy, lastDateIn, monthEnd, monthLabel, INCOME_HEADS, EXPENSE_HEADS } from '../../lib/bank/analysis.js';
import { MONTH_NAMES, compactMoney, money } from '../../lib/locale.js';
import { DEPOSIT_TYPES } from '../../lib/lists/configLists.js';
import { computeHeadroom, accountTotal, depositsOf, DEFAULT_SETTINGS } from '../../lib/bank/headroom.js';

/** Amounts are stored in full; large ones are shown in the community's unit (lakh / crore, thousand / million, or full). */
const amt = (n) => compactMoney(Number(n || 0));
const rupees = (n) => money(n);
const dmy = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const monthsBetween = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / (30.4375 * 864e5));
const snippet = (html, n = 110) => { const t = htmlToText(html || ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Accounts & Budget: the Treasurer's workbook as live, editable screens - accounts and FDs, the budget for any financial year,
 * fixed monthly expenses (with the "Can we cover it?" check) and the bank statements (import from Excel).
 */
export default function BankBudget() {
  const { records: accounts } = useCollection(COLLECTIONS.BANK_ACCOUNTS, 'Bank Accounts');
  const { records: fixed } = useCollection(COLLECTIONS.FIXED_EXPENSES, 'Fixed Monthly Expenses');
  const { records: budget } = useCollection(COLLECTIONS.BUDGET_LINES, 'Budget');
  const { records: txns } = useCollection(COLLECTIONS.BANK_TXNS, 'Bank Statement');
  const { records: deposits } = useCollection(COLLECTIONS.DEPOSITS, 'Deposits & Investments');
  const { records: settings } = useCollection(COLLECTIONS.FINANCE_SETTINGS, 'Finance Estimates');
  const { tabAllowed } = useApp();
  const [viewState, setView] = useState('summary');
  const [fy, setFy] = useState(currentFy());
  const fys = useMemo(() => fyOptions(txns, budget), [txns, budget]);

  const tabList = [['summary', 'Accounts & deposits'], ['budget', `Budget ${fy}`], ['fixed', 'Fixed expenses'], ['statements', 'Bank statements']].filter(([k]) => tabAllowed(`bank.${k}`));
  const view = tabList.some(([k]) => k === viewState) ? viewState : tabList[0]?.[0];

  const FySelect = (
    <label className="fy-select">Financial year{' '}
      <select aria-label="Financial year" value={fy} onChange={(e) => setFy(e.target.value)}>
        {fys.map((x) => <option key={x} value={x}>{x} · {MONTH_NAMES[Number(fyRange(x).from.slice(5, 7)) - 1].slice(0, 3)} {fyRange(x).from.slice(0, 4)} – {MONTH_NAMES[Number(fyRange(x).to.slice(5, 7)) - 1].slice(0, 3)} {fyRange(x).to.slice(0, 4)}</option>)}
      </select>
    </label>
  );

  return (
    <div>
      <div className="tabs" style={{ margin: '0 0 12px' }}>
        {tabList.map(([k, label]) => (
          <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      {view === 'summary' && <Summary accounts={accounts} txns={txns} deposits={deposits} />}
      {view === 'budget' && <Budget fy={fy} fySelect={FySelect} budget={budget} txns={txns} />}
      {view === 'fixed' && <Fixed fy={fy} fySelect={FySelect} fixed={fixed} txns={txns} accounts={accounts} settings={settings[0]} deposits={deposits} />}
      {view === 'statements' && <Statements accounts={accounts} txns={txns} />}
    </div>
  );
}

// ---------------------------------------------------------------- Accounts & FDs
function Summary({ accounts, txns, deposits }) {
  const [asOfMonth, setAsOfMonth] = useState(''); // '' = latest; 'yyyy-mm' = that month-end
  const [editing, setEditing] = useState(null);
  const [editingDep, setEditingDep] = useState(null);
  const tref = useRef(null);
  const dref = useRef(null);
  const canWrite = canWriteCollection(COLLECTIONS.BANK_ACCOUNTS, getPrincipal());
  const canWriteDep = canWriteCollection(COLLECTIONS.DEPOSITS, getPrincipal());

  // months we can look back at: every month with a statement line, before the current one
  const thisMonth = new Date().toISOString().slice(0, 7);
  const months = useMemo(() => [...new Set([...txns.map((t) => t.date.slice(0, 7)), ...accounts.flatMap((a) => (a.history || []).map((h) => h.asOf.slice(0, 7)))])].filter((m) => m < thisMonth).sort().reverse(), [txns, accounts, thisMonth]);
  const end = asOfMonth ? monthEnd(asOfMonth) : null;

  const rows = accounts.map((a) => {
    const dep = depositsOf(deposits, a.name, end || undefined);
    if (!end) return { a, balance: a.balance, deposits: dep, asOf: a.asOf, from: 'summary' };
    // saved summaries (the current one plus earlier ones kept when it was updated), newest not after month-end
    const snaps = [...(a.history || []), { asOf: a.asOf, balance: a.balance }].filter((h) => h.asOf <= end).sort((x, y) => (x.asOf < y.asOf ? -1 : 1));
    const snap = snaps[snaps.length - 1];
    if (snap && snap.asOf.slice(0, 7) === asOfMonth) return { a, balance: snap.balance, deposits: dep, asOf: snap.asOf, from: 'summary' };
    const st = balanceAsOf(txns, a.name, end);
    if (st) return { a, balance: st.balance, deposits: dep, asOf: st.date, from: 'statement' };
    return snap ? { a, balance: snap.balance, deposits: dep, asOf: snap.asOf, from: 'summary' } : { a, balance: null, deposits: dep, asOf: '', from: 'none' };
  });
  const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const tot = (r) => Number(r.balance || 0) + Number(r.deposits || 0);

  // keep the previous figures as history when the summary moves to a new date
  const stampHistory = (draft, old) => {
    if (old && old.asOf && draft.asOf !== old.asOf) {
      const hist = Array.isArray(old.history) ? old.history : [];
      draft.history = [...hist.filter((h) => h.asOf !== old.asOf), { asOf: old.asOf, balance: old.balance }];
    }
    return draft;
  };
  // active deposits of one account split by type (sweep-in, fixed, ...), as of month-end when a past month is chosen
  const byType = (name, asOf) => Object.entries(deposits.filter((d) => d.account === name && (d.status || 'Active') === 'Active' && (!asOf || !d.startDate || d.startDate <= asOf)).reduce((m, d) => { m[d.type] = (m[d.type] || 0) + (Number(d.amount) || 0); return m; }, {}));
  const typeTotals = Object.entries(deposits.filter((d) => (d.status || 'Active') === 'Active' && (!end || !d.startDate || d.startDate <= end)).reduce((m, d) => { m[d.type] = (m[d.type] || 0) + (Number(d.amount) || 0); return m; }, {})).sort((a, b) => b[1] - a[1]);
  const interest = deposits.filter((d) => (d.status || 'Active') === 'Active').reduce((t, d) => t + (Number(d.interestEarned) || 0), 0);
  const tds = deposits.filter((d) => (d.status || 'Active') === 'Active').reduce((t, d) => t + (Number(d.taxDeducted) || 0), 0);
  const depRows = deposits.filter((d) => (!end || !d.startDate || d.startDate <= end)).sort((x, y) => String(x.maturityDate || '9').localeCompare(String(y.maturityDate || '9')));
  const today = new Date().toISOString().slice(0, 10);
  const soon = (d) => d.status !== 'Matured' && d.status !== 'Closed' && d.maturityDate && d.maturityDate >= today && d.maturityDate <= new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);

  return (
    <>
    <div className="card">
      <div className="screen-head">
        <h2 style={{ margin: 0 }}>Bank accounts &amp; deposits</h2>
        <div className="screen-tools">
          <label className="fy-select">Show{' '}
            <select aria-label="Show balances as of" value={asOfMonth} onChange={(e) => setAsOfMonth(e.target.value)}>
              <option value="">Latest</option>
              {months.map((m, i) => <option key={m} value={m}>{i === 0 ? 'Previous month-end · ' : 'Month-end · '}{monthLabel(m)}</option>)}
            </select>
          </label>
          <TableExportIcon scope={tref} name="Accounts and deposits" />
          {canWrite && <button type="button" className="btn" onClick={() => setEditing({ asOf: new Date().toISOString().slice(0, 10), balance: 0 })}>+ Add account</button>}
        </div>
      </div>
      <div className="table-wrap" ref={tref}><table className="resp-table">
        <thead><tr><th>Account</th><th>A/C</th><th>Balance</th><th>Deposits &amp; investments</th><th>Total</th><th>As of</th><th className="noexport" /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.a.id}>
              <td data-label="Account"><b>{r.a.name}</b></td>
              <td data-label="A/C" className="mono">{r.a.last4 ? `…${r.a.last4}` : '—'}</td>
              <td data-label="Balance">{r.balance === null ? '—' : amt(r.balance)}</td>
              <td data-label="Deposits">{amt(r.deposits)}{byType(r.a.name, end).map(([t, v]) => <div key={t}><small className="muted">{t} {amt(v)}</small></div>)}</td>
              <td data-label="Total"><b>{r.balance === null ? '—' : amt(tot(r))}</b></td>
              <td data-label="As of">{dmy(r.asOf)}</td>
              <td className="noexport">{canWrite && !end && <button type="button" className="btn secondary" aria-label={`Edit ${r.a.name}`} onClick={() => setEditing(r.a)}>Edit</button>}</td>
            </tr>
          ))}
          <tr><td><b>Total</b></td><td /><td><b>{amt(sum('balance'))}</b></td><td><b>{amt(sum('deposits'))}</b></td><td><b>{amt(rows.reduce((s, r) => s + tot(r), 0))}</b></td><td /><td /></tr>
        </tbody>
      </table></div>
      <small className="muted">
        {end
          ? `Month-end view for ${monthLabel(asOfMonth)}. Balances come from the bank’s own closing balance in the statements; deposits shown are those that had started by then and are still running.`
          : 'Update an account’s balance whenever you refresh the summary — the earlier figures are kept so you can look back by month. Deposits and investments are listed below; the account total adds them up.'}
      </small>
      {editing && <RecordModal collection={COLLECTIONS.BANK_ACCOUNTS} label="Bank Account" record={editing} beforeSave={stampHistory} onClose={() => setEditing(null)} />}
    </div>
    <div className="card" style={{ marginTop: 16 }} data-testid="deposits-card">
      <div className="screen-head">
        <h2 style={{ margin: 0 }}>Deposits &amp; investments</h2>
        <div className="screen-tools">
          <TableExportIcon scope={dref} name="Deposits and investments" />
          {canWriteDep && <button type="button" className="btn" data-testid="dep-add" onClick={() => setEditingDep({ status: 'Active', type: DEPOSIT_TYPES[0], startDate: today })}>+ Add deposit</button>}
        </div>
      </div>
      {typeTotals.length > 0 && (
        <div className="grid metrics summary-cards" style={{ margin: '8px 0' }} data-testid="dep-types">
          {typeTotals.map(([t, v]) => <div key={t} className="card metric"><div className="label">{t}</div><div className="value">{amt(v)}</div></div>)}
          {interest > 0 && <div className="card metric"><div className="label">Interest earned</div><div className="value">{amt(interest)}</div>{tds > 0 && <div className="muted">tax deducted {amt(tds)}</div>}</div>}
        </div>
      )}
      <div className="table-wrap" ref={dref}><table className="resp-table">
        <thead><tr><th>Account</th><th>Type</th><th>Amount</th><th>Rate</th><th>Started</th><th>Matures</th><th>Interest paid</th><th>Interest / tax deducted</th><th>Status</th><th className="noexport" /></tr></thead>
        <tbody>
          {depRows.map((d) => (
            <tr key={d.id}>
              <td data-label="Account"><b>{d.account}</b></td>
              <td data-label="Type">{d.type}{d.reference ? <><br /><small className="muted">{d.reference}</small></> : null}</td>
              <td data-label="Amount">{amt(d.amount)}</td>
              <td data-label="Rate">{d.rate ? `${d.rate}%` : '—'}</td>
              <td data-label="Started">{dmy(d.startDate)}</td>
              <td data-label="Matures">{dmy(d.maturityDate)} {soon(d) && <span className="tag orange">within 60 days</span>}</td>
              <td data-label="Interest paid">{d.interestPayout || '—'}{d.autoRenew && <><br /><small className="muted">auto-renews</small></>}{d.type && /sweep/i.test(d.type) && Number(d.sweepLimit) > 0 && <><br /><small className="muted">sweeps above {amt(d.sweepLimit)}</small></>}</td>
              <td data-label="Interest / TDS">{Number(d.interestEarned) > 0 ? amt(d.interestEarned) : '—'}{Number(d.taxDeducted) > 0 && <><br /><small className="muted">TDS {amt(d.taxDeducted)}</small></>}</td>
              <td data-label="Status">{d.status || 'Active'}</td>
              <td className="noexport">{canWriteDep && !end && <button type="button" className="btn secondary" aria-label={`Edit deposit ${d.account} ${d.type}`} onClick={() => setEditingDep(d)}>Edit</button>}</td>
            </tr>
          ))}
          {!depRows.length && <tr><td colSpan={10} className="muted">No deposits or investments recorded.</td></tr>}
        </tbody>
      </table></div>
      <small className="muted">Only deposits with status Active are added to the account totals and to “Can we cover it?”. Mark one Matured or Closed when it is redeemed.</small>
      {editingDep && <RecordModal collection={COLLECTIONS.DEPOSITS} label="Deposit" record={editingDep} allowDelete onClose={() => setEditingDep(null)} />}
    </div>
    </>
  );
}

// ---------------------------------------------------------------- Budget
function Budget({ fy, fySelect, budget, txns }) {
  const { save } = useCollection(COLLECTIONS.BUDGET_LINES, 'Budget');
  const [editing, setEditing] = useState(null);
  const canWrite = canWriteCollection(COLLECTIONS.BUDGET_LINES, getPrincipal());
  const lines = budget.filter((b) => b.fy === fy);
  const pfy = prevFy(fy);
  const actuals = useMemo(() => actualsByHead(txns, fy), [txns, fy]);
  const prevActuals = useMemo(() => actualsByHead(txns, pfy), [txns, pfy]);
  const hasPrev = Object.keys(prevActuals).length > 0;
  const last = lastDateIn(txns, fy);
  const prevLines = budget.filter((b) => b.fy === pfy);
  const sourceFy = [...new Set(budget.map((b) => b.fy))].filter((x) => x !== fy).sort().pop();

  const stmt = (b) => (b.heads ? sumHeads(actuals, b.heads) : 0);
  const plan = (b) => (Number(b.revised) > 0 ? Number(b.revised) : Number(b.forecast) || 0); // a revised budget replaces the original
  const total = (b) => stmt(b) + Number(b.other || 0);
  const prior = (b) => {
    const pl = prevLines.find((x) => x.kind === b.kind && x.name.trim().toLowerCase() === b.name.trim().toLowerCase());
    const heads = b.heads || pl?.heads;
    if (!heads && !pl) return null;
    return (heads ? sumHeads(prevActuals, heads) : 0) + Number(pl?.other || 0);
  };
  const sumKind = (kind, f) => lines.filter((b) => b.kind === kind).reduce((s, b) => s + (Number(f(b)) || 0), 0);
  const counted = new Set(lines.flatMap((b) => String(b.heads || '').split(',').map((s) => s.trim()).filter(Boolean)));
  const unlinked = Object.entries(actuals).filter(([h, v]) => !counted.has(h) && Math.abs(v) > 1000 && h !== 'Other income' && h !== 'Other expense');

  async function copyLines() {
    const src = budget.filter((b) => b.fy === sourceFy);
    for (const b of src) {
      const { id, shortId, recVersion, recordCreatedAt, recordCreatedBy, lastUpdatedAt, lastUpdatedBy, ...rest } = b; // eslint-disable-line no-unused-vars
      await save({ ...rest, fy, other: 0 });
    }
  }

  const Table = ({ kind }) => {
    const rows = lines.filter((b) => b.kind === kind);
    const inc = kind === 'Income';
    const tref = useRef(null); // eslint-disable-line react-hooks/rules-of-hooks
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="screen-head">
          <h2 style={{ margin: 0 }}>{inc ? 'Income' : 'Expenses'}</h2>
          <div className="screen-tools"><TableExportIcon scope={tref} name={`${inc ? 'Income' : 'Expenses'} ${fy}`} />
            {canWrite && <button type="button" className="btn" onClick={() => setEditing({ fy, kind, other: 0 })}>{inc ? '+ Add income' : '+ Add expense'}</button>}</div>
        </div>
        <div className="table-wrap" ref={tref}><table className="resp-table">
          <thead><tr><th>Line</th><th>Budget</th><th>{inc ? 'Received (statements)' : 'Spent (statements)'}</th><th>{inc ? 'Received (others)' : 'Spent (others)'}</th><th>{inc ? 'Still to come' : 'To be paid'}</th>{hasPrev && <th>{pfy} actual</th>}<th className="noexport" /></tr></thead>
          <tbody>
            {rows.map((b) => {
              const p = prior(b);
              return (
                <tr key={b.id}>
                  <td data-label="Line"><b>{b.name}</b>{b.notes && <><br /><small className="muted">{snippet(b.notes)}</small></>}{!b.heads && <><br /><small className="muted">not linked to statements</small></>}</td>
                  <td data-label="Budget">{amt(plan(b))}{Number(b.revised) > 0 && <><br /><small className="muted">revised from {amt(b.forecast)}</small></>}</td>
                  <td data-label="Statements">{b.heads ? amt(stmt(b)) : <span className="muted">—</span>}</td>
                  <td data-label="Others">{amt(b.other)}</td>
                  <td data-label="Left">{amt(Math.max(0, plan(b) - total(b)))}{total(b) > plan(b) && plan(b) > 0 && <> <span className="tag orange">over by {amt(total(b) - plan(b))}</span></>}</td>
                  {hasPrev && <td data-label={`${pfy} actual`}>{p === null ? <span className="muted">—</span> : amt(p)}</td>}
                  <td className="noexport">{canWrite && <button type="button" className="btn secondary" aria-label={`Edit ${b.name}`} onClick={() => setEditing(b)}>Edit</button>}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7} className="muted">No {inc ? 'income' : 'expense'} lines for {fy} yet.</td></tr>}
            <tr><td><b>Total</b></td><td><b>{amt(sumKind(kind, plan))}</b></td><td><b>{amt(sumKind(kind, stmt))}</b></td><td><b>{amt(sumKind(kind, (b) => b.other))}</b></td><td /><>{hasPrev && <td><b>{amt(rows.reduce((s, b) => s + (prior(b) || 0), 0))}</b></td>}</><td /></tr>
          </tbody>
        </table></div>
      </div>
    );
  };

  const incomeSoFar = sumKind('Income', total);
  const expenseSoFar = sumKind('Expense', total);
  return (
    <>
      <div className="screen-head" style={{ marginBottom: 8 }}>{fySelect}
        {canWrite && !lines.length && sourceFy && <button type="button" className="btn secondary" onClick={copyLines}>Copy the {sourceFy} lines into {fy}</button>}
      </div>
      <div className="grid metrics summary-cards">
        <div className="card metric"><div className="label">Income forecast</div><div className="value">{amt(sumKind('Income', plan), 1)}</div></div>
        <div className="card metric"><div className="label">Expense forecast</div><div className="value">{amt(sumKind('Expense', plan), 1)}</div></div>
        <div className="card metric"><div className="label">Planned surplus</div><div className="value">{amt(sumKind('Income', plan) - sumKind('Expense', plan), 1)}</div></div>
        <div className="card metric"><div className="label">Surplus so far</div><div className="value">{amt(incomeSoFar - expenseSoFar, 1)}</div></div>
      </div>
      <Table kind="Income" />
      <Table kind="Expense" />
      {!lines.length && Object.keys(actuals).length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Statement actuals for {fy} <small className="muted">· by head</small></h2>
          <p className="muted" style={{ marginTop: -6 }}>No budget was entered for {fy}; this is what the bank statements show. Add lines above (or copy them from another year) to compare with a forecast.</p>
          <div className="table-wrap"><table className="resp-table"><thead><tr><th>Head</th><th>Income</th><th>Expense</th></tr></thead><tbody>
            {Object.entries(actuals).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([h, v]) => (
              <tr key={h}><td data-label="Head">{h}</td><td data-label="Income">{INCOME_HEADS.includes(h) ? amt(v) : ''}</td><td data-label="Expense">{EXPENSE_HEADS.includes(h) ? amt(v) : ''}</td></tr>
            ))}
          </tbody></table></div>
        </div>
      )}
      <small className="muted" style={{ display: 'block', marginTop: 8 }}>
        {fy} runs {dmy(fyRange(fy).from)} – {dmy(fyRange(fy).to)}; statements cover it up to {dmy(last)} (maintenance paid in advance for the year is included). Only the line name, forecast, “others” amount and notes are edited here — everything else comes from the statements.
        {unlinked.length > 0 && <> Statement heads not linked to any line: {unlinked.map(([h, v]) => `${h} ${amt(v)}`).join(', ')}.</>}
        {' '}Other income {rupees(actuals['Other income'] || 0)}, other expense {rupees(actuals['Other expense'] || 0)} still need a head — see Bank statements.
      </small>
      {editing && (
        <RecordModal
          collection={COLLECTIONS.BUDGET_LINES}
          label={editing.kind === 'Income' ? 'Income line' : 'Expense line'}
          title={editing.id ? `Edit ${editing.name}` : editing.kind === 'Income' ? `New income line · ${fy}` : `New expense line · ${fy}`}
          subtitle={editing.id ? 'Line, forecast, the “others” amount and notes can be changed.' : 'Choose the statement heads whose payments should count against this line (comma separated, e.g. “Security”), or leave blank and use the “others” amount.'}
          record={editing}
          editable={['name', 'forecast', 'revised', 'other', 'notes']}
          hide={['fy', 'kind']}
          allowDelete
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Fixed expenses + "Can we cover it?"
function Fixed({ fy, fySelect, fixed, txns, accounts, settings, deposits }) {
  const [editing, setEditing] = useState(null);
  const [adjust, setAdjust] = useState(false);
  const tref = useRef(null);
  const canWrite = canWriteCollection(COLLECTIONS.FIXED_EXPENSES, getPrincipal());
  const isCurrent = fy === currentFy();
  const actuals = useMemo(() => actualsByHead(txns, fy), [txns, fy]);
  const last = lastDateIn(txns, fy);
  const monthsElapsed = Math.max(1, Math.min(12, monthsBetween(fyRange(fy).from, last || fyRange(fy).from) + 0.03));
  const h = computeHeadroom(accounts, fixed, settings, deposits);
  const totalAvg = fixed.reduce((s, f) => s + Number(f.avg), 0);

  return (
    <>
      <div className="screen-head" style={{ marginBottom: 8 }}>{fySelect}</div>
      {isCurrent && (
        <div className="card" data-testid="cover-strip" style={{ marginBottom: 16 }}>
          <div className="screen-head">
            <h2 style={{ margin: 0 }}>Can we cover it?</h2>
            <button type="button" className="btn secondary" onClick={() => setAdjust(true)}>Adjust estimates</button>
          </div>
          <div className="grid metrics summary-cards" style={{ marginTop: 8 }}>
            <Tip label="Cash + deposits available" value={amt(h.available, 1)} sub={`${amt(h.onHand, 1)} on hand + ${amt(h.income, 1)} expected − ${amt(h.s.emergency, 1)} reserve`}
              title="How “available” is worked out" rows={[
                ...h.counted.map((n) => { const a = accounts.find((x) => x.name === n); return [`${n} (balance + deposits)`, amt(a ? accountTotal(a, deposits) : 0)]; }),
                ['Clubhouse income to come', amt(h.s.clubhouse)], ['Interest to come', amt(h.s.interest)], ['Water billing to come', amt(h.s.water)], ['DG billing to come', amt(h.s.dg)],
                ['Less emergency reserve', `− ${amt(h.s.emergency)}`],
              ]} total={['Available', amt(h.available)]} />
            <Tip label="Still to pay" value={amt(h.outstanding + h.others, 1)} sub={`${amt(h.outstanding, 1)} fixed + ${amt(h.others, 1)} other items`}
              title="How “still to pay” is worked out" rows={[
                ...fixed.map((f) => [`${f.name.length > 34 ? `${f.name.slice(0, 33)}…` : f.name} (${amt(f.avg)} × ${f.months})`, amt(Number(f.avg) * Number(f.months))]),
                ['Other items still to pay', amt(h.others)],
              ]} total={['Still to pay', amt(h.outstanding + h.others)]} />
            <Tip label="Headroom" value={amt(h.headroom, 1)} valueTestId="headroom-value" neg={h.headroom < 0} sub={h.headroom >= 0 ? 'We can cover the year' : 'Shortfall — plan more income'}
              title="How headroom is worked out" rows={[['Cash + deposits available', amt(h.available)], ['Less fixed expenses still to pay', `− ${amt(h.outstanding)}`], ['Less other items still to pay', `− ${amt(h.others)}`]]} total={['Headroom', amt(h.headroom)]} />
            <Tip label="Months of cover" value={h.monthsCover.toFixed(1)} sub={`at ${amt(h.monthly, 1)} fixed a month`}
              title="How months of cover is worked out" rows={[['Cash + deposits available', amt(h.available)], ['Fixed expenses a month', amt(h.monthly)]]} total={['Available ÷ monthly', `${h.monthsCover.toFixed(1)} months`]} />
          </div>
        </div>
      )}
      <div className="card">
        <div className="screen-head">
          <h2 style={{ margin: 0 }}>Fixed monthly expenses</h2>
          <div className="screen-tools"><TableExportIcon scope={tref} name="Fixed expenses" />
            {canWrite && isCurrent && <button type="button" className="btn" onClick={() => setEditing({ months: 0, avg: 0 })}>+ Add expense</button>}</div>
        </div>
        <div className="table-wrap" ref={tref}><table className="resp-table">
          <thead><tr><th>Expense</th><th>Vendor / department</th><th>Forecast avg / month</th>{isCurrent && <><th>Months to pay</th><th>Outstanding</th></>}<th>Paid in {fy} (statements)</th><th>Actual avg / month</th>{isCurrent && <th className="noexport" />}</tr></thead>
          <tbody>
            {fixed.map((f) => {
              const paid = f.heads ? sumHeads(actuals, f.heads) : null;
              const avg = paid === null ? null : paid / monthsElapsed;
              return (
                <tr key={f.id}>
                  <td data-label="Expense"><b>{f.name}</b></td>
                  <td data-label="Vendor">{f.vendor || <span className="muted">—</span>}</td>
                  <td data-label="Forecast avg">{amt(f.avg)}</td>
                  {isCurrent && <><td data-label="Months">{f.months}</td><td data-label="Outstanding">{amt(Number(f.avg) * Number(f.months))}</td></>}
                  <td data-label="Paid">{paid === null ? <span className="muted">not tracked</span> : amt(paid)}</td>
                  <td data-label="Actual avg">{avg === null ? '—' : <>{amt(avg)} {avg > Number(f.avg) * 1.15 && <span className="tag red">above forecast</span>}</>}</td>
                  {isCurrent && <td className="noexport">{canWrite && <button type="button" className="btn secondary" aria-label={`Edit ${f.name}`} onClick={() => setEditing(f)}>Edit</button>}</td>}
                </tr>
              );
            })}
            <tr><td><b>Monthly fixed</b></td><td /><td><b>{amt(totalAvg)}</b></td>{isCurrent && <><td /><td><b>{amt(h.outstanding)}</b></td></>}<td /><td />{isCurrent && <td className="noexport" />}</tr>
          </tbody>
        </table></div>
        <small className="muted">“Actual avg” divides statement payments by the {monthsElapsed.toFixed(1)} months of {fy} covered so far. The forecast and the months still to pay feed the headroom above; today’s list applies to the current year only.</small>
      </div>
      {editing && <RecordModal collection={COLLECTIONS.FIXED_EXPENSES} label="Fixed Expense" record={editing} subtitle="Link a vendor or a government department if the payment goes to one." allowDelete onClose={() => setEditing(null)} />}
      {adjust && <EstimatesModal accounts={accounts} settings={settings} deposits={deposits} onClose={() => setAdjust(false)} />}
    </>
  );
}

/** A metric card that explains, on hover or keyboard focus, how its number is built up. */
function Tip({ label, value, sub, title, rows, total, neg, valueTestId }) {
  return (
    <div className="card metric tip-host" tabIndex={0} aria-label={`${label}: ${value}. Hover for how it is worked out.`}>
      <div className="label">{label} <span aria-hidden="true" title="">ⓘ</span></div>
      <div className={`value${neg ? ' neg' : ''}`} data-testid={valueTestId}>{value}</div>
      <div className="muted">{sub}</div>
      <div className="tip-card" role="tooltip">
        <div className="tip-title">{title}</div>
        {rows.map(([k, v], i) => <div className="tip-row" key={i}><span>{k}</span><span>{v}</span></div>)}
        <div className="tip-row sum"><span>{total[0]}</span><span>{total[1]}</span></div>
      </div>
    </div>
  );
}

function EstimatesModal({ accounts, settings, deposits, onClose }) {
  const { save } = useCollection(COLLECTIONS.FINANCE_SETTINGS, 'Finance Estimates');
  const canWrite = canWriteCollection(COLLECTIONS.FINANCE_SETTINGS, getPrincipal());
  const [s, setS] = useState({ ...DEFAULT_SETTINGS, ...(settings || {}) });
  const on = String(s.onHand || '').split(',').map((x) => x.trim()).filter(Boolean);
  const toggle = (n) => setS((x) => ({ ...x, onHand: (on.includes(n) ? on.filter((y) => y !== n) : [...on, n]).join(',') }));
  const num = (k, label) => (
    <div className="field"><label>{label}</label>
      <input type="number" step="1" aria-label={label} disabled={!canWrite} value={s[k]} onChange={(e) => setS((x) => ({ ...x, [k]: e.target.value === '' ? '' : Number(e.target.value) }))} /></div>
  );
  return (
    <Modal title="Adjust estimates" subtitle="What counts as money on hand, and the income and reserve we expect for the rest of the year The Billing dashboard uses the same figures." onClose={onClose}>
      <div className="field"><label>Accounts counted as on hand</label>
        <div className="chip-row">
          {accounts.map((a) => (
            <label key={a.id} className={`chip-btn${on.includes(a.name) ? ' on' : ''}`}>
              <input type="checkbox" style={{ display: 'none' }} disabled={!canWrite} checked={on.includes(a.name)} onChange={() => toggle(a.name)} />
              {a.name} <small>· {amt(accountTotal(a, deposits), 1)}</small>
            </label>
          ))}
        </div>
      </div>
      <div className="form-grid">
        {num('clubhouse', 'Clubhouse income still to come')}
        {num('interest', 'Interest still to come')}
        {num('water', 'Water billing still to come')}
        {num('dg', 'DG billing still to come')}
        {num('emergency', 'Emergency reserve held back')}
        {num('others', 'Other items still to pay')}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {canWrite && <button type="button" className="btn" onClick={async () => { const r = await save({ ...(settings || {}), ...s }); if (r) onClose(); }}>Save estimates</button>}
        <button type="button" className="btn secondary" onClick={onClose}>{canWrite ? 'Cancel' : 'Close'}</button>
      </div>
    </Modal>
  );
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { invoiceApproval, approvalState } from '../tickets/ticketEngine.js';
import { actualsByHead, sumHeads, fyRange, fyOptions, currentFy, fyOfDate, kindOfHead, EXPENSE_HEADS } from '../../lib/bank/analysis.js';
import { computeHeadroom, depositsOf } from '../../lib/bank/headroom.js';

/* ---------------------------------------------------------------- helpers -- */
const inrFull = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
function inr(n) {
  const v = Number(n) || 0; const a = Math.abs(v); const sign = v < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)} L`;
  if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(1)}K`;
  return `${sign}₹${Math.round(a)}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ym = (iso) => String(iso || '').slice(0, 7);
function monthsEndingAt(anchorYm, n) {
  let [y, m] = anchorYm.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return out;
}
const monthName = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`;
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)); const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/* ------------------------------------------------------------ small parts -- */
/** One floating readout per chart: value leads, label follows; labels go in as text nodes (never HTML). */
function useTip() {
  const box = useRef(null);
  const [tip, setTip] = useState(null);
  const show = (e, title, rows) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setTip({ x: Math.min(Math.max(e.clientX - r.left, 80), r.width - 80), y: e.clientY - r.top, title, rows });
  };
  const hide = () => setTip(null);
  const node = tip && (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <div className="viz-tip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.name} className="viz-tip-row">
          <i style={{ background: r.color }} /><b>{r.value}</b><span>{r.name}</span>
        </div>
      ))}
    </div>
  );
  return { box, show, hide, node };
}

function Legend({ items }) {
  return (
    <div className="viz-legend">
      {items.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
    </div>
  );
}

/** Card with a chart / table switch so every number is reachable without hovering. */
function ChartCard({ title, sub, legend, table, children, wide, span }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`viz-card${wide ? ' wide' : ''}${span ? ` span-${span}` : ''}`}>
      <header>
        <div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
        <button type="button" className="link-btn" onClick={() => setAsTable((v) => !v)}>{asTable ? 'Show chart' : 'Show table'}</button>
      </header>
      {legend}
      {asTable ? (
        <div className="viz-table-wrap">
          <table className="viz-table">
            <thead><tr>{table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : children}
    </section>
  );
}

function Tile({ label, value, sub, hero }) {
  return (
    <div className={`viz-tile${hero ? ' hero' : ''}`}>
      <span className="viz-tile-label">{label}</span>
      <b className="viz-tile-value">{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

/** Grouped columns: <=24px each, 4px rounded tops, 2px gap, hairline grid, one axis. */
function Columns({ labels, series, valueFmt = inr }) {
  const { box, show, hide, node } = useTip();
  const [roomy, setRoomy] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1000px)').matches);
  useEffect(() => { const m = window.matchMedia?.('(min-width: 1000px)'); if (!m) return undefined; const f = () => setRoomy(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  const W = roomy ? 700 : 560; const H = roomy ? 190 : 220; const L = 46; const B = 28; const T = 10; const R = 8;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const slot = (W - L - R) / labels.length;
  const bw = Math.min(24, (slot - 12) / series.length - 2);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const bar = (x, v) => {
    const h = Math.max(0, (H - B) - y(v)); if (h <= 0) return null;
    const r = Math.min(4, h, bw / 2);
    return `M${x},${H - B} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + bw - r} Q${x + bw},${y(v)} ${x + bw},${y(v) + r} V${H - B} Z`;
  };
  return (
    <div className="viz-plot" ref={box} onPointerLeave={hide}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.name).join(' and ') + ' by month'}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" className="viz-tick">{inr(t)}</text>
          </g>
        ))}
        {labels.map((lab, i) => {
          const gx = L + slot * i + (slot - (bw * series.length + 2 * (series.length - 1))) / 2;
          return (
            <g key={lab}>
              {series.map((s, k) => <path key={s.name} d={bar(gx + k * (bw + 2), s.values[i])} fill={s.color} />)}
              <text x={L + slot * i + slot / 2} y={H - 9} textAnchor="middle" className="viz-tick">{lab}</text>
              <rect x={L + slot * i} y={T} width={slot} height={H - T - B} fill="transparent" tabIndex={0}
                onPointerMove={(e) => show(e, lab, series.map((s) => ({ name: s.name, color: s.color, value: inrFull(s.values[i]) })))}
                onFocus={(e) => { const r = e.target.getBoundingClientRect(); show({ clientX: r.left + r.width / 2, clientY: r.top }, lab, series.map((s) => ({ name: s.name, color: s.color, value: inrFull(s.values[i]) }))); }}
                onBlur={hide} />
            </g>
          );
        })}
      </svg>
      {node}
    </div>
  );
}

/** Horizontal bars: label · bar · value at the tip. Bars <=16px, rounded at the data end only. */
function HBars({ rows, color, track, valueFmt = inr, empty = 'Nothing to show yet.' }) {
  const { box, show, hide, node } = useTip();
  const max = Math.max(1, ...rows.map((r) => Math.max(r.value, r.track || 0)));
  const [all, setAll] = useState(false);
  const phone = typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 700px)').matches;
  const LIMIT = 5; // on a phone only the biggest few rows show first, the rest are one tap away
  const shownRows = phone && !all ? rows.slice(0, LIMIT) : rows;
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className="viz-hbars" ref={box} onPointerLeave={hide}>
      {shownRows.map((r) => (
        <div key={r.label} className="viz-hrow" tabIndex={0}
          onPointerMove={(e) => show(e, r.label, [{ name: r.valueName || 'Amount', color, value: inrFull(r.value) }, ...(r.extra || [])])}
          onBlur={hide}>
          <span className="viz-hlabel" title={r.label}>{r.label}</span>
          <span className="viz-htrack">
            {r.track ? <i className="viz-htrackbar" style={{ width: `${(r.track / max) * 100}%`, background: track || color }} /> : null}
            <i className="viz-hbar" style={{ width: `${Math.max(1, (r.value / max) * 100)}%`, background: color }} />
          </span>
          <span className="viz-hvalue">{valueFmt(r.value)}</span>
        </div>
      ))}
      {phone && rows.length > LIMIT && <button type="button" className="link-btn" data-testid="viz-more" style={{ justifySelf: 'start' }} onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
      {node}
    </div>
  );
}

/* ----------------------------------------------------------------- screen -- */
/** yyyy-mm keys from the start of a financial year up to (and including) the month of `lastYm`. */
function fyMonths(fy, lastYm) {
  const { from } = fyRange(fy);
  let y = Number(from.slice(0, 4)); let m = Number(from.slice(5, 7)); const out = [];
  for (let i = 0; i < 12; i++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    out.push(k); if (k >= lastYm) break;
    m += 1; if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

export default function TreasurerDashboard() {
  const { records: ledger } = useCollection(COLLECTIONS.LEDGER, 'Payments Cross-check');
  const { records: banks } = useCollection(COLLECTIONS.BANK_ACCOUNTS, 'Bank Accounts');
  const { records: txns } = useCollection(COLLECTIONS.BANK_TXNS, 'Bank Statement');
  const { records: budget } = useCollection(COLLECTIONS.BUDGET_LINES, 'Budget');
  const { records: deposits } = useCollection(COLLECTIONS.DEPOSITS, 'Deposits & Investments');
  const { records: fixed } = useCollection(COLLECTIONS.FIXED_EXPENSES, 'Fixed Monthly Expenses');
  const { records: settings } = useCollection(COLLECTIONS.FINANCE_SETTINGS, 'Finance Estimates');
  const { records: dues } = useCollection(COLLECTIONS.DUES, 'Billing & Finance');
  const { records: docs } = useCollection(COLLECTIONS.QUOTATIONS, 'Quotations');
  const { records: tickets } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const [fy, setFy] = useState(currentFy());
  const fys = useMemo(() => fyOptions(txns, budget), [txns, budget]);

  const plan = (b) => (Number(b.revised) > 0 ? Number(b.revised) : Number(b.forecast) || 0); // revised budget replaces the original
  const d = useMemo(() => {
    const { from, to } = fyRange(fy);
    const fyTxns = txns.filter((t) => t.date >= from && t.date <= to);
    const lastYm = fyTxns.map((t) => ym(t.date)).sort().pop() || from.slice(0, 7);
    const months = fyMonths(fy, lastYm);
    const sum = (rows, f) => rows.reduce((s, r) => s + (Number(f(r)) || 0), 0);
    // cash flow straight from the bank statements (transfers and FD movements are not income or spend)
    const real = fyTxns.filter((t) => kindOfHead(t.head) !== 'Neutral');
    const credits = months.map((m) => sum(real.filter((t) => ym(t.date) === m && kindOfHead(t.head) === 'Income'), (t) => t.credit - t.debit));
    const debits = months.map((m) => sum(real.filter((t) => ym(t.date) === m && kindOfHead(t.head) === 'Expense'), (t) => t.debit - t.credit));
    const bankRows = banks.map((b) => ({ label: b.name, value: Number(b.balance) + depositsOf(deposits, b.name), track: 0, extra: [{ name: 'Account', color: 'var(--viz-track)', value: inrFull(Number(b.balance)) }, { name: 'Deposits', color: 'var(--viz-track)', value: inrFull(depositsOf(deposits, b.name)) }], valueName: 'Balance + deposits' }));
    // budget progress: forecast as the track, statements + "others" as the bar
    const act = actualsByHead(txns, fy);
    const lines = budget.filter((b) => b.fy === fy);
    const lineRow = (b) => ({ label: b.name, value: (b.heads ? sumHeads(act, b.heads) : 0) + Number(b.other || 0), track: plan(b), valueName: b.kind === 'Income' ? 'Received' : 'Spent', extra: [{ name: 'Forecast', color: 'var(--viz-track)', value: inrFull(plan(b)) }] });
    const incomeRows = lines.filter((b) => b.kind === 'Income').map(lineRow);
    const expenseRows = lines.filter((b) => b.kind === 'Expense').map(lineRow);
    const headRows = EXPENSE_HEADS.map((h) => ({ label: h, value: act[h] || 0, valueName: 'Spent' })).filter((r) => r.value > 1000).sort((a, b) => b.value - a.value).slice(0, 8);
    const unpaid = dues.filter((x) => !['Paid', 'Cancelled'].includes(x.status));
    const duesBy = ['Paid', 'Unpaid', 'Overdue'].map((s) => ({ s, n: dues.filter((x) => x.status === s).length, amt: sum(dues.filter((x) => x.status === s), (x) => x.amount) }));
    const live = tickets.filter((t) => t.status !== 'Closed' && t.status !== 'Cancelled');
    const pipe = { ec: { n: 0, amt: 0 }, fin: { n: 0, amt: 0 }, book: { n: 0, amt: 0 } };
    docs.filter((x) => x.kind === 'Invoice' && x.selected !== false).forEach((x) => {
      const st = invoiceApproval(x).key; const booked = ledger.some((l) => l.sourceId === x.id);
      if (st === 'pending-ec') { pipe.ec.n++; pipe.ec.amt += Number(x.amount) || 0; }
      else if (st === 'pending-final') { pipe.fin.n++; pipe.fin.amt += Number(x.amount) || 0; }
      else if (st === 'approved' && !booked) { pipe.book.n++; pipe.book.amt += Number(x.amount) || 0; }
    });
    live.forEach((t) => {
      const w = approvalState(t, null).waitingOn;
      if (w === 'ec') { pipe.ec.n++; pipe.ec.amt += Number(t.approvedAmount) || 0; }
      if (w === 'treasurer') { pipe.fin.n++; pipe.fin.amt += Number(t.approvedAmount) || 0; }
    });
    const incForecast = sum(lines.filter((b) => b.kind === 'Income'), plan);
    const expForecast = sum(lines.filter((b) => b.kind === 'Expense'), plan);
    return {
      months, credits, debits, bankRows, incomeRows, expenseRows, headRows, duesBy,
      totalBalance: sum(bankRows, (r) => r.value),
      asOf: banks.map((b) => b.asOf).sort().pop(),
      incomeSoFar: sum(incomeRows, (r) => r.value), expenseSoFar: sum(expenseRows, (r) => r.value), incForecast, expForecast,
      outstanding: sum(unpaid, (x) => x.amount), outstandingN: unpaid.length,
      pipe, head: computeHeadroom(banks, fixed, settings[0], deposits),
    };
  }, [ledger, banks, deposits, txns, budget, fixed, settings, dues, docs, tickets, fy]);

  const SERIES = { in: { name: 'Income', color: 'var(--viz-1)' }, out: { name: 'Expense', color: 'var(--viz-2)' } };
  const labels = d.months.map(monthName);
  const awaiting = d.pipe.ec.n + d.pipe.fin.n;
  const duesTotal = d.duesBy.reduce((s, x) => s + x.amt, 0) || 1;
  const DUE_COLOR = { Paid: 'var(--viz-good)', Unpaid: 'var(--viz-bad)', Overdue: 'var(--viz-bad)' };
  const DUE_ICON = { Paid: '✓', Unpaid: '◷', Overdue: '!' };
  const tipDues = useTip();
  const isCurrent = fy === currentFy();

  return (
    <div className="viz-root">
      <div className="viz-filters">
        <label>Financial year
          <select aria-label="Financial year" value={fy} onChange={(e) => setFy(e.target.value)}>
            {fys.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <small className="muted" title="Cash flow, budget and spend come from the bank statements and the Budget for the chosen year. Balances, headroom, dues and approvals are always current.">Charts follow the year chosen · balances, dues and approvals are always current.</small>
      </div>

      <div className="viz-tiles">
        <Tile hero label="Total fund balance" value={inr(d.totalBalance)} sub={`${banks.length} bank accounts incl. deposits · as of ${d.asOf || '—'}`} />
        <Tile label="Headroom" value={inr(d.head.headroom)} sub={d.head.headroom >= 0 ? `Can cover the year · ${d.head.monthsCover.toFixed(1)} months of cover` : 'Shortfall against what is still to pay'} />
        <Tile label={`Income ${fy}`} value={inr(d.incomeSoFar)} sub={d.incForecast ? `${Math.round((d.incomeSoFar / d.incForecast) * 100)}% of ${inr(d.incForecast)} forecast` : 'No forecast entered'} />
        <Tile label={`Spent ${fy}`} value={inr(d.expenseSoFar)} sub={d.expForecast ? `${Math.round((d.expenseSoFar / d.expForecast) * 100)}% of ${inr(d.expForecast)} forecast` : 'No forecast entered'} />
        <Tile label="Dues outstanding" value={inr(d.outstanding)} sub={`${d.outstandingN} unpaid bill${d.outstandingN === 1 ? '' : 's'}`} />
        <Tile label="To approve" value={awaiting} sub={`${inr(d.pipe.ec.amt + d.pipe.fin.amt)} across invoices and quotations`} />
      </div>

      <div className="viz-grid2">
        <ChartCard span={4} title="Cash flow by month" sub={`Income and expense from the bank statements, ${fy}`} legend={<Legend items={[SERIES.in, SERIES.out]} />}
          table={{ head: ['Month', 'Income', 'Expense'], rows: labels.map((l, i) => [l, inrFull(d.credits[i]), inrFull(d.debits[i])]) }}>
          <Columns labels={labels} series={[{ ...SERIES.in, values: d.credits.map((v) => Math.max(0, v)) }, { ...SERIES.out, values: d.debits.map((v) => Math.max(0, v)) }]} />
        </ChartCard>

        <ChartCard span={2} title="Bank accounts & deposits" sub="Account balance plus deposits and investments"
          table={{ head: ['Account', 'Balance + deposits'], rows: d.bankRows.map((r) => [r.label, inrFull(r.value)]) }}>
          <HBars rows={d.bankRows} color="var(--viz-1)" />
        </ChartCard>

        <ChartCard span={2} title={`Income vs forecast · ${fy}`} sub="Bar = received so far, faint bar = forecast"
          table={{ head: ['Line', 'Received', 'Forecast'], rows: d.incomeRows.map((r) => [r.label, inrFull(r.value), inrFull(r.track)]) }}>
          <HBars rows={d.incomeRows} color="var(--viz-1)" track="var(--viz-track)" empty={`No income lines for ${fy}.`} />
        </ChartCard>

        <ChartCard span={2} title={`Spending vs forecast · ${fy}`} sub="Bar = spent so far, faint bar = forecast"
          table={{ head: ['Line', 'Spent', 'Forecast'], rows: d.expenseRows.map((r) => [r.label, inrFull(r.value), inrFull(r.track)]) }}>
          <HBars rows={d.expenseRows} color="var(--viz-2)" track="var(--viz-track)" empty={`No expense lines for ${fy}.`} />
        </ChartCard>

        <ChartCard span={2} title="Spend by head" sub={`Biggest statement heads, ${fy}`}
          table={{ head: ['Head', 'Spent'], rows: d.headRows.map((r) => [r.label, inrFull(r.value)]) }}>
          <HBars rows={d.headRows} color="var(--viz-2)" empty="No spending in this year." />
        </ChartCard>

        <ChartCard span={3} title="Dues collection" sub="All bills by status"
          legend={<div className="viz-legend">{d.duesBy.map((x) => <span key={x.s}><i style={{ background: DUE_COLOR[x.s] }} />{DUE_ICON[x.s]} {x.s} · {x.n} · {inr(x.amt)}</span>)}</div>}
          table={{ head: ['Status', 'Bills', 'Amount'], rows: d.duesBy.map((x) => [x.s, x.n, inrFull(x.amt)]) }}>
          <div className="viz-stack" ref={tipDues.box} onPointerLeave={tipDues.hide}>
            {d.duesBy.filter((x) => x.amt > 0).map((x) => (
              <i key={x.s} tabIndex={0} style={{ width: `${(x.amt / duesTotal) * 100}%`, background: DUE_COLOR[x.s] }}
                onPointerMove={(e) => tipDues.show(e, x.s, [{ name: `${x.n} bill${x.n === 1 ? '' : 's'}`, color: DUE_COLOR[x.s], value: inrFull(x.amt) }])} />
            ))}
            {tipDues.node}
          </div>
        </ChartCard>

        <ChartCard span={3} title="Approvals pipeline" sub="Invoices and quotations on their way to the books"
          table={{ head: ['Stage', 'Items', 'Amount'], rows: [['Waiting for EC', d.pipe.ec.n, inrFull(d.pipe.ec.amt)], ['Waiting for final approval', d.pipe.fin.n, inrFull(d.pipe.fin.amt)], ['Approved, not in ledger', d.pipe.book.n, inrFull(d.pipe.book.amt)]] }}>
          <HBars color="var(--viz-1)" valueFmt={inr}
            rows={[
              { label: `Waiting for EC · ${d.pipe.ec.n}`, value: d.pipe.ec.amt, valueName: 'Amount' },
              { label: `Final approval · ${d.pipe.fin.n}`, value: d.pipe.fin.amt, valueName: 'Amount' },
              { label: `To book · ${d.pipe.book.n}`, value: d.pipe.book.amt, valueName: 'Amount' },
            ]} />
        </ChartCard>
      </div>
      {!isCurrent && <small className="muted">Headroom reflects today’s balances and estimates whichever year is selected.</small>}
    </div>
  );
}

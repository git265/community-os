import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import { MoneyTiles } from '../../components/ui.jsx';
import { recordPayment, routingMap } from '../../lib/paymentEngine.js';
import { actualOf, hasActual, savingOf, creditedOf, toCredit, yearOf, seriesOf, summarize } from '../../lib/culturalBudget.js';
import { fmtDate, money } from '../../lib/locale.js';

const inr = (n) => money(n);
const short = (n) => (Math.abs(n) >= 100000 ? `₹${(n / 100000).toFixed(n % 100000 ? 2 : 0)}L` : Math.abs(n) >= 1000 ? `₹${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : `₹${Math.round(n)}`);
const dmy = (s) => fmtDate(s, { year: false });
const SAVE = '#2563eb'; const OVER = '#ea580c'; const PLAN = '#94a3b8';

export function CreditDialog({ ev, onClose, onDone }) {
  const { currentUser } = useApp();
  const { save } = useCollection(C.CULTURAL_EVENTS, 'Cultural Events');
  const room = toCredit(ev);
  const [amount, setAmount] = useState(String(Math.round(room)));
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const { records: accounts } = useCollection(C.BANK_ACCOUNTS, 'Bank Accounts');
  async function go() {
    if (saved) return onDone(saved);
    const a = Number(amount);
    if (!(a > 0)) return setErr('Enter the amount to credit');
    if (a > room + 0.5) return setErr(`Only ${inr(room)} is left unspent`);
    setBusy(true);
    try {
      const out = await save({ ...ev, creditedAmount: creditedOf(ev) + a, creditedAt: new Date().toISOString().slice(0, 10), creditedBy: currentUser?.name || '', creditNote: note.trim() });
      if (!out) { setBusy(false); return setErr('Not saved - only the Treasurer or the final approvers can credit unused budget.'); }
      // leave a record in Payments (an internal entry: the money never left the account, so it has no bank statement line)
      const route = await routingMap().catch(() => ({}));
      const account = accounts.find((x) => x.name === ev.fund)?.name || route.Cultural || '';
      const res = await recordPayment({ area: 'Cultural', type: 'Credit', amount: a, account, date: new Date().toISOString().slice(0, 10), mode: 'Internal', description: `Unused budget credited back · ${ev.name}${note.trim() ? ` · ${note.trim()}` : ''}`,
        sourceType: 'culturalCredit', sourceId: `culturalCredit:${ev.id}:${Date.now()}`, sourceLabel: ev.name, vendor: ev.fund ? `${ev.fund} fund` : 'Cultural fund', allowDuplicate: true, extra: { internal: true, reconStatus: 'Not applicable' } });
      setBusy(false);
      if (res.error) { setSaved(out); return setErr(`The credit is saved, but its Payments record could not be created: ${res.error}`); }
      onDone(out);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Credit the unused budget" subtitle={`${ev.name} · ${ev.fund ? `${ev.fund} fund` : 'community fund'}`} onClose={onClose}>
      <div data-testid="credit-dialog">
        {err && <div className="notice error" data-testid="credit-error">{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', marginBottom: 10 }}>
          <span className="muted">Budget</span><b>{inr(ev.budget)}</b>
          <span className="muted">Actual spend</span><b>{inr(actualOf(ev))}</b>
          <span className="muted">Unused</span><b>{inr(savingOf(ev))}</b>
          {creditedOf(ev) > 0 && <><span className="muted">Already credited</span><b>{inr(creditedOf(ev))}</b></>}
        </div>
        <div className="form-grid">
          <div className="field"><label>Credit back to the fund (₹)</label><input type="number" aria-label="Credit amount" min="0" max={room} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>Note (optional)</label><input aria-label="Credit note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. returned to the cultural fund" /></div>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>This releases the part of the estimate that was not spent back to the fund, so it is no longer held for this event. A record is added to Payments (Cultural → Budget credits), but no bank transaction is expected because the money never left the account.</p>
        <div className="form-actions"><button className="btn good" disabled={busy} data-testid="credit-confirm" onClick={go}>{busy ? 'Saving…' : saved ? 'Close' : `Credit ${inr(Number(amount) || 0)}`}</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}

/** Budget vs actual per event: one horizontal pair of bars per row. */
function PairBars({ rows, title, testid }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.budget, r.actual || 0]));
  const rowH = 38; const left = 150; const w = 560; const h = rows.length * rowH + 8;
  const x = (v) => left + (v / max) * (w - left - 70);
  return (
    <div data-testid={testid}>
      <h3 style={{ margin: '0 0 4px' }}>{title}</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}><span style={{ color: PLAN }}>■</span> Estimate &nbsp; <span style={{ color: SAVE }}>■</span> Actual (within estimate) &nbsp; <span style={{ color: OVER }}>■</span> Actual (over estimate)</div>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} style={{ width: '100%', height: 'auto', maxHeight: h * 1.2 }}>
        {rows.map((r, i) => {
          const y = i * rowH + 4; const over = r.actual > r.budget && r.budget > 0;
          return (
            <g key={r.id}>
              <text x={left - 8} y={y + 18} textAnchor="end" fontSize="11.5" fill="currentColor">{r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label}</text>
              <rect x={left} y={y + 3} width={Math.max(1, x(r.budget) - left)} height={11} rx={2} fill={PLAN} />
              <text x={x(r.budget) + 4} y={y + 12} fontSize="10.5" fill="currentColor" opacity=".75">{r.budget ? short(r.budget) : 'no estimate'}</text>
              {r.actual > 0 ? (<><rect x={left} y={y + 17} width={Math.max(1, x(r.actual) - left)} height={11} rx={2} fill={over ? OVER : SAVE} />
                <text x={x(r.actual) + 4} y={y + 26} fontSize="10.5" fontWeight="600" fill="currentColor">{short(r.actual)}</text></>)
                : <text x={left} y={y + 26} fontSize="10.5" fill="currentColor" opacity=".6">actual not entered</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Same event across years: actual spend per edition. */
function YearOnYear({ events, years }) {
  const groups = useMemo(() => {
    const m = new Map();
    events.forEach((e) => { const k = seriesOf(e); (m.get(k) || m.set(k, []).get(k)).push(e); });
    return [...m.entries()].map(([k, list]) => ({ k, byYear: Object.fromEntries(list.map((e) => [yearOf(e), e])) }))
      .filter((g) => years.every((y) => g.byYear[y] && hasActual(g.byYear[y]))).sort((a, b) => a.k.localeCompare(b.k));
  }, [events, years]);
  if (!groups.length) return null;
  const palette = { [years[0]]: '#7c3aed', [years[1]]: SAVE };
  const max = Math.max(1, ...groups.flatMap((g) => years.map((y) => (g.byYear[y] ? actualOf(g.byYear[y]) : 0))));
  const rowH = 30 + years.length * 12; const left = 150; const w = 560;
  const x = (v) => left + (v / max) * (w - left - 120);
  return (
    <div data-testid="yoy-chart">
      <h3 style={{ margin: '0 0 4px' }}>Year on year — what each event actually cost</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{years.map((y) => <span key={y} style={{ marginRight: 12 }}><span style={{ color: palette[y] }}>■</span> {y}</span>)}</div>
      <svg viewBox={`0 0 ${w} ${groups.length * rowH + 8}`} role="img" aria-label="Actual spend per event, by year" style={{ width: '100%', height: 'auto' }}>
        {groups.map((g, i) => {
          const y0 = i * rowH + 4;
          return (
            <g key={g.k}>
              <text x={left - 8} y={y0 + 16} textAnchor="end" fontSize="11.5" fill="currentColor">{g.k.length > 22 ? `${g.k.slice(0, 21)}…` : g.k}</text>
              {years.map((y, j) => { const e = g.byYear[y]; const a = e ? actualOf(e) : 0; const yy = y0 + 3 + j * 14;
                return a > 0 ? (<g key={y}><rect x={left} y={yy} width={Math.max(1, x(a) - left)} height={11} rx={2} fill={palette[y]} /><text x={x(a) + 4} y={yy + 9} fontSize="10.5" fill="currentColor">{short(a)}{j > 0 && g.byYear[years[0]] && actualOf(g.byYear[years[0]]) > 0 ? `  (${a >= actualOf(g.byYear[years[0]]) ? '+' : '−'}${Math.abs(Math.round(((a - actualOf(g.byYear[years[0]])) / actualOf(g.byYear[years[0]])) * 100))}%)` : ''}</text></g>)
                  : <text key={y} x={left} y={yy + 9} fontSize="10.5" fill="currentColor" opacity=".55">{y}: no actual</text>; })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function BudgetDashboard({ events, canCredit, onOpenEvent }) {
  const { records: all, refresh } = useCollection(C.CULTURAL_EVENTS, 'Cultural Events');
  const list = (all && all.length ? all : events).filter((e) => e.status !== 'Cancelled');
  const years = useMemo(() => [...new Set(list.map(yearOf))].filter(Boolean).sort((a, b) => b.localeCompare(a)), [list]);
  const [year, setYear] = useState('');
  const [dlg, setDlg] = useState(null);
  const [bt, setBt] = useState('overview');
  const thisYear = String(new Date().getFullYear());
  const sel = years.includes(year) ? year : (years.includes(thisYear) ? thisYear : years[0]);
  const inYear = list.filter((e) => yearOf(e) === sel).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const s = summarize(inYear);
  const rows = inYear.map((e) => ({ id: e.id, label: e.name.replace(/\b(19|20)\d{2}\b/g, '').trim(), budget: Number(e.budget) || 0, actual: actualOf(e) }));
  const pct = s.budgetOfDone ? Math.round((s.actualOfDone / s.budgetOfDone) * 100) : 0;
  const twoYears = years.filter((y) => y <= thisYear).slice(0, 2).reverse();
  return (
    <div data-testid="budget-dashboard">
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, flex: 1 }}>Budget vs actual</h2>
          <select className="pick-year" aria-label="Year" data-testid="budget-year-select" value={sel} onChange={(e) => setYear(e.target.value)} style={{ marginLeft: 'auto' }}>
            {years.map((y) => <option key={y} value={y}>{y} ({list.filter((e) => yearOf(e) === y).length} events)</option>)}
          </select>
        </div>
        <p className="muted" style={{ margin: '4px 0 0' }}>Each event is planned with an estimate, then the actual spend is entered. Events that are not finished or have no actual yet are left out of the totals.</p>
      </div>

      <div data-testid="budget-tiles"><MoneyTiles items={[
        { label: `${sel} · events`, value: s.events, sub: `${s.compared} with an estimate and an actual` },
        { label: 'Estimate', value: inr(s.budgetOfDone), sub: 'for those events' },
        { label: 'Actual', value: inr(s.actualOfDone), sub: s.budgetOfDone ? `${pct}% of the estimate` : '', tone: s.actualOfDone > s.budgetOfDone ? 'orange' : 'green' },
        { label: s.variance >= 0 ? 'Under estimate' : 'Over estimate', value: inr(Math.abs(s.variance)), sub: `${s.under} under · ${s.over} over`, tone: s.variance >= 0 ? 'green' : 'red' },
        { label: 'Unused, can be credited', value: inr(s.unspent), sub: s.credited ? `${inr(s.credited)} already credited` : 'back to the fund', tone: s.unspent ? 'orange' : '' },
      ]} /></div>

      <div className="sub-tabs" role="tablist" aria-label="Budget sections" data-testid="budget-tabs">
        {[['overview', 'Events'], ['charts', 'Charts'], ['years', 'By year']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={bt === k} className={bt === k ? 'active' : ''} data-testid={`bt-${k}`} onClick={() => setBt(k)}>{l}</button>)}
      </div>
      {bt === 'overview' && (<>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>{sel} events</h3>
        <table className="resp-table" data-testid="budget-table"><thead><tr><th>Event</th><th>Date</th><th>Estimate</th><th>Actual</th><th>Difference</th><th>Status</th><th></th></tr></thead>
          <tbody>{inYear.map((e) => { const b = Number(e.budget) || 0; const a = actualOf(e); const diff = b - a; const room = toCredit(e); return (
            <tr key={e.id} data-testid="budget-row">
              <td data-label="Event"><a href="#" onClick={(ev) => { ev.preventDefault(); onOpenEvent?.(e); }}><b>{e.name}</b></a>{e.size && <small className="muted"> · {e.size}</small>}</td>
              <td data-label="Date">{dmy(e.startDate)}</td><td data-label="Estimate">{b ? inr(b) : '—'}</td><td data-label="Actual">{a ? inr(a) : <span className="muted">not entered</span>}</td>
              <td data-label="Difference">{a && b ? <span className={`tag ${diff >= 0 ? 'green' : 'red'}`}>{diff >= 0 ? '−' : '+'}{inr(Math.abs(diff))} {diff >= 0 ? 'under' : 'over'}</span> : <span className="muted">—</span>}</td>
              <td data-label="Status"><span className="tag">{e.status}</span></td>
              <td data-label="" style={{ whiteSpace: 'nowrap' }}>
                {creditedOf(e) > 0 && <span className="tag blue" data-testid="credited-tag">{inr(creditedOf(e))} credited</span>}
                {room > 0 && canCredit && <button className="btn sm good" style={{ marginLeft: 6 }} data-testid="credit-btn" onClick={() => setDlg(e)}>Credit {inr(room)} to fund</button>}
                {room > 0 && !canCredit && <small className="muted">{inr(room)} unused</small>}
              </td></tr>); })}</tbody></table>
      </div>
      </>)}
      {bt === 'charts' && (<>
      <div className="card" style={{ marginTop: 12 }}>{rows.length ? <PairBars rows={rows} title={`${sel}: estimate and actual, event by event`} testid="pair-chart" /> : <div className="empty">No events this year.</div>}</div>
      {twoYears.length === 2 && <div className="card" style={{ marginTop: 12 }}><YearOnYear events={list} years={twoYears} /></div>}

      </>)}
      {bt === 'years' && (<>
      <div className="card" style={{ marginTop: 12 }} data-testid="year-summary">
        <h3 style={{ marginTop: 0 }}>Summary by year</h3>
        <table className="resp-table"><thead><tr><th>Year</th><th>Events</th><th>Estimate</th><th>Actual</th><th>Difference</th><th>Under / over</th><th>Credited back</th><th>Actual not entered</th></tr></thead>
          <tbody>{years.map((y) => { const t = summarize(list.filter((e) => yearOf(e) === y)); return (
            <tr key={y} data-testid={`ysum-${y}`} style={y === sel ? { background: 'var(--surface-2, #f1f5f9)' } : undefined}>
              <td data-label="Year"><b>{y}</b></td><td data-label="Events">{t.events}</td><td data-label="Estimate">{inr(t.budgetOfDone)}</td><td data-label="Actual">{inr(t.actualOfDone)}</td>
              <td data-label="Difference">{t.compared ? <><span className={`tag ${t.variance >= 0 ? 'green' : 'red'}`}>{t.variance >= 0 ? '−' : '+'}{inr(Math.abs(t.variance))}</span> <small className="muted">{t.variance >= 0 ? 'under' : 'over'}</small></> : <span className="muted">—</span>}</td>
              <td data-label="Under / over">{t.compared ? `${t.under} / ${t.over}` : '—'}</td><td data-label="Credited back">{t.credited ? inr(t.credited) : '—'}</td><td data-label="Actual not entered">{t.awaiting || '—'}</td></tr>); })}</tbody></table>
      </div>

      </>)}
      {dlg && <CreditDialog ev={dlg} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh?.(); }} />}
    </div>
  );
}

import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { MoneyTiles } from '../../components/ui.jsx';
import { areaOf } from '../../lib/paymentEngine.js';
import { moneyPosition } from '../../lib/approval/position.js';
import { releaseSummary } from '../../lib/approval/releases.js';
import { fmtDate, money } from '../../lib/locale.js';
import MoneyChecks from './MoneyChecks.jsx';

const inr = (n) => money(n);
const dmy = (s) => fmtDate(s, { year: false, empty: '—' });

/**
 * One screen that lists everything that does not add up, in the order someone would chase it:
 *   1 paid more than approved   2 closed with money still owed   3 advances not yet covered by an invoice
 *   4 approved but not yet paid   5 payments tied to no task   6 payments with no bank line
 * Each row opens the task. All sections empty = reconciled.
 */
export default function Reconciliation({ ledger, onOpenTask }) {
  const { records: tickets } = useCollection(C.TICKETS, 'Tasks');
  const { records: docs } = useCollection(C.QUOTATIONS, 'Quotations');
  const { records: releases } = useCollection(C.RELEASES, 'Fund releases');
  const { records: expenses } = useCollection(C.CULTURAL_EXPENSES, 'Event Expenses');
  const { save: saveLedger } = useCollection(C.LEDGER, 'Payments Cross-check');
  const [linking, setLinking] = useState(null); // ledger id being linked
  const [pick, setPick] = useState('');
  const { records: fset } = useCollection(C.FINANCE_SETTINGS, 'Finance settings');
  const tol = fset[0]?.invoiceTolerancePct === undefined ? 5 : Number(fset[0].invoiceTolerancePct) || 0;

  const data = useMemo(() => {
    const fin = tickets.filter((t) => t.financial && t.status !== 'Cancelled');
    const rows = fin.map((t) => ({ t, pos: moneyPosition(t, docs, releases, ledger, tol), sum: releaseSummary(t, releases, docs.filter((d) => d.ticketId === t.id), tol) }));
    const overpaid = rows.filter((r) => r.pos.overpaid > 0);
    const closedOwed = rows.filter((r) => ['Closed', 'Completed'].includes(r.t.status) && r.pos.owed > 0.5);
    const advances = rows.filter((r) => r.sum.paid > 0 && !r.sum.settled);
    const waiting = releases.filter((r) => r.status === 'Approved').map((r) => ({ r, t: tickets.find((x) => x.id === r.ticketId), x: expenses.find((e) => e.id === r.expenseId) })).filter((x) => x.t || x.x);
    const known = new Set([...tickets.map((t) => t.id), ...docs.map((d) => d.id), ...releases.map((r) => r.id)]);
    const unlinked = ledger.filter((l) => l.type === 'Debit' && !l.internal && ['Maintenance', 'Other'].includes(areaOf(l)) && !l.taskRef && !l.noTask && !known.has(l.sourceId));
    const noBank = ledger.filter((l) => l.type === 'Debit' && !l.internal && l.reconStatus !== 'Matched' && l.mode !== 'Cash');
    const sum = (a, f) => a.reduce((n, x) => n + (f(x) || 0), 0);
    return { rows, overpaid, closedOwed, advances, waiting, unlinked, noBank, totals: { due: sum(rows, (r) => r.pos.due), paid: sum(rows, (r) => r.pos.paid), owed: sum(rows, (r) => r.pos.owed), over: sum(overpaid, (r) => r.pos.overpaid) } };
  }, [tickets, docs, releases, expenses, ledger, tol]);

  const open = (t) => onOpenTask?.(t.ticketNumber);
  const linkable = tickets.filter((t) => t.financial && !['Cancelled'].includes(t.status)).sort((a, b) => String(b.ticketNumber).localeCompare(String(a.ticketNumber)));
  const NO_TASK = ['Contract / AMC', 'Payroll', 'Statutory (GST / TDS)', 'Bank charge', 'Office / admin', 'Other'];
  async function link(l) { if (!pick) return; const ok = await saveLedger({ ...l, taskRef: pick }); if (ok) { setLinking(null); setPick(''); } }
  async function noTask(l, why) { await saveLedger({ ...l, noTask: why }); }
  const issues = data.overpaid.length + data.closedOwed.length + data.advances.length + data.waiting.length + data.unlinked.length + data.noBank.length;
  const Sec = ({ id, title, hint, count, children, tone }) => (
    <section className="card recon-sec" data-testid={`recon-${id}`}>
      <div className="recon-head"><b>{title}</b><span className={`tag ${count ? tone : 'green'}`}>{count ? count : '✓ none'}</span></div>
      <small className="muted">{hint}</small>
      {count > 0 && <ul className="list recon-list">{children}</ul>}
    </section>
  );
  const TaskRow = ({ t, right, note }) => (
    <li className={onOpenTask ? 'row-link' : ''} onClick={() => open(t)}>
      <span><b className="mono">{t.ticketNumber}</b> · {t.title}{note && <><br /><small className="muted">{note}</small></>}</span>
      <b>{right}</b>
    </li>
  );

  return (
    <div data-testid="reconciliation">
      <MoneyTiles items={[
        { label: 'Agreed to pay', value: inr(data.totals.due), sub: `${data.rows.length} financial tasks` },
        { label: 'Paid', value: inr(data.totals.paid) },
        { label: 'Still to pay', value: inr(data.totals.owed), tone: data.totals.owed > 0 ? 'orange' : '' },
        { label: 'Paid above approved', value: inr(data.totals.over), tone: data.totals.over > 0 ? 'red' : '' },
      ]} />
      <MoneyChecks />
      <p className="muted" data-testid="recon-status">{issues === 0 ? '✓ Everything adds up: no overpayments, nothing owed on closed tasks, every payment is linked and matched.' : `${issues} item${issues === 1 ? '' : 's'} to look at, most important first.`}</p>

      <Sec id="over" title="Paid more than approved" hint="Total paid on the task is above the approved invoice / quotation (beyond the tolerance)." count={data.overpaid.length} tone="red">
        {data.overpaid.map(({ t, pos }) => <TaskRow key={t.id} t={t} right={`+${inr(pos.overpaid)}`} note={`Approved ${inr(pos.due)} · paid ${inr(pos.paid)}`} />)}
      </Sec>
      <Sec id="closed" title="Closed with money still to pay" hint="The task is finished but approved money has not gone out yet." count={data.closedOwed.length} tone="orange">
        {data.closedOwed.map(({ t, pos }) => <TaskRow key={t.id} t={t} right={inr(pos.owed)} note={`Approved ${inr(pos.due)} · paid ${inr(pos.paid)}`} />)}
      </Sec>
      <Sec id="adv" title="Released money not yet covered by an invoice" hint="Money was released early and the approved invoices do not cover it. The EC can settle it with a note." count={data.advances.length} tone="orange">
        {data.advances.map(({ t, sum }) => <TaskRow key={t.id} t={t} right={inr(sum.unsettled)} note={`Released and paid ${inr(sum.paid)} · invoices approved ${inr(sum.invApproved)}`} />)}
      </Sec>
      <Sec id="wait" title="Approved releases waiting to be paid" hint="Approved by the committee; the Treasurer has not paid them yet." count={data.waiting.length} tone="orange">
        {data.waiting.map(({ r, t, x }) => t ? <TaskRow key={r.id} t={t} right={inr(r.amount)} note={`${r.shortId} · to ${r.vendor}`} /> : <li key={r.id}><span><b>{x.item}</b> · cultural<br /><small className="muted">{r.shortId} · to {r.vendor}</small></span><b>{inr(r.amount)}</b></li>)}
      </Sec>
      <Sec id="unlinked" title="Payments not linked to any task" hint="Paid with no task, invoice or release attached. For repairs, link the payment to its task (only tasks marked financial are listed). For contracts, payroll, tax or bank charges choose a reason under “No task needed” and it leaves this list." count={data.unlinked.length} tone="orange">
        {data.unlinked.map((l) => (
          <li key={l.id} data-testid="unlinked-row" style={{ flexWrap: 'wrap' }}>
            <span><b className="mono">{l.shortId}</b> · {l.description || l.vendor}<br /><small className="muted">{dmy(l.date)} · {l.account}{l.vendor ? ` · ${l.vendor}` : ''}</small></span><b>{inr(l.amount)}</b>
            <div style={{ flexBasis: '100%', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {linking === l.id ? (<>
                <select aria-label="Task to link" data-testid="link-pick" value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: 'auto', maxWidth: '100%' }}>
                  <option value="">Choose a task…</option>{linkable.map((t) => <option key={t.id} value={t.ticketNumber}>{t.ticketNumber} · {t.title}</option>)}
                </select>
                <button type="button" className="btn good sm" data-testid="link-save" disabled={!pick} onClick={() => link(l)}>Link</button>
                <button type="button" className="btn secondary sm" onClick={() => { setLinking(null); setPick(''); }}>Cancel</button>
              </>) : (<>
                <button type="button" className="btn secondary sm" data-testid="link-open" onClick={() => { setLinking(l.id); setPick(''); }}>Link to task…</button>
                <select aria-label="No task needed" data-testid="no-task" value="" onChange={(e) => e.target.value && noTask(l, e.target.value)} style={{ width: 'auto' }}>
                  <option value="">No task needed…</option>{NO_TASK.map((w) => <option key={w}>{w}</option>)}
                </select>
              </>)}
            </div>
          </li>
        ))}
      </Sec>
      <Sec id="bank" title="Payments with no bank statement line" hint="Recorded as paid but not yet matched in Bank matching (cash payments are left out)." count={data.noBank.length} tone="blue">
        {data.noBank.map((l) => <li key={l.id}><span><b className="mono">{l.shortId}</b> · {l.description || l.vendor}<br /><small className="muted">{dmy(l.date)} · {l.account} · {l.mode || ''}</small></span><b>{inr(l.amount)}</b></li>)}
      </Sec>
    </div>
  );
}

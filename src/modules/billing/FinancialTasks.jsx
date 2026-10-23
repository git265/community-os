import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { invoiceApproval, approvalState } from '../tickets/ticketEngine.js';
import { RecentNote, recentCutoff, inRecent } from '../../components/RecentWindow.jsx';
import { usePrompt } from '../../components/PromptDialog.jsx';
import { releaseSummary } from '../../lib/approval/releases.js';
import { liveDebits, grossOf, paymentBlock } from '../../lib/approval/moneyGuard.js';
import { reversePayment } from '../../lib/paymentEngine.js';
import { money } from '../../lib/locale.js';
import Tabs from '../../components/Tabs.jsx';

const inr = (n) => money(n, { round: false });
const tone = (v) => (v === 'Approved' ? 'green' : v === 'Rejected' ? 'red' : 'orange');

/**
 * The Treasurer's queue of maintenance tasks with money in them, built from the task, its invoices and the ledger.
 * Buckets: todo (fully approved, not paid), done (paid), skipped (deliberately not paid), approval (still being approved).
 */
export function useFinancialQueue() {
  const { records: tickets } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const { records: ledger } = useCollection(COLLECTIONS.LEDGER, 'Payments Cross-check');
  const { records: docs } = useCollection(COLLECTIONS.QUOTATIONS, 'Quotations');
  const { records: skips } = useCollection(COLLECTIONS.LEDGER_SKIPS, 'Not Recorded Payments');
  const { records: releases } = useCollection(COLLECTIONS.RELEASES, 'Fund releases');
  const { records: fset } = useCollection(COLLECTIONS.FINANCE_SETTINGS, 'Finance settings');
  const tol = fset[0]?.invoiceTolerancePct === undefined ? 5 : Number(fset[0].invoiceTolerancePct) || 0;
  const all = useMemo(() => {
    const out = [];
    const liveL = liveDebits(ledger);
    tickets.filter((t) => t.financial && t.status !== 'Cancelled').forEach((t) => {
      const invs = docs.filter((d) => d.ticketId === t.id && d.kind === 'Invoice' && d.selected !== false);
      const sm = releaseSummary(t, releases, docs, tol, ledger);
      const mk = (key, inv, st, linked) => {
        const skip = skips.find((s) => s.sourceId === key);
        const st2 = st || approvalState(t, null);
        const ready = !inv ? (t.selectedQuotationId ? st2.key === 'approved' : false) : st.key === 'approved';
        const credit = inv ? sm.credits[inv.id] || 0 : 0;
        // a part payment does not finish an invoice (or a task): the balance stays payable until the approved amount is covered
        const paidOn = linked.reduce((n, l) => n + grossOf(l), 0);
        const invBal = inv ? Math.max(0, Math.round((Number(inv.amount) - credit - paidOn) * 100) / 100) : null;
        const fullyPaid = linked.length > 0 && (inv ? invBal <= 0.5 : !(sm.cap > 0) || sm.capLeft <= 0.5);
        const bucket = fullyPaid ? 'done' : skip ? 'skipped' : ready ? 'todo' : 'approval';
        // no invoice yet: money already released is part of the approved amount, only the balance is left to pay
        const balance = !inv && sm.hasReleases ? sm.left : null;
        const covered = !!inv && credit > 0 && (Number(inv.amount) || 0) - credit <= 0.5; // fully paid through releases
        const b2 = covered && !linked.length && !skip && ready ? 'done' : !inv && sm.hasReleases && !linked.length && !skip && ready && sm.left <= 0.5 ? 'done' : bucket;
        return { key, t, inv, st: st2, linked, skip, bucket: b2, credit, balance: inv ? balance : (linked.length && sm.cap > 0 ? sm.capLeft : balance), sm, part: linked.length > 0 && !fullyPaid, invBal };
      };
      if (invs.length) invs.forEach((inv) => out.push(mk(inv.id, inv, invoiceApproval(inv), liveL.filter((l) => l.sourceId === inv.id))));
      else out.push(mk(t.id, null, null, liveL.filter((l) => l.taskRef === t.ticketNumber && l.sourceType !== 'release')));
    });
    releases.forEach((r) => {
      const t = tickets.find((x) => x.id === r.ticketId); if (!t || ['Rejected', 'Cancelled'].includes(r.status)) return;
      out.push({ key: `rel:${r.id}`, t, rel: r, inv: null, st: { key: r.status === 'Approved' || r.status === 'Paid' ? 'approved' : 'pending', label: r.status, tone: r.status === 'Waiting approval' ? 'orange' : 'green' }, linked: liveL.filter((l) => l.sourceId === r.id), skip: null, bucket: r.status === 'Paid' ? 'done' : r.status === 'Approved' ? 'todo' : 'approval', payBlock: r.status === 'Approved' ? paymentBlock({ type: 'Debit', amount: r.amount, sourceType: 'release', sourceId: r.id }, { tickets, docs, releases, ledger }) : '' });
    });
    return out.sort((a, b) => (b.t.recordCreatedAt || '').localeCompare(a.t.recordCreatedAt || ''));
  }, [tickets, docs, ledger, skips, releases, tol]);
  return all;
}

/**
 * Maintenance tasks with money in them, for the Treasurer to review and pay.
 *   To pay      fully approved (EC and, unless the EC made its approval the last step, the final approver), not yet paid -> Pay… or Skip (give a reason)
 *   Paid        already paid (linked to its ledger entries)
 *   Skipped     deliberately not paid (reason kept; can be restored)
 *   In approval still waiting for EC / final approval
 */
export default function FinancialTasks({ onOpenTask, onPay }) {
  const { hasPermission, roleId } = useApp();
  const { save: saveRelease } = useCollection(COLLECTIONS.RELEASES, 'Fund releases');
  const { save: saveSkip, remove: removeSkip } = useCollection(COLLECTIONS.LEDGER_SKIPS, 'Not Recorded Payments');
  const all = useFinancialQueue();
  const [show, setShow] = useState('todo'); // todo | done | skipped | approval
  const { ask, node } = usePrompt();
  const canRecord = hasPermission('MANAGE_LEDGER') || roleId === 'super_admin';
  const count = (b) => all.filter((r) => r.bucket === b).length;
  const [older, setOlder] = useState(false);
  const cutoff = recentCutoff();
  const allRows = all.filter((r) => r.bucket === show);
  const dateOf = (r) => (show === 'skipped' ? String(r.skip?.createdAt || '').slice(0, 10) : r.linked?.[0]?.date || '');
  const rows = (show === 'done' || show === 'skipped') && !older ? allRows.filter((r) => inRecent(dateOf(r), cutoff)) : allRows;

  async function skip(r) {
    const v = await ask({ title: 'Skip this payment', subtitle: 'It moves to “Skipped” so it stops showing as waiting. You can restore it later.', confirm: 'Skip', fields: [{ key: 'reason', label: 'Reason', type: 'textarea', required: true }] });
    if (!v) return;
    await saveSkip({ sourceId: r.key, taskRef: r.t.ticketNumber, label: r.inv ? `Invoice ${r.inv.shortId} · ${r.inv.vendor} · ${inr(r.inv.amount)}` : `${r.t.title} · ${inr(r.t.approvedAmount || r.t.materialsCost)}`, reason: v.reason });
  }

  async function reverse(l) {
    const v = await ask({ title: `Reverse payment ${l.shortId || ''}`, subtitle: `${inr(l.amount)} to ${l.vendor || '—'}. The payment stays in the history; a matching credit cancels it so it can be recorded correctly. Not possible once matched to a bank statement line.`, confirm: 'Reverse', fields: [{ key: 'reason', label: 'Why is it being reversed?', type: 'textarea', required: true }] });
    if (!v) return;
    const res = await reversePayment(l, v.reason);
    if (res.error) window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: res.error } }));
  }
  async function cancelRel(r) {
    const v = await ask({ title: 'Cancel this release', subtitle: `${inr(r.rel.amount)} to ${r.rel.vendor}. ${r.payBlock}`, confirm: 'Cancel release', fields: [{ key: 'reason', label: 'Why is it cancelled?', type: 'textarea', required: true }] });
    if (!v) return;
    await saveRelease({ ...r.rel, status: 'Cancelled', cancelReason: v.reason, cancelledBy: 'Billing' });
  }
  const TABS = [['todo', 'To pay'], ['done', 'Paid'], ['skipped', 'Skipped'], ['approval', 'In approval']];
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>🛠 Maintenance tasks &amp; invoices</h2>
        <Tabs style={{ margin: 0 }}>
          {TABS.map(([k, l]) => <button key={k} className={show === k ? 'active' : ''} onClick={() => setShow(k)}>{l} ({count(k)})</button>)}
        </Tabs>
      </div>
      {rows.length === 0 ? (
        <div className="empty">{show === 'todo' ? 'Nothing waiting to be paid.' : show === 'done' ? 'Nothing paid yet.' : show === 'skipped' ? 'Nothing has been skipped.' : 'No financial task is waiting for approval.'}</div>
      ) : (
        <ul className="list">
          {rows.map((r) => {
            const { t, inv, st, linked } = r;
            return (
              <li key={r.key} className={onOpenTask ? 'row-link' : ''} onClick={() => onOpenTask?.(t.ticketNumber)} title={onOpenTask ? 'Open task details' : undefined}>
                <span>
                  <b className="mono">{t.ticketNumber}</b> · {onOpenTask ? <button type="button" className="link-btn">{t.title}</button> : t.title}
                  <br />
                  {r.rel ? (
                    <>
                      <small className="muted">Release {r.rel.shortId} · {r.rel.vendor} · {inr(r.rel.amount)}{r.rel.note ? ` · ${r.rel.note}` : ''} · </small>
                      <span className={`tag ${st.tone}`}>{st.label}</span>{' '}
                    </>
                  ) : inv ? (
                    <>
                      <small className="muted">Invoice {inv.shortId} · {inv.vendor} · {inr(inv.amount)}{Number(inv.gstAmount) > 0 ? ` · GST ${inr(inv.gstAmount)}` : ''} · </small>
                      <span className={`tag ${st.tone}`}>{st.label}</span>{' '}
                      {r.credit > 0 && <span className="tag purple" data-testid="advance-credit">Less advance paid {inr(r.credit)} → pay {inr(inv.amount - r.credit)}</span>}
                    </>
                  ) : (
                    <>
                      <small className="muted">{t.assignedTo || 'Unassigned'} · {inr(t.approvedAmount || t.materialsCost)} · </small>
                      <span className={`tag ${tone(t.ecApproval)}`}>EC {t.ecApproval || 'Pending'}</span>{' '}
                      {t.finalRequired === false ? <span className="tag green">Final not needed</span> : <span className={`tag ${tone(t.treasurerApproval)}`}>Final {t.treasurerApproval || 'Pending'}</span>}{' '}
                    </>
                  )}
                  {r.balance !== null && r.balance !== undefined && <span className="tag purple" data-testid="quote-balance">Released {inr(r.sm.released)} · balance {inr(r.balance)}</span>}
                  {linked.map((l) => <span key={l.id} className="tag blue">Paid {l.shortId} · {l.account} · {inr(l.amount)}{canRecord && <> · <button type="button" className="link-btn" data-testid="reverse-payment" onClick={(e) => { e.stopPropagation(); reverse(l); }}>Reverse</button></>}</span>)}
                  {r.part && <span className="tag orange" data-testid="part-paid">Part paid · balance {inr(r.invBal ?? r.balance)}</span>}
                  {r.skip && <><br /><small className="muted">Not recorded: {r.skip.reason}</small></>}
                </span>
                {canRecord && r.bucket === 'todo' && (
                  <span style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                    {r.payBlock ? <small className="muted" data-testid="pay-blocked" style={{ maxWidth: 260 }}>Cannot be paid: {r.payBlock}</small> : <button className="btn good" data-testid="pay-task" onClick={() => onPay?.(r.rel ? { area: 'Maintenance', link: r.rel.id, amount: r.rel.amount, vendor: r.rel.vendor, description: `${r.t.ticketNumber} · Release · ${r.t.title}` } : r.inv ? { area: 'Maintenance', link: r.inv.id, amount: r.invBal ?? (r.inv.amount - (r.credit || 0)), vendor: r.inv.vendor, description: `${r.t.ticketNumber} · ${r.t.title}${r.credit ? ` (less advance ${inr(r.credit)})` : ''}`, gstMode: Number(r.inv.gstRate) > 0 && !r.credit ? 'Included' : 'None', gstRate: Number(r.inv.gstRate) || 18 } : { area: 'Maintenance', link: r.t.ticketNumber, amount: r.balance ?? (r.t.approvedAmount || r.t.materialsCost), vendor: r.t.assignedTo || '', description: `${r.t.ticketNumber} · ${r.t.title}` })}>Pay…</button>}
                    {r.rel && r.payBlock ? <button className="btn secondary" data-testid="cancel-release" onClick={() => cancelRel(r)}>Cancel release</button> : <button className="btn secondary" onClick={() => skip(r)}>Skip</button>}
                  </span>
                )}
                {canRecord && r.bucket === 'skipped' && <button className="btn secondary" onClick={(e) => { e.stopPropagation(); removeSkip(r.skip.id); }}>Restore</button>}
              </li>
            );
          })}
        </ul>
      )}
      {(show === 'done' || show === 'skipped') && <RecentNote total={allRows.length} shown={rows.length} all={older} onToggle={() => setOlder((v) => !v)} />}
      {node}
    </div>
  );
}

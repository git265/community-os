// One source of truth for "how much may still be released or paid on this task", used by BOTH the screens (to disable buttons and
// explain why) and the storage layer (so the same rule holds no matter how a record is written).
//
//   cap        what the community has agreed to pay: the approved invoices, else the approved quotation, else nothing yet
//   committed  money already asked for or paid: every live release (not Rejected / Cancelled) + payments recorded straight against the task
//              or an invoice (payments made through a release are already inside that release)
//   remaining  cap - committed
//
// Corrections never edit history: a wrong payment is REVERSED by a matching credit row (reversalOf), a wrong release is CANCELLED with a
// reason, an approved invoice is SENT BACK for correction (only while nothing has been paid on it).
import { invoiceApproval, approvalState } from '../../modules/tickets/ticketEngine.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;
export const grossOf = (l) => r2(num(l.amount) + num(l.tdsAmount)); // what the vendor was owed: net paid + TDS held back
export const DEAD_RELEASE = ['Rejected', 'Cancelled'];
export const TOLERANCE = 0.5;

export const reversedIds = (ledger) => new Set(ledger.filter((l) => l.reversalOf).map((l) => l.reversalOf));
/** Debit rows that still count: not reversed, not an internal bookkeeping entry. */
export const liveDebits = (ledger) => { const rev = reversedIds(ledger); return ledger.filter((l) => l.type === 'Debit' && !l.internal && !rev.has(l.id)); };

/** Payments that belong to one task: tagged with its number, or paying one of its invoices / releases. */
export function taskLedger(ticket, docs, releases, ledger) {
  const ids = new Set([ticket.id, ...docs.filter((d) => d.ticketId === ticket.id).map((d) => d.id), ...releases.filter((r) => r.ticketId === ticket.id).map((r) => r.id)]);
  return liveDebits(ledger).filter((l) => (ticket.ticketNumber && l.taskRef === ticket.ticketNumber) || ids.has(l.sourceId));
}

/**
 * The money position of a task. `exceptReleaseId` leaves one release out (when that release is the one being checked).
 */
export function taskMoney(ticket, docs, releases, ledger, { exceptReleaseId = '' } = {}) {
  const mineDocs = docs.filter((d) => d.ticketId === ticket.id);
  const invoices = mineDocs.filter((d) => d.kind === 'Invoice' && d.selected !== false);
  const invApproved = r2(invoices.filter((d) => invoiceApproval(d).key === 'approved').reduce((n, d) => n + num(d.amount), 0));
  const quoteOk = approvalState(ticket, null).key === 'approved';
  const quote = mineDocs.find((d) => d.id === ticket.selectedQuotationId);
  const quoted = quoteOk ? (num(ticket.approvedAmount) || (quote ? num(quote.amount) : 0)) : 0;
  const basis = invApproved > 0 ? 'Invoice' : quoted > 0 ? 'Quotation' : 'None';
  const cap = basis === 'Invoice' ? invApproved : basis === 'Quotation' ? quoted : 0;
  const rels = releases.filter((r) => r.ticketId === ticket.id && !DEAD_RELEASE.includes(r.status) && r.id !== exceptReleaseId);
  const relIds = new Set(releases.filter((r) => r.ticketId === ticket.id).map((r) => r.id));
  const live = taskLedger(ticket, docs, releases, ledger);
  const direct = r2(live.filter((l) => !relIds.has(l.sourceId)).reduce((n, l) => n + grossOf(l), 0));
  const paid = r2(live.reduce((n, l) => n + grossOf(l), 0));
  const releasedLive = r2(rels.reduce((n, r) => n + num(r.amount), 0));
  const committed = r2(releasedLive + direct);
  const remaining = cap > 0 ? Math.max(0, r2(cap - committed)) : null; // null = nothing approved yet, the approvers decide
  return { basis, cap, invApproved, quoted, releasedLive, direct, paid, committed, remaining, closed: ['Closed', 'Cancelled'].includes(ticket.status), invoices };
}

const money = (n) => `₹${Math.round(num(n)).toLocaleString('en-IN')}`;

/** Why a (new or approved) release must not go ahead - '' when fine. */
export function releaseBlock(ticket, m, amount) {
  if (!ticket) return 'The task for this release was not found';
  if (m.closed) return `This task is ${ticket.status.toLowerCase()} - no more money can be released on it`;
  if (!(num(amount) > 0)) return 'Enter the amount to release';
  if (m.cap > 0 && m.remaining <= TOLERANCE) return `The ${m.basis.toLowerCase()} amount of ${money(m.cap)} is already fully ${m.direct > 0 && m.releasedLive === 0 ? 'paid' : 'released or paid'} (${money(m.committed)}). Nothing is left to release.`;
  if (m.cap > 0 && num(amount) > m.remaining + TOLERANCE) return `Only ${money(m.remaining)} of ${money(m.cap)} (the ${m.basis.toLowerCase()} amount) is left - ${money(m.committed)} is already released or paid`;
  return '';
}

/** What the release screen needs: can a release be asked for, how much, and if not, why. */
export function releaseAvailability(ticket, docs, releases, ledger) {
  const m = taskMoney(ticket, docs, releases, ledger);
  const why = releaseBlock(ticket, m, m.remaining ?? 1);
  return { ...m, canAsk: !why, why: m.cap > 0 && m.remaining <= TOLERANCE && !m.closed ? releaseBlock(ticket, m, 1) : m.closed ? releaseBlock(ticket, m, 1) : '' };
}

/**
 * Check a payment (ledger Debit) before it is recorded. `ctx` carries the raw lists. Returns '' when fine.
 *  - a release: it must be Approved, not already paid, and the payment cannot exceed the release
 *  - an invoice: it must be fully approved and the payments on it cannot pass the invoice amount
 *  - the task itself / a manual entry tagged to a task: needs an approved amount, and everything together cannot pass it
 */
export function paymentBlock(row, { tickets, docs, releases, ledger }) {
  if (row.type !== 'Debit' || row.internal || row.reversalOf) return '';
  const isTaskLike = row.sourceType === 'release' || row.sourceType === 'invoice' || row.sourceType === 'task' || !!row.taskRef;
  if (!isTaskLike) return '';
  const amount = grossOf(row);
  const rel = row.sourceType === 'release' ? releases.find((r) => r.id === row.sourceId) : null;
  const inv = row.sourceType === 'invoice' ? docs.find((d) => d.id === row.sourceId) : null;
  const ticket = rel ? tickets.find((t) => t.id === rel.ticketId) : inv ? tickets.find((t) => t.id === inv.ticketId) : tickets.find((t) => t.ticketNumber === row.taskRef || t.id === row.sourceId);
  if (!ticket) return row.sourceType === 'release' || row.sourceType === 'invoice' ? 'The task for this payment was not found' : '';
  const others = liveDebits(ledger).filter((l) => l.id !== row.id);
  if (row.sourceType === 'release') {
    if (!rel) return 'This release no longer exists';
    if (rel.status !== 'Approved') return rel.status === 'Paid' ? 'This release is already paid' : `This release is ${String(rel.status).toLowerCase()}, so it cannot be paid`;
    const already = others.filter((l) => l.sourceId === rel.id).reduce((n, l) => n + grossOf(l), 0);
    if (already > TOLERANCE) return `A payment of ${money(already)} is already recorded against this release`;
    if (amount > num(rel.amount) + TOLERANCE) return `The release is for ${money(rel.amount)} - the payment cannot be more (${money(amount)})`;
    if (ticket.status === 'Cancelled') return 'This task is cancelled';
    const m = taskMoney(ticket, docs, releases, ledger, { exceptReleaseId: rel.id });
    if (m.cap > 0 && m.direct + m.releasedLive + num(rel.amount) > m.cap + TOLERANCE) return `${money(m.direct)} was already paid straight against this task and ${money(m.releasedLive)} released, so paying this release would take it past the ${m.basis.toLowerCase()} amount of ${money(m.cap)}. Cancel the release instead.`;
    return '';
  }
  if (ticket.status === 'Cancelled') return 'This task is cancelled - reverse or cancel its money first';
  const m = taskMoney(ticket, docs, releases, ledger);
  if (inv) {
    if (invoiceApproval(inv).key !== 'approved') return 'This invoice is not fully approved yet';
    const onInv = others.filter((l) => l.sourceId === inv.id).reduce((n, l) => n + grossOf(l), 0);
    if (onInv + amount > num(inv.amount) + TOLERANCE) return `This invoice is ${money(inv.amount)} and ${money(onInv)} is already paid on it - only ${money(Math.max(0, num(inv.amount) - onInv))} is left`;
  }
  if (m.cap <= 0) return 'Nothing is approved for this task yet (no approved quotation or invoice), so it cannot be paid';
  if (m.committed + amount > m.cap + TOLERANCE) return `Only ${money(m.remaining)} of ${money(m.cap)} (the ${m.basis.toLowerCase()} amount) is left - ${money(m.committed)} is already released or paid`;
  return '';
}

/** Fields of a recorded payment that can never be edited (history stays; mistakes are reversed, not overwritten). */
export const PAYMENT_LOCKED = ['amount', 'type', 'account', 'sourceId', 'sourceType', 'tdsAmount', 'tdsRate', 'tdsSection', 'reversalOf', 'baseAmount', 'gstAmount', 'gstRate'];

/** Why a reversal is not allowed - '' when it is. */
export function reversalBlock(orig, reversalRow, ledger) {
  if (!orig) return 'The payment to reverse was not found';
  if (orig.type !== 'Debit') return 'Only a payment (debit) can be reversed';
  if (reversedIds(ledger).has(orig.id)) return 'This payment has already been reversed';
  if (orig.reconStatus === 'Matched') return 'This payment is matched to a bank statement line, so the money really left. Record the refund when it arrives, or undo the match first.';
  if (!String(reversalRow.reason || '').trim()) return 'Say why the payment is being reversed';
  if (Math.abs(num(reversalRow.amount) - num(orig.amount)) > TOLERANCE) return 'A reversal must be for the full amount of the payment';
  if (reversalRow.account !== orig.account) return 'A reversal goes back to the same bank account';
  return '';
}

const isApproved = (d) => invoiceApproval(d).key === 'approved';
const ticketApproved = (t) => approvalState(t, null).key === 'approved';

/**
 * The rules, applied by the storage layer to every write (so a screen, an import or a console call all hit the same wall).
 * `list(collection)` returns raw rows. Returns an error message, or '' when the write may go ahead.
 */
export async function moneyPreWrite({ collection, record, old, op, list }) {
  const C = { RELEASES: 'releases', LEDGER: 'ledger', QUOTATIONS: 'quotations', TICKETS: 'tickets' };
  if (!Object.values(C).includes(collection)) return '';
  const keysChanged = (a, b, keys) => keys.filter((k) => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null));

  if (collection === C.RELEASES) {
    if (op === 'delete' || !record?.ticketId) return ''; // cultural releases have their own cap (expense amount)
    const [tickets, docs, releases, ledger] = await Promise.all([list('tickets'), list('quotations'), list('releases'), list('ledger')]);
    const ticket = tickets.find((t) => t.id === record.ticketId);
    const m = taskMoney(ticket || {}, docs, releases, ledger, { exceptReleaseId: record.id });
    const st = record.status; const was = old?.status;
    if (!old || (st === 'Approved' && was !== 'Approved') || (st === 'Waiting approval' && was === 'Rejected')) return releaseBlock(ticket, m, record.amount);
    if (st === 'Paid' && was !== 'Paid') {
      const rows = liveDebits(ledger).filter((l) => l.sourceId === record.id);
      const paid = rows.reduce((n, l) => n + grossOf(l), 0);
      return paid + TOLERANCE >= num(record.amount) ? '' : 'A release becomes Paid only when its payment is recorded in full (Billing → Payments)';
    }
    if (st === 'Cancelled' && was !== 'Cancelled') {
      if (!['Waiting approval', 'Approved'].includes(was)) return 'Only a release that is not yet paid can be cancelled - reverse its payment first';
      if (!String(record.cancelReason || '').trim()) return 'Say why the release is cancelled';
      return liveDebits(ledger).some((l) => l.sourceId === record.id) ? 'A payment is recorded against this release - reverse it first' : '';
    }
    if (st === 'Approved' && was === 'Paid') return liveDebits(ledger).some((l) => l.sourceId === record.id) ? 'This release still has a payment recorded - reverse the payment first' : '';
    return '';
  }

  if (collection === C.LEDGER) {
    const [tickets, docs, releases, ledger] = await Promise.all([list('tickets'), list('quotations'), list('releases'), list('ledger')]);
    const taskLike = (r) => r && r.type === 'Debit' && !r.internal && (r.taskRef || ['release', 'invoice', 'task'].includes(r.sourceType));
    if (op === 'delete') {
      if (taskLike(old)) return 'A recorded payment cannot be deleted. Reverse it (it stays in the history) and record it again if needed.';
      if (old?.reversalOf) return 'A reversal cannot be deleted';
      return '';
    }
    if (record.reversalOf) {
      if (old) return 'A reversal cannot be changed';
      return reversalBlock(ledger.find((l) => l.id === record.reversalOf), record, ledger);
    }
    if (!old) return paymentBlock(record, { tickets, docs, releases, ledger });
    if (taskLike(old)) {
      const bad = keysChanged(old, record, PAYMENT_LOCKED).filter((k) => !(k === 'tdsAmount' && !old[k] && !record[k]));
      if (bad.length) return 'A recorded payment’s amount, account and link cannot be edited. Reverse it and record it again.';
      if (old.taskRef && record.taskRef !== old.taskRef) return 'A payment cannot be moved to another task. Reverse it and record it again.';
    }
    if (old && !old.taskRef && record.taskRef && record.type === 'Debit') return paymentBlock({ ...record, id: record.id }, { tickets, docs, releases, ledger });
    return '';
  }

  if (collection === C.QUOTATIONS) {
    const ledger = await list('ledger');
    const live = liveDebits(ledger).filter((l) => l.sourceId === (old?.id || record?.id));
    if (op === 'delete') {
      if (live.length) return 'Payments are recorded against this document - reverse them first';
      if (old?.kind === 'Invoice' && isApproved(old)) return 'An approved invoice cannot be deleted. Send it back for correction first.';
      if (old?.kind !== 'Invoice') {
        const [tickets, docs, releases] = await Promise.all([list('tickets'), list('quotations'), list('releases')]);
        const t = tickets.find((x) => x.id === old.ticketId);
        if (t && t.selectedQuotationId === old.id && taskMoney(t, docs, releases, ledger).committed > 0) return 'Money has been released or paid against this quotation - cancel the releases / reverse the payments first';
      }
      return '';
    }
    if (old?.kind === 'Invoice' && isApproved(old) && !isApproved(record)) {
      if (live.length) return 'Payments are recorded against this invoice - reverse them before sending it back for correction';
      if (!String(record.correctionNote || '').trim()) return 'Say what is being corrected on the invoice';
    }
    return '';
  }

  if (collection === C.TICKETS && old) {
    const touchesMoney = record.status === 'Cancelled' && old.status !== 'Cancelled'
      || (ticketApproved(old) && !ticketApproved(record))
      || (num(record.approvedAmount) < num(old.approvedAmount) - TOLERANCE)
      || (record.selectedQuotationId !== old.selectedQuotationId && ticketApproved(old));
    const closing = record.status === 'Closed' && old.status !== 'Closed';
    if (!touchesMoney && !closing) return '';
    const [docs, releases, ledger] = await Promise.all([list('quotations'), list('releases'), list('ledger')]);
    const m = taskMoney(old, docs, releases, ledger);
    if (closing) {
      const open = releases.filter((r) => r.ticketId === old.id && ['Waiting approval', 'Approved'].includes(r.status));
      return open.length ? `${open.length} release${open.length === 1 ? ' is' : 's are'} still waiting or unpaid - pay or cancel ${open.length === 1 ? 'it' : 'them'} before closing the task` : '';
    }
    if (record.status === 'Cancelled') return m.committed > TOLERANCE ? `${money(m.committed)} is released or paid on this task - cancel the releases and reverse the payments before cancelling it` : '';
    if (num(record.approvedAmount) < num(old.approvedAmount) - TOLERANCE && num(record.approvedAmount) + TOLERANCE < m.committed) return `${money(m.committed)} is already released or paid - the approved amount cannot go below it`;
    if (m.committed > TOLERANCE && (ticketApproved(old) && !ticketApproved(record) || record.selectedQuotationId !== old.selectedQuotationId)) return `${money(m.committed)} is already released or paid on this approval - cancel the releases and reverse the payments before undoing it`;
    return '';
  }
  return '';
}

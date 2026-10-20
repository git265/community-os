// Fund releases for a task (pure maths; the panel and Payments both use it).
//   One kind of request: the requester or EC asks for money at any stage, with or without a quotation or invoice.
//   The amount is prefilled from the approved invoice, else the approved quotation; once either is approved the total released cannot pass it.
//   Every release goes through the 'Maintenance release' approval rules. Older records may carry kind Advance / Stage.
import { invoiceApproval } from '../../modules/tickets/ticketEngine.js';
import { taskMoney, releaseBlock } from './moneyGuard.js';

const sum = (arr) => arr.reduce((n, r) => n + (Number(r.amount) || 0), 0);
const r2 = (n) => Math.round(n * 100) / 100;

export function releaseSummary(ticket, releases, docs, tolerancePct = 0, ledger = []) {
  const mine = releases.filter((r) => r.ticketId === ticket.id && !['Rejected', 'Cancelled'].includes(r.status));
  const approved = Number(ticket.approvedAmount) || 0;
  const ceiling = Number(ticket.advanceCeiling) || 0;
  const released = sum(mine); const paid = sum(mine.filter((r) => r.status === 'Paid'));
  const advanced = sum(mine.filter((r) => r.kind === 'Advance'));
  const invoices = docs.filter((d) => d.ticketId === ticket.id && d.kind === 'Invoice' && d.selected !== false);
  const invApproved = sum(invoices.filter((d) => invoiceApproval(d).key === 'approved'));
  // paid releases are credited against the invoices, in the order they were uploaded
  let pool = paid; const credits = {};
  [...invoices].sort((a, b) => String(a.quoteDate).localeCompare(String(b.quoteDate)) || String(a.shortId).localeCompare(String(b.shortId))).forEach((d) => { const c = Math.min(Number(d.amount) || 0, pool); credits[d.id] = r2(c); pool -= c; });
  const unsettled = Math.max(0, r2(paid - invApproved));
  const settled = paid <= 0 || !!ticket.advanceSettled || unsettled <= (paid * (Number(tolerancePct) || 0)) / 100 + 0.5;
  // what a new release is measured against: approved invoices first, else the approved quotation, else nothing (the approvers decide)
  // Same numbers the storage layer enforces (moneyGuard): the approved invoices first, else the approved quotation; money already
  // released AND money paid straight from Payments both count, so nothing can be asked for twice.
  const m = taskMoney(ticket, docs, releases, ledger);
  const basis = m.basis; const cap = m.cap;
  const capLeft = m.remaining ?? 0;
  const suggest = cap > 0 ? capLeft : 0;
  const askBlock = cap > 0 || m.closed ? releaseBlock(ticket, m, cap > 0 ? Math.max(capLeft, 1) : 1) : '';
  return { askBlock, directPaid: m.direct, committed: m.committed, basis, cap, capLeft, suggest, approved, ceiling, released, paid, advanced, left: Math.max(0, r2(approved - released)), advLeft: Math.max(0, r2(ceiling - advanced)), invoices, invApproved, credits, unsettled, settled, hasReleases: mine.length > 0 };
}

/** Why a release cannot be asked for (or '' when it can). Anyone allowed to ask may do so at any stage; the cap applies only once a quotation or invoice is approved. */
export function releaseProblem(amount, sum_) {
  const a = Number(amount) || 0;
  if (!(a > 0)) return 'Enter the amount to release';
  if (sum_.cap > 0 && a > sum_.capLeft + 0.5) return `Only ${sum_.capLeft.toLocaleString('en-IN')} of ${sum_.cap.toLocaleString('en-IN')} (the ${sum_.basis.toLowerCase()} amount) is left to release`;
  return '';
}

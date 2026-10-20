// One task's money position: what was approved, invoiced, released and actually paid.
// Used by the close rule (a requester cannot close while money is owed) and the Reconciliation screen.
import { invoiceApproval, approvalState } from '../../modules/tickets/ticketEngine.js';
import { liveDebits } from './moneyGuard.js';

const sum = (a) => a.reduce((n, x) => n + (Number(x.amount) || 0), 0);
const r2 = (n) => Math.round(n * 100) / 100;

/** ledger rows that belong to this task: tagged with its number, or paying one of its invoices / releases. */
export function taskPayments(ticket, docs, releases, ledger) {
  const ids = new Set([...docs.filter((d) => d.ticketId === ticket.id).map((d) => d.id), ...releases.filter((r) => r.ticketId === ticket.id).map((r) => r.id), ticket.id]);
  return liveDebits(ledger).filter((l) => (l.taskRef === ticket.ticketNumber || ids.has(l.sourceId)));
}

export function moneyPosition(ticket, docs, releases, ledger, tolerancePct = 0) {
  const mine = docs.filter((d) => d.ticketId === ticket.id);
  const quote = mine.find((d) => d.id === ticket.selectedQuotationId);
  const quoteOk = approvalState(ticket, null).key === 'approved';
  const quoted = quoteOk ? Number(ticket.approvedAmount) || (quote ? Number(quote.amount) || 0 : 0) : 0;
  const invoices = mine.filter((d) => d.kind === 'Invoice' && d.selected !== false);
  const invoiced = sum(invoices.filter((d) => invoiceApproval(d).key === 'approved'));
  const invoicedAll = sum(invoices);
  const rel = releases.filter((r) => r.ticketId === ticket.id && r.status !== 'Rejected');
  const released = sum(rel.filter((r) => r.status === 'Approved' || r.status === 'Paid'));
  const paid = sum(taskPayments(ticket, docs, releases, ledger));
  // what the community has agreed to pay: the approved invoices, else the approved quotation, else only what was released
  const due = invoiced > 0 ? Math.max(invoiced, released) : quoted > 0 ? Math.max(quoted, released) : released;
  const owed = r2(Math.max(0, due - paid));
  const over = r2(paid - due);
  const tol = (due * (Number(tolerancePct) || 0)) / 100 + 0.5;
  return { quoted, invoiced, invoicedAll, released, paid, due, owed, overpaid: over > tol ? over : 0, over, hasMoney: due > 0 || paid > 0 };
}

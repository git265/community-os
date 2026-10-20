// Delete rules in one place: which records may be erased, and why not.
// A record that has money attached (a payment in the ledger) is a financial record: it is never erased, only reversed
// by the Treasurer and then closed / rejected, so the books always explain themselves.
import { storage, COLLECTIONS as C } from './storage/index.js';

/** Ledger rows (payments) attached to a record. */
export async function paymentsAttached(collection, record) {
  if (!record?.id) return [];
  const ledger = (await storage.list(C.LEDGER)).filter((l) => !l.internal);
  if (collection === C.TICKETS) return ledger.filter((l) => l.taskRef === record.ticketNumber);
  if (collection === C.CULTURAL_EXPENSES) {
    const rels = (await storage.list(C.RELEASES)).filter((r) => r.expenseId === record.id).map((r) => r.id);
    const keys = [record.id, ...rels];
    return ledger.filter((l) => keys.some((k) => String(l.sourceId || '').includes(k)));
  }
  return [];
}

const WHAT = { [C.TICKETS]: 'task', [C.CULTURAL_EXPENSES]: 'expense' };
const NEXT = {
  [C.TICKETS]: 'To take this task out of use, set its status to Cancelled instead. The Treasurer should first record a refund or reversal in Payments if money has to come back.',
  [C.CULTURAL_EXPENSES]: 'To take it out of the event totals, ask the Treasurer to record a refund or reversal in Payments, then mark the expense Rejected. The entry stays as history.',
};

/** { blocked, message, payments } for the delete button of a record. */
export async function deleteVerdict(collection, record) {
  const payments = await paymentsAttached(collection, record);
  if (!payments.length) return { blocked: false, payments };
  const ids = payments.slice(0, 3).map((p) => p.shortId).join(', ') + (payments.length > 3 ? '…' : '');
  return { blocked: true, payments, message: `Delete is not available: ${payments.length} payment${payments.length === 1 ? '' : 's'} (${ids}) ${payments.length === 1 ? 'is' : 'are'} recorded against this ${WHAT[collection] || 'record'}. Payments are financial records and are never erased. ${NEXT[collection] || ''}`.trim() };
}

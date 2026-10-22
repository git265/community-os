// Money checks (reconciliation) on the back end: the server compares receipts, bills, paid orders, refunds, the books and the units' credit,
// and keeps what does not add up as an issue for the treasurer. The browser demo has no such records (it shows the task checks only).
import { apiFetch, failureOf } from './net/request.js';
import { getDataSource } from './storage/dataSource.js';

export const reconOnServer = () => getDataSource().mode === 'v2';
export const KIND_LABEL = {
  'late-capture': 'Money captured after the payment closed', 'duplicate-capture': 'Paid twice', 'amount-mismatch': 'Captured amount differs from the bill',
  'allocation-mismatch': 'Receipt not fully placed', 'bill-paid-mismatch': 'Bill paid amount differs from its receipts', 'refund-unanswered': 'Refund not answered by the bank',
  'ledger-unbalanced': 'Books do not balance', 'credit-mismatch': 'Unit credit differs from the books',
};
async function call(path, init) {
  const res = await apiFetch(`/v1/billing/recon-issues${path}`, init);
  if (!res.ok) throw await failureOf(res, 'money checks');
  return res.json();
}
export const listIssues = (status = '') => call(status ? `?status=${encodeURIComponent(status)}` : '');
export const runChecks = () => call('/run', { method: 'POST' });
export const resolveIssue = (issue, status, note) => call(`/${issue.id}/resolve`, { method: 'POST', body: JSON.stringify({ status, note }), headers: { 'If-Match': `"${issue.version}"` } });

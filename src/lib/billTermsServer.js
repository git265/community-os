// Terms text for messages (notifications, e-mail, SMS, notices): tax breakdown + highlighted due date + how a late fee applies.
// Loads the community's late-fee rule once and appends the same wording the screens show (lib/billText.js).
import { lateFeeSettings } from './finance/rules.js';
import { billTermsText } from './billText.js';

import { getCommunity } from './community.js';
// The late-fee rule is read each time (no cache: a changed rule shows in the very next message). A caller that writes many messages in a row
// (payment reminders) can pass `settings` it read once for the whole run.
export async function termsFor(due, { showPenalty = true, settings } = {}) {
  let rule = settings;
  if (rule === undefined) { try { rule = await lateFeeSettings(); } catch { rule = null; } }
  const body = billTermsText({ due, amount: due.amount, flatTax: due.tax, rate: due.gstRate, mode: due.gstMode, dueDate: due.dueDate, status: due.status, settings: rule, showPenalty });
  return body ? `\n\n${body}` : '';
}

// Payment reminders for every kind of due (maintenance, water, DG, any utility, other).
// Rules live in one Finance-settings row: on/off, how often, how early to start, and the maximum number of nudges.
// The wording is the editable "Payment reminder" notice template (Communications -> Notice templates).
// runDueReminders() is idempotent: it is called by the 5-minute scheduler in App and by the "Send reminders now" button.
import { storage, COLLECTIONS } from './storage/index.js';
import { notifyMany, billAudience } from './notify.js';
import { logEvent } from './audit/auditLog.js';
import { termsFor } from './billTermsServer.js';
import { fmtDate } from './locale.js';

export const REMINDER_DEFAULTS = { reminderEnabled: true, reminderEveryDays: 7, reminderLeadDays: 3, reminderMax: 4 };
const DAY = 86400000;
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const dmy = (s) => fmtDate(s);
export const DEFAULT_REMINDER_BODY = 'Dear owner of {{UNIT}},\n\nThis is a reminder that your {{UTILITY_TYPE}} bill {{BILL_NO}} of {{AMOUNT}} for {{MONTH}} is {{WHEN}} (payable by {{DUE_DATE}}).\nPlease pay it from the portal or at the office.\n\nThank you,\n{{SOCIETY_NAME}} Management';

export async function reminderSettings() {
  const row = (await storage.list(COLLECTIONS.FINANCE_SETTINGS))[0] || {};
  const pick = (k) => (row[k] === undefined || row[k] === '' || row[k] === null ? REMINDER_DEFAULTS[k] : row[k]);
  return { enabled: pick('reminderEnabled') !== false, everyDays: Math.max(1, Number(pick('reminderEveryDays')) || 7), leadDays: Math.max(0, Number(pick('reminderLeadDays')) || 0), max: Math.max(1, Number(pick('reminderMax')) || 4) };
}

export const toISODate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Which unpaid dues are due a reminder right now. force = ignore the on/off switch, the frequency and the lead time (manual "send now"). */
export function dueForReminder(dues, s, now = new Date(), force = false) {
  const today = new Date(`${toISODate(now)}T00:00:00`).getTime();
  return dues.filter((d) => {
    if (d.status === 'Paid' || !(Number(d.amount) > 0) || !d.unit) return false;
    if (force) return true;
    if ((d.reminderCount || 0) >= s.max) return false;
    const due = d.dueDate ? new Date(`${d.dueDate}T00:00:00`).getTime() : NaN;
    if (Number.isFinite(due) && today < due - s.leadDays * DAY) return false;
    const last = d.reminderSentAt ? new Date(d.reminderSentAt).getTime() : NaN;
    if (Number.isFinite(last) && now.getTime() - last < s.everyDays * DAY - 60000) return false;
    return true;
  });
}

function wording(due, society, now, tpl) {
  const today = toISODate(now);
  const late = due.dueDate && due.dueDate < today;
  const days = late ? Math.round((new Date(`${today}T00:00:00`) - new Date(`${due.dueDate}T00:00:00`)) / DAY) : 0;
  const map = {
    '{{UNIT}}': due.unit, '{{AMOUNT}}': inr(due.amount), '{{MONTH}}': due.billedMonth || '', '{{DUE_DATE}}': dmy(due.dueDate), '{{UTILITY_TYPE}}': due.category === 'Maintenance' ? 'maintenance' : due.category,
    '{{BILL_NO}}': due.shortId || '', '{{WHEN}}': late ? `overdue by ${days} day${days === 1 ? '' : 's'}` : 'coming up', '{{SOCIETY_NAME}}': society, '{{DAYS_OVERDUE}}': String(days),
  };
  const fill = (t) => Object.entries(map).reduce((x, [k, v]) => x.split(k).join(v), t || '');
  return { title: fill(`${tpl?.headerText && !/SOCIETY_NAME/.test(tpl.headerText) ? tpl.headerText : '{{UTILITY_TYPE}} payment reminder · {{BILL_NO}}'}`), body: fill(tpl?.body || DEFAULT_REMINDER_BODY) };
}

export async function runDueReminders({ force = false, only = null, now = new Date(), actor = 'System · payment reminders' } = {}) {
  const s = await reminderSettings();
  if (!force && !s.enabled) return 0;
  const all = await storage.list(COLLECTIONS.DUES);
  const list = dueForReminder(only ? all.filter(only) : all, s, now, force);
  if (!list.length) return 0;
  const society = (await storage.list(COLLECTIONS.MERGE_FIELDS)).find((m) => m.token === '{{SOCIETY_NAME}}')?.defaultValue || 'Community';
  const tpl = (await storage.list(COLLECTIONS.NOTICE_TEMPLATES)).find((t) => t.appliesTo === 'Payment reminder');
  // one batch: every reminder is written in a single go (thousands of one-by-one writes would rewrite the whole dues list each time)
  const terms = new Map(); for (const d of list) terms.set(d.id, await termsFor(d));
  const to = await billAudience();   // the person the bill is addressed to, not everyone on the unit
  await notifyMany(list.flatMap((d) => { const w = wording(d, society, now, tpl); return to(d.unit, d.billTo).map((a) => ({ event: 'payment_reminder', title: w.title, body: w.body + (terms.get(d.id) || ''), link: '', kind: 'payment_reminder', by: actor, ...a })); }));
  await storage.putMany(COLLECTIONS.DUES, list.map((d) => ({ ...d, reminderSentAt: now.toISOString(), reminderCount: (d.reminderCount || 0) + 1 })));
  await logEvent({ who: actor, what: 'Billing & Finance', action: 'Update', summary: `Payment reminder sent for ${list.length} unpaid bill${list.length === 1 ? '' : 's'}${force ? ' (sent manually)' : ''}` });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.DUES } }));
  return list.length;
}

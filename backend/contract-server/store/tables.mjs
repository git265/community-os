// Where each collection lives. Collections not listed here are ordinary rows of the generic `documents` table.
//
//   table  the real table (see backend/db/V5__typed_tables.sql)
//   text   JSON key -> column for TEXT columns that mean exactly the same as `data->>key` (an empty text is stored as NULL, which reads the same).
//          Filters, row scope and sorting on these keys use the column and its index instead of digging into the JSON.
//   sort   JSON key -> typed column (date / timestamp / number) used for ORDER BY and date ranges
//
// Same table in the Spring service: CollectionMapping (adapter/persistence/typed). Keep the two in step.
const t = (table, text = {}, sort = {}) => ({ table, text, sort });

export const TYPED = {
  properties: t('units', { unit: 'unit', zone: 'zone', type: 'unit_type', occupancy: 'occupancy' }),
  users: t('users', { name: 'full_name', roleId: 'role_id', status: 'status' }),
  dues: t('dues', { unit: 'unit', status: 'status', category: 'category', billedMonth: 'billed_month' }, { dueDate: 'due_date', amount: 'amount' }),
  amenities: t('bookings', { amenity: 'amenity', unit: 'unit', slot: 'slot', status: 'status', paymentStatus: 'payment_status', paymentRef: 'payment_ref' }, { date: 'booking_date', totalPayable: 'total_payable' }),
  tickets: t('tickets', { unit: 'unit', status: 'status', scope: 'scope', taskType: 'task_type', category: 'category', priority: 'priority', assignedTo: 'assigned_to' }, { createdAt: 'opened_at', slaDueAt: 'sla_due_at' }),
  ledger: t('ledger_entries', { type: 'entry_type', account: 'account', category: 'category', unit: 'unit', reconStatus: 'recon_status', sourceType: 'source_type', sourceId: 'source_id' }, { date: 'entry_date', amount: 'amount' }),
  audit: { ...t('audit_log', { action: 'action', collection: 'collection', unit: 'unit', recordId: 'record_id', recordShortId: 'record_short_id', who: 'who', whoName: 'who_name', shortId: 'short_id', ip: 'ip', requestId: 'request_id' }, { when: 'at' }), appendOnly: true },
};
// columns that hold a calendar DATE (not a timestamp): a date range on them compares dates
export const DATE_COLUMNS = new Set(['due_date', 'booking_date', 'entry_date']);
export const isTyped = (collection) => Object.prototype.hasOwnProperty.call(TYPED, collection);
export const ALL_TABLES = ['documents', ...Object.values(TYPED).map((x) => x.table)];

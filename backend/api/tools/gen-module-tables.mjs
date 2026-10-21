// Generates V6__module_tables.sql: a real, typed PostgreSQL table for every remaining CommunityOS object, from the field definitions the app
// already has (legacy-schemas.json = the schema registry exported by the old rule book). Run:  node tools/gen-module-tables.mjs
//
// Rules (one place, so every table follows them):
//   - standard columns: community_id, id (uuid), short_id, <fields>, custom jsonb, version, created_at/by, updated_at/by (stamped by triggers, V9)
//   - field types: number -> numeric(14,2) for money, integer for counts, numeric otherwise; date -> date; *At -> timestamptz; time -> time;
//     boolean; tags / roles -> text[]; files / people / specs -> jsonb; phone -> E.164 checked text; everything else -> text
//   - references become uuid columns with foreign keys: *Id fields to their object, the `unit` field to property.unit, and the "who" fields
//     (author, voter, approvedBy, paidBy ...) to identity.membership - so a name can never be typed in by the client
//   - select options are NOT database CHECKs: communities edit them in Studio; the API validates against config.field_definition
//   - high-volume time series are partitioned by month on created_at (see PARTITIONED)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemas = JSON.parse(fs.readFileSync(path.join(here, 'legacy-schemas.json'), 'utf8'));
const constants = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'spring', 'src', 'main', 'resources', 'rulebook', 'constants.json'), 'utf8'));
const prefixes = constants.shortPrefixes || {};

// collection -> schema.table ; collections handled by hand-written migrations are listed in HAND and skipped here
const HAND = new Set(['communities', 'communityConfig', 'users', 'roles', 'roleGroups', 'userProfiles', 'portalInvites', 'blocks', 'facilities', 'properties',
  'dues', 'unitCredits', 'funds', 'audit', 'schema', 'files']);
const TABLE = {
  tickets: 'maintenance.ticket', taskTypes: 'maintenance.task_type', ticketComments: 'maintenance.ticket_comment', quickPhrases: 'maintenance.quick_phrase',
  tradeAvailability: 'maintenance.trade_availability', handymen: 'maintenance.field_staff', categoryMap: 'maintenance.category_coverage', wishes: 'maintenance.wish',
  serviceNotices: 'maintenance.service_notice', eventWork: 'maintenance.event_work', quotations: 'maintenance.quotation', approverSettings: 'maintenance.approver_setting',
  billingTemplates: 'billing.utility_rate_card', levies: 'billing.levy', demandNotices: 'billing.demand_notice', recurringBills: 'billing.recurring_bill',
  readings: 'billing.meter_reading', utilityTypes: 'billing.utility_type', taxSettings: 'billing.tax_setting', taxComponents: 'billing.tax_component',
  paymentRouting: 'billing.payment_routing', payRequests: 'finance.pay_request', ledger: 'finance.cash_book_entry', bankAccounts: 'finance.bank_account',
  bankTxns: 'finance.bank_txn', deposits: 'finance.deposit', budgetLines: 'finance.budget_line', fixedExpenses: 'finance.fixed_expense', ledgerSkips: 'finance.ledger_skip',
  importProfiles: 'finance.import_profile', financeSettings: 'finance.finance_setting', cashCounts: 'finance.cash_count', releases: 'finance.release',
  approvalPolicies: 'finance.approval_policy', assocBills: 'finance.association_bill',
  vendors: 'vendor.vendor', vendorServices: 'vendor.service_line', vendorComments: 'vendor.comment', serviceContacts: 'vendor.service_contact', contactReviews: 'vendor.contact_review',
  amenityTypes: 'amenity.amenity_type', amenities: 'amenity.booking', amenitySettings: 'amenity.setting', amenityItems: 'amenity.item',
  gatePeople: 'gate.person', gateLinks: 'gate.household_link', gatePasses: 'gate.pass', gateVisits: 'gate.visit', gateApprovals: 'gate.approval', gateFlags: 'gate.flag',
  gateVehicles: 'gate.vehicle', gateWorkOrders: 'gate.work_order', gateVillaRules: 'gate.unit_rule', gatePassTemplates: 'gate.pass_template', gateCheckpoints: 'gate.checkpoint',
  gateRounds: 'gate.round', gateScans: 'gate.scan', gatePulse: 'gate.console_pulse', gateSettings: 'gate.setting', incidents: 'gate.incident',
  notificationTemplates: 'comms.notification_template', notificationPrefs: 'comms.notification_pref', notificationSettings: 'comms.notification_setting',
  notificationOutbox: 'comms.outbox_message', broadcasts: 'comms.broadcast', noticeTemplates: 'comms.notice_template', mergeFields: 'comms.merge_field',
  forum: 'comms.forum_topic', forumPosts: 'comms.forum_post', pollVotes: 'comms.poll_vote', numberSections: 'comms.number_section', importantNumbers: 'comms.important_number',
  meetings: 'governance.meeting', ecRoles: 'governance.ec_role', subcommittees: 'governance.subcommittee', approvals: 'governance.approval',
  ballots: 'governance.ballot', voteRoll: 'governance.vote_roll', ballotBox: 'governance.ballot_box',
  culturalEvents: 'cultural.event', culturalPrograms: 'cultural.program', culturalSevas: 'cultural.seva', culturalOfferings: 'cultural.offering',
  culturalDonations: 'cultural.donation', culturalExpenses: 'cultural.expense', culturalBrochure: 'cultural.brochure_page', culturalPhotos: 'cultural.photo',
  workforce: 'workforce.member', attendance: 'workforce.attendance_session', attendanceSettings: 'workforce.attendance_setting', siteHolidays: 'workforce.site_holiday',
  siteServices: 'workforce.site_service', siteCalendar: 'workforce.site_calendar_rule', shifts: 'workforce.shift',
  infraPlans: 'assets.site_plan', infraLayers: 'assets.map_layer', mapVersions: 'assets.map_version', infraLog: 'assets.condition_log', logTypes: 'assets.log_type',
  logEntries: 'assets.log_entry', plantLogs: 'assets.plant_log', dgFuelLogs: 'assets.dg_fuel_log', equipment: 'assets.equipment', inventory: 'assets.inventory_item',
  inventoryRules: 'assets.inventory_rule', villaImportRules: 'assets.unit_meter_import_rule', audits: 'assets.facility_audit', electricityBills: 'assets.electricity_bill',
  villaElectricity: 'assets.unit_electricity',
  docFolders: 'docs.folder', documents: 'docs.document',
  reportSchedules: 'reports.schedule', reportRuns: 'reports.run',
};
// objects with no field definitions in the registry: their columns are given here
const EXTRA_FIELDS = {
  notificationPrefs: [['membershipId', 'ref:membership'], ['whatsapp', 'boolean'], ['sms', 'boolean'], ['email', 'boolean']],
  notificationSettings: [['events', 'jsonb']],
  gatePulse: [['guardId', 'ref:membership'], ['lastAt', 'timestamptz'], ['kind', 'text']],
};
// high-volume, time-ordered: partitioned by month (PK must include the partition key, so nothing can hold a foreign key TO these)
const PARTITIONED = new Set(['gateVisits', 'gateScans', 'notificationOutbox']);

// *Id fields -> the object they point at
const REF = {
  wishId: 'wishes', assetId: 'equipment', selectedQuotationId: 'quotations', selectedInvoiceId: 'quotations', ticketId: 'tickets', staffId: 'handymen',
  levyId: 'levies', readingId: 'readings', matchedLedgerId: 'ledger', expenseId: 'culturalExpenses', bankTxnId: 'bankTxns', logId: 'logTypes', planId: 'infraPlans',
  scheduleId: 'reportSchedules', auditorVendorId: 'vendors', contactId: 'serviceContacts', registryId: 'gatePeople', personId: 'gatePeople', passId: 'gatePasses',
  workOrderId: 'gateWorkOrders', approvalId: 'gateApprovals', visitId: 'gateVisits', roundId: 'gateRounds', checkpointId: 'gateCheckpoints', vendorId: 'vendors',
  dueId: 'dues', broadcastId: 'broadcasts', ballotId: 'ballots', topicId: 'forum', convertedTicketId: 'tickets', eventId: 'culturalEvents', fileId: 'files',
  donationId: 'culturalDonations', offeringId: 'culturalOfferings', documentId: 'documents', folderId: 'docFolders',
};
const SELF_PARENT = { forumPosts: 'forumPosts', docFolders: 'docFolders' };   // parentId
const HAND_TARGET = { dues: 'billing.due', files: 'docs.file_object', units: 'property.unit', membership: 'identity.membership', role: 'identity.role' };
const POLYMORPHIC = new Set(['sourceId', 'recordId']);                       // id of "some record": uuid, no foreign key (with a *_type column)
const ID_ARRAYS = new Set(['selectedQuotationIds', 'rosterIds', 'checkpointIds']);
const ROLE_REFS = new Set(['authorRoleId', 'createdByRole', 'raisedByRole']);
const ROLE_ARRAYS = new Set(['roleIds', 'extraRoleIds']);
// "who" fields: the person is a membership of the community, set by the server from the token
const WHO = new Set(['author', 'voter', 'uploadedBy', 'addedBy', 'raisedBy', 'createdBy', 'approvedBy', 'ecApprovedBy', 'treasurerApprovedBy', 'finalApprovedBy',
  'answeredBy', 'paidBy', 'cancelledBy', 'verifiedBy', 'resolvedBy', 'creditedBy', 'decidedBy', 'sentBy', 'publishedBy', 'closedBy', 'receivedBy', 'recordedBy', 'checkedBy']);
const DROP = new Set(['createdAt', 'createdStamp', 'shortId', 'recVersion', 'updatedAt', 'id']);   // the standard columns carry these
const STANDARD = new Set(['community_id', 'id', 'short_id', 'custom', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by']);
const MONEY = /(amount|rate|cost|price|total|fee|deposit|balance|gst|tax|budget|spent|value|charge|payable|refund|ceiling|paid|credit|debit|salary|wage|limit)$/i;
const COUNT = /^(count|capacity|needed|seq|quantity|qty|peopleCount|sortOrder|minNoticeHours|maxAdvanceDays|reminderCount|attempts|usedCount|guestCap|peoplePerUnit|people|days|order|rank|year|month|members|lateMin|graceMinutes|radiusM|waitSeconds|graceSeconds)$/;

// PostgreSQL reserved words cannot be plain column names: `order` -> `order_value` (taken from pg_get_keywords(), catcode R and T)
const RESERVED = new Set('all,analyse,analyze,and,any,array,as,asc,asymmetric,authorization,binary,both,case,cast,check,collate,collation,column,concurrently,constraint,create,cross,current_catalog,current_date,current_role,current_schema,current_time,current_timestamp,current_user,default,deferrable,desc,distinct,do,else,end,except,false,fetch,for,foreign,freeze,from,full,grant,group,having,ilike,in,initially,inner,intersect,into,is,isnull,join,lateral,leading,left,like,limit,localtime,localtimestamp,natural,not,notnull,null,offset,on,only,or,order,outer,overlaps,placing,primary,references,returning,right,select,session_user,similar,some,symmetric,system_user,table,tablesample,then,to,trailing,true,union,unique,user,using,variadic,verbose,when,where,window,with'.split(','));
const snake0 = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
const snake = (k) => { const s = snake0(k); return RESERVED.has(s) ? `${s}_value` : s; };
const qualified = (collection) => (HAND_TARGET[collection] || TABLE[collection]);

function columnFor(collection, f) {
  const k = f.key; const t = f.type;
  if (DROP.has(k)) return null;
  if (k === 'unit') return { name: 'unit_id', sql: 'uuid', ref: HAND_TARGET.units };
  if (k === 'parentId' && SELF_PARENT[collection]) return { name: 'parent_id', sql: 'uuid', ref: qualified(SELF_PARENT[collection]) };
  if (REF[k]) return { name: snake(k), sql: 'uuid', ref: qualified(REF[k]) };
  if (POLYMORPHIC.has(k)) return { name: snake(k), sql: 'uuid' };
  if (ID_ARRAYS.has(k)) return { name: snake(k), sql: 'uuid[] NOT NULL DEFAULT \'{}\'' };
  if (ROLE_REFS.has(k)) return { name: k === 'createdByRole' ? 'raised_by_role_id' : snake(k), sql: 'uuid', ref: HAND_TARGET.role };
  if (ROLE_ARRAYS.has(k)) return { name: snake(k), sql: 'uuid[] NOT NULL DEFAULT \'{}\'' };
  if (WHO.has(k)) return { name: `${snake(k === 'createdBy' ? 'raisedBy' : k)}_id`, sql: 'uuid', ref: HAND_TARGET.membership };
  if (t === 'ref:membership') return { name: snake(k).replace(/_id$/, '') + '_id', sql: 'uuid', ref: HAND_TARGET.membership };
  if (/At$/.test(k) || t === 'timestamptz') return { name: snake(k), sql: 'timestamptz' };
  switch (t) {
    case 'number': return { name: snake(k), sql: COUNT.test(k) ? 'integer' : MONEY.test(k) ? 'numeric(14,2)' : 'numeric' };
    case 'boolean': return { name: snake(k), sql: 'boolean NOT NULL DEFAULT false' };
    case 'date': return { name: snake(k), sql: 'date' };
    case 'time': return { name: snake(k), sql: 'time' };
    case 'tags': case 'roles': return { name: snake(k), sql: 'text[] NOT NULL DEFAULT \'{}\'' };
    case 'files': case 'people': case 'specs': case 'jsonb': return { name: snake(k), sql: 'jsonb NOT NULL DEFAULT \'[]\'' };
    case 'phone': return { name: snake(k), sql: 'text', check: `${snake(k)} IS NULL OR ${snake(k)} ~ '^\\+[1-9][0-9]{6,14}$'` };
    default: return { name: snake(k), sql: 'text' };
  }
}

const out = [];
const fks = [];
const indexes = [];
const triggers = [];
const report = [];
const emit = (s) => out.push(s);
emit(`-- =====================================================================================================================================
-- V6 module tables: GENERATED by backend/api/tools/gen-module-tables.mjs from the CommunityOS field definitions - edit the generator, not this file.
-- One real table per object (${Object.keys(TABLE).length} tables). Standard columns, typed fields, foreign keys between objects; RLS, audit stamping and
-- grants are attached to every tenant table in V9. Select options are validated by the API (config.field_definition), not by CHECKs.
-- =====================================================================================================================================
`);

const byId = new Map(schemas.map((s) => [s.id, s]));
for (const [collection, table] of Object.entries(TABLE)) {
  const s = byId.get(collection);
  const fields = s ? s.fields : (EXTRA_FIELDS[collection] || []).map(([key, type]) => ({ key, type }));
  if (!s && !EXTRA_FIELDS[collection]) report.push(`${collection}: no field definitions`);
  const cols = []; const seen = new Set(STANDARD); const checks = [];
  for (const f of fields) {
    const c = columnFor(collection, f);
    if (!c) continue;
    if (seen.has(c.name)) { if (!STANDARD.has(c.name)) report.push(`${collection}.${f.key}: duplicate column ${c.name} skipped`); continue; }
    seen.add(c.name);
    cols.push(c);
    if (c.check) checks.push(c.check);
    if (c.ref) {
      const target = c.ref; const targetCollection = Object.entries(TABLE).find(([, v]) => v === target)?.[0];
      if (targetCollection && PARTITIONED.has(targetCollection)) { report.push(`${collection}.${f.key}: points at partitioned ${target} - no foreign key`); }
      else fks.push(`ALTER TABLE ${table} ADD FOREIGN KEY (community_id, ${c.name}) REFERENCES ${target} (community_id, id)${target === HAND_TARGET.units || target === HAND_TARGET.membership ? '' : ' ON DELETE SET NULL (' + c.name + ')'};`);
      indexes.push(`CREATE INDEX IF NOT EXISTS ${table.replace('.', '_')}_${c.name} ON ${table} (community_id, ${c.name}) WHERE ${c.name} IS NOT NULL;`);
    }
  }
  const part = PARTITIONED.has(collection);
  emit(`-- ${collection}${s?.label ? ` (${s.label})` : ''}`);
  emit(`CREATE TABLE IF NOT EXISTS ${table} (`);
  const lines = [
    '  community_id uuid        NOT NULL REFERENCES platform.community (id)',
    '  id           uuid        NOT NULL DEFAULT gen_random_uuid()',
    '  short_id     text',
    ...cols.map((c) => `  ${c.name.padEnd(12)} ${c.sql}`),
    "  custom       jsonb       NOT NULL DEFAULT '{}'",
    '  version      bigint      NOT NULL DEFAULT 1',
    '  created_at   timestamptz NOT NULL DEFAULT now()',
    '  created_by   uuid',
    '  updated_at   timestamptz NOT NULL DEFAULT now()',
    '  updated_by   uuid',
    part ? '  PRIMARY KEY (community_id, created_at, id)' : '  PRIMARY KEY (community_id, id)',
    ...(part ? [] : ['  UNIQUE (community_id, short_id)']),
    ...checks.map((c) => `  CHECK (${c})`),
  ];
  emit(lines.join(',\n'));
  emit(part ? ') PARTITION BY RANGE (created_at);' : ');');
  if (part) emit(`CREATE TABLE IF NOT EXISTS ${table}_default PARTITION OF ${table} DEFAULT;`);
  emit(`CREATE INDEX IF NOT EXISTS ${table.replace('.', '_')}_recent ON ${table} (community_id, created_at DESC);`);
  if (cols.some((c) => c.name === 'status')) emit(`CREATE INDEX IF NOT EXISTS ${table.replace('.', '_')}_status ON ${table} (community_id, status);`);
  if (part) emit(`CREATE INDEX IF NOT EXISTS ${table.replace('.', '_')}_short ON ${table} (community_id, short_id);`);
  const prefix = prefixes[collection] || collection.slice(0, 3).toUpperCase();
  const [base, pad] = collection === 'tickets' ? [1050, 0] : [0, 4];
  triggers.push(`CREATE TRIGGER short_id BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('${prefix}', '${base}', '${pad}');`);
  emit('');
}
emit('-- ---- references between objects ----------------------------------------------------------------------------------------------------------');
emit(fks.join('\n'));
emit('');
emit(indexes.join('\n'));
emit('');
emit('-- ---- short numbers people quote (TKT-1051, BKG-0001 ...) -------------------------------------------------------------------------------');
emit(triggers.join('\n'));
emit('');
emit('-- the module tables, for V9 (RLS, stamping, grants) and for the API\'s table registry');
emit(`CREATE OR REPLACE VIEW platform.module_table AS SELECT * FROM (VALUES\n${Object.entries(TABLE).map(([c, t]) => `  ('${c}', '${t.split('.')[0]}', '${t.split('.')[1]}', ${PARTITIONED.has(c)})`).join(',\n')}\n) AS m(legacy_collection, schema_name, table_name, partitioned);`);

fs.writeFileSync(path.join(here, '..', 'src', 'main', 'resources', 'db', 'migration', 'V6__module_tables.sql'), `${out.join('\n')}\n`);
console.log(`tables=${Object.keys(TABLE).length} foreignKeys=${fks.length} partitioned=${PARTITIONED.size}`);
if (report.length) console.log(report.join('\n'));

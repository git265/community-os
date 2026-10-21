// Generates V8__modules.sql: one table per remaining business object, from the app's field registry (src/lib/schema/registry.js).
//
//   node --import ../contract-server/register-hooks.mjs tools/gen-module-tables.mjs > src/main/resources/db/migration/V8__modules.sql
//   (run from backend/platform; register-hooks only lets Node import the UI's modules)
//
// The core objects (units, people, bills, payments, journal, tickets, bookings, files, notifications ...) are designed by hand in V1-V7.
// Everything else follows the same conventions, generated so the 100+ smaller objects stay consistent:
//   id uuid PK, community_id + UNIQUE (community_id, id), typed columns, NOT NULL for required fields, composite foreign keys for the
//   references the registry names (unit -> units, ticketId -> tickets ...), `custom jsonb`, server-stamped metadata, sensible indexes.
// The output is reviewed and committed; re-run it when the registry gains an object.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const { DEFAULT_SCHEMAS } = await import(path.join(SRC, 'schema/registry.js'));
const { COLLECTIONS: C } = await import(path.join(SRC, 'storage/StorageAdapter.js'));

// collections that already have a hand-designed table (V1-V7) -> that table
const CORE = {
  communityConfig: 'communities', communities: 'communities', blocks: 'blocks', facilities: 'facilities', properties: 'units', users: 'user_accounts',
  userProfiles: 'people', roles: 'roles', roleGroups: 'roles', schema: 'field_policies', audit: 'audit_events', files: 'files',
  tickets: 'tickets', taskTypes: 'task_types', ticketComments: 'ticket_comments', quotations: 'ticket_documents', releases: 'fund_releases',
  approvalPolicies: 'approval_policies', approverSettings: 'approval_policies', categoryMap: 'ticket_categories', vendors: 'vendors',
  dues: 'bills', ledger: 'journal_entries', funds: 'funds', bankAccounts: 'bank_accounts', bankTxns: 'bank_transactions', levies: 'levies',
  readings: 'meter_readings', utilityTypes: 'charge_types', unitCredits: 'unit_credit_movements',
  amenityTypes: 'amenity_types', amenities: 'amenity_bookings', amenityItems: 'amenity_items',
  notifications: 'notifications', notificationPrefs: 'notification_preferences', notificationOutbox: 'message_deliveries',
};
const RENAME = { forum: 'forum_topics', gatePulse: 'gate_console_heartbeats', schema: 'field_policies' };
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
const tableOf = (c) => CORE[c] || RENAME[c] || snake(c);

// id-like fields that point at another object -> the table they reference
const REFS = {
  unit: 'units', ticketId: 'tickets', eventId: 'cultural_events', vendorId: 'vendors', contactId: 'service_contacts', topicId: 'forum_topics',
  personId: 'gate_people', broadcastId: 'broadcasts', ballotId: 'ballots', offeringId: 'cultural_offerings', assetId: 'equipment', planId: 'infra_plans',
  folderId: 'doc_folders', parentId: null, fileId: 'files', expenseId: 'cultural_expenses', visitId: 'gate_visits', passId: 'gate_passes',
  workOrderId: 'gate_work_orders', approvalId: 'gate_approvals', meetingId: 'meetings', logTypeId: 'log_types', readingId: 'meter_readings',
  bankAccountId: 'bank_accounts', fundId: 'funds', staffId: 'handymen', dueId: 'bills', levyId: 'levies',
};
const RESERVED = new Set(['id', 'community_id', 'custom', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'user', 'order', 'group', 'default', 'limit', 'offset', 'from', 'to', 'check', 'primary', 'references', 'table', 'column', 'select', 'where', 'when', 'end', 'grant', 'desc', 'asc', 'all', 'any', 'case', 'role', 'kind_', 'window']);
const col = (k) => { const s = snake(k); return RESERVED.has(s) ? `${s}_value` : s; };

function sqlType(f) {
  switch (f.type) {
    case 'number': return 'numeric(16,4)';
    case 'boolean': return 'boolean';
    case 'date': return 'date';
    case 'time': return 'time';
    case 'tags': case 'roles': case 'people': return 'text[]';
    case 'files': case 'specs': return 'jsonb';
    default: return 'text';
  }
}
const moneyish = (k) => /(amount|price|rate|cost|fee|budget|balance|total|deposit|value|salary|charge)$/i.test(k) && !/rate$/i.test(k) ? 'money' : null;

const out = [];
const made = new Set(Object.values(CORE));
const tables = [];
for (const s of DEFAULT_SCHEMAS) {
  if (CORE[s.id]) continue;
  if (!Object.values(C).includes(s.id)) continue;
  if ([C.VOTE_ROLL, C.BALLOT_BOX].includes(s.id)) continue;   // special shape below
  tables.push(s);
}
// the extra objects that have no registry schema but are part of the app
const EXTRA = [C.BALLOT_BOX, C.VOTE_ROLL, C.GATE_PULSE];
const known = new Set([...made, ...tables.map((s) => tableOf(s.id)), ...EXTRA.map(tableOf)]);

out.push('-- =====================================================================================================================================');
out.push('-- GENERATED by tools/gen-module-tables.mjs from the field registry, then reviewed. One table per business object (the core objects are');
out.push('-- hand-designed in V1-V7). Same conventions everywhere: community-scoped, typed columns, composite foreign keys, server-stamped');
out.push('-- metadata, `custom jsonb` for community-defined fields, row-level security (V90).');
out.push('-- Choice lists ("select" fields) are plain text here because communities can edit them in Studio: the application validates them');
out.push('-- against field_policies / custom_field_defs. Foreign keys are declared at the end, once every table exists.');
out.push('-- =====================================================================================================================================');
out.push('');
const fks = [];
for (const s of tables) {
  const t = tableOf(s.id);
  const cols = []; const seen = new Set(); const idx = [];
  for (const f of s.fields) {
    if (!f.key || f.key === 'id') continue;
    let name = col(f.key); let type = sqlType(f);
    const ref = REFS[f.key];
    if (f.key === 'unit' && known.has('units')) { name = 'unit_id'; type = 'uuid'; }
    else if (ref && known.has(ref)) { type = 'uuid'; }
    if (seen.has(name)) continue; seen.add(name);
    const notNull = f.required && type !== 'boolean' ? ' NOT NULL' : '';
    const def = type === 'boolean' ? ' NOT NULL DEFAULT false' : type === 'text[]' ? ' NOT NULL DEFAULT \'{}\'' : '';
    const checks = [];
    if (type.startsWith('numeric') && moneyish(f.key)) checks.push(`CHECK (${name} >= 0)`);
    if (f.type === 'phone') checks.push(`CHECK (${name} ~ '^\\+[1-9][0-9]{6,14}$')`);
    if (type === 'jsonb') checks.push(`CHECK (jsonb_typeof(${name}) IN ('array', 'object'))`);
    cols.push(`  ${name.padEnd(28)} ${type}${notNull}${def}${checks.length ? ' ' + checks.join(' ') : ''},${f.label ? `   -- ${String(f.label).replace(/\s+/g, ' ').slice(0, 70)}` : ''}`);
    if (type === 'uuid') { fks.push([t, name, f.key === 'unit' ? 'units' : ref]); idx.push(name); }
    if (['status', 'date', 'start_date', 'due_date', 'visit_date', 'reading_date', 'period'].includes(name) || /_on$|_date$/.test(name)) idx.push(name);
  }
  out.push(`-- ${s.label || s.id}  (collection: ${s.id})`);
  out.push(`CREATE TABLE ${t} (`);
  out.push('  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),');
  out.push('  community_id                 uuid NOT NULL REFERENCES communities (id),');
  out.push('  ref_no                       text,                                  -- the number people quote (from number_series)');
  out.push(...cols);
  out.push("  custom                       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),");
  out.push('  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,');
  out.push('  UNIQUE (community_id, id)');
  out.push(');');
  out.push(`CREATE UNIQUE INDEX ${t}_ref ON ${t} (community_id, ref_no) WHERE ref_no IS NOT NULL;`);
  out.push(`CREATE INDEX ${t}_recent ON ${t} (community_id, created_at DESC);`);
  for (const i of [...new Set(idx)].slice(0, 4)) out.push(`CREATE INDEX ${t}_${i} ON ${t} (community_id, ${i});`);
  out.push(`SELECT use_row_stamps('${t}');`);
  out.push('');
}
// the e-voting objects keep their special shape: the roll says WHO voted, the box says WHAT, and they cannot be linked
out.push('-- E-voting: the roll (who voted) and the box (what was voted) are separate and cannot be joined; both are append-only.');
out.push(`CREATE TABLE vote_roll (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  ballot_id     uuid NOT NULL,
  unit_id       uuid NOT NULL,
  voter_user_id uuid NOT NULL DEFAULT app_user(),
  marked_on     date NOT NULL DEFAULT current_date,
  UNIQUE (community_id, id), UNIQUE (community_id, ballot_id, unit_id)          -- one vote per unit
);
CREATE TABLE ballot_box (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  ballot_id     uuid NOT NULL,
  seq           integer NOT NULL CHECK (seq > 0),
  choice        text NOT NULL,
  receipt       text NOT NULL,
  prev_hash     text NOT NULL,
  hash          text NOT NULL,
  cast_on       date NOT NULL DEFAULT current_date,                             -- the day only: never the time, never the voter
  UNIQUE (community_id, id), UNIQUE (community_id, ballot_id, seq)
);
CREATE TRIGGER vote_roll_append_only BEFORE UPDATE OR DELETE ON vote_roll FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ballot_box_append_only BEFORE UPDATE OR DELETE ON ballot_box FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TABLE gate_console_heartbeats (
  community_id  uuid NOT NULL REFERENCES communities (id),
  console_id    text NOT NULL,
  guard_user_id uuid,
  kind          text NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, console_id)
);`);
out.push('');
out.push('-- ---- references between the objects (composite: the target must belong to the same community) ----------------------------------');
for (const [t, c, target] of fks) {
  if (!known.has(target)) continue;
  out.push(`ALTER TABLE ${t} ADD FOREIGN KEY (community_id, ${c}) REFERENCES ${target} (community_id, id);`);
}
out.push(`ALTER TABLE vote_roll ADD FOREIGN KEY (community_id, ballot_id) REFERENCES ballots (community_id, id);`);
out.push(`ALTER TABLE vote_roll ADD FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id);`);
out.push(`ALTER TABLE ballot_box ADD FOREIGN KEY (community_id, ballot_id) REFERENCES ballots (community_id, id);`);
console.log(out.join('\n'));
console.error(`tables=${tables.length + 3} foreignKeys=${fks.filter(([, , x]) => known.has(x)).length + 3}`);

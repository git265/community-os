// Generates the data the Spring service needs, and the "golden" decisions its Java rule book is tested against.
//
//   node --import ./register-hooks.mjs test/gen-rulebook-golden.mjs        (from backend/contract-server; or: npm run gen:rulebook)
//
// Why this exists: the Node server does not have its own authorization code; it runs the app's JavaScript rule book
// (src/lib/security/authz.js). The Spring service has the same rules written in Java (com.communityos.security). Two copies drift, so this
// script asks the REAL JavaScript rule book for its decision on tens of thousands of cases (every role x every collection x create / update /
// delete / read / row scope / masking), and the Java test replays them. If a rule changes in JS, rerun this and the Java test names what differs.
//
// Writes (all under backend/spring/src):
//   main/resources/rulebook/default-roles.json      the built-in roles (id, name, category, permissions)
//   main/resources/rulebook/default-schemas.json    every collection's fields with viewableBy / editableBy
//   main/resources/rulebook/constants.json          allowed upload extensions, size limit, utility types, document groups
//   test/resources/rulebook/golden.json.gz          fixtures, principals and expected decisions
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// fixed clock: rules that look at "today" (SLA due dates) must give the same answer when the Java test replays them
const FIXED = Date.parse('2026-10-19T12:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FIXED); }
  static now() { return FIXED; }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const OUT = path.resolve(here, '../../spring/src');
const imp = (p) => import(path.join(SRC, p));
const authz = await imp('security/authz.js');
const { COLLECTIONS: C } = await imp('storage/StorageAdapter.js');
const { DEFAULT_SCHEMAS } = await imp('schema/registry.js');
const { DEFAULT_ROLES } = await imp('access/roles.js');
const { ALLOWED_TYPES, MAX_BYTES } = await imp('files/fileValidation.js');
const { DEFAULT_UTILITY_TYPES } = await imp('utilityTypes.js');
const { BUILT_IN_DOC_GROUPS } = await imp('lists/configLists.js');
const { shortPrefix } = await imp('storage/secureStorage.js');

const ALL = Object.values(C);
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));

// ---------------------------------------------------------------------------------------------------- resources
const roles = DEFAULT_ROLES.map((r) => ({ id: r.id, name: r.name, category: r.category, permissions: r.permissions }));
const schemas = DEFAULT_SCHEMAS.map((s) => ({ id: s.id, label: s.label, fields: s.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, hidden: !!f.hidden, options: Array.isArray(f.options) ? f.options : undefined, viewableBy: f.viewableBy || [], editableBy: f.editableBy || [] })) }));
fs.mkdirSync(path.join(OUT, 'main/resources/rulebook'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'test/resources/rulebook'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'main/resources/rulebook/default-roles.json'), JSON.stringify(roles));
fs.writeFileSync(path.join(OUT, 'main/resources/rulebook/default-schemas.json'), JSON.stringify(schemas));
fs.writeFileSync(path.join(OUT, 'main/resources/rulebook/constants.json'), JSON.stringify({
  maxBytes: MAX_BYTES, allowedExtensions: ALLOWED_TYPES.flatMap((t) => t.ext), utilityTypes: DEFAULT_UTILITY_TYPES.map((u) => u.name), builtInDocGroups: BUILT_IN_DOC_GROUPS,
  collections: ALL,
  shortPrefixes: Object.fromEntries(ALL.map((c) => [c, shortPrefix(c)])),   // TKT, DUE, LED ... the letters in front of a record's short number
}));

// ---------------------------------------------------------------------------------------------------- fixtures
// Hand-written rows for the collections whose rules look inside the record, and a generated row (from the schema) for every other one.
const U1 = 'A-101'; const U2 = 'B-201';
const fx = {
  properties: [
    { id: 'p1', shortId: 'UNIT-0001', unit: U1, type: 'Apartment', zone: 'A', owner: 'Asha', ownerPhone: '+91 90000 00001', occupancy: 'Owner occupied', ownerEmail: 'a@x.in', recVersion: 3 },
    { id: 'p2', shortId: 'UNIT-0002', unit: 'A-102', type: 'Apartment', zone: 'A', owner: 'Bala', ownerPhone: '+91 90000 00002', occupancy: 'Vacant', ownerEmail: 'b@x.in' },
    { id: 'p3', shortId: 'UNIT-0003', unit: U2, type: 'Apartment', zone: 'B', owner: 'Chitra', ownerPhone: '+91 90000 00003', occupancy: 'Tenant occupied', tenant: 'Dev' },
  ],
  taskTypes: [{ id: 'tt1', name: 'Plumbing', residentVisible: true, creatorScope: 'Resident' }, { id: 'tt2', name: 'EC task', residentVisible: false, creatorScope: 'EC / Staff' }],
  tickets: [
    { id: 't1', shortId: 'TKT-1051', unit: U1, taskType: 'Plumbing', status: 'Open', scope: 'Unit', createdBy: 'Asha', createdByRole: 'owner', description: 'Leak', slaDueAt: '2026-11-01', category: 'Plumbing', priority: 'Medium', financial: false },
    { id: 't2', shortId: 'TKT-1052', unit: U2, taskType: 'Plumbing', status: 'Completed', scope: 'Unit', createdBy: 'Chitra', createdByRole: 'owner', description: 'Tap', category: 'Plumbing' },
    { id: 't3', shortId: 'TKT-1053', unit: '', taskType: 'Plumbing', status: 'Open', scope: 'Community', location: 'Gate', affectedUnits: ['A-102'], createdBy: 'Bala', createdByRole: 'owner' },
    { id: 't4', shortId: 'TKT-1054', unit: U1, taskType: 'EC task', status: 'Open', scope: 'Unit', createdBy: 'Treasurer', createdByRole: 'treasurer', financial: true, ecApproval: 'Pending', treasurerApproval: 'Pending', quotationStatus: 'Pending', assignedTo: 'Vendor' },
    { id: 't5', shortId: 'TKT-1055', unit: U1, taskType: 'EC task', status: 'Closed', scope: 'Unit', createdBy: 'Treasurer', createdByRole: 'treasurer', financial: true, ecApproval: 'Approved', ecApprovedBy: 'President', treasurerApproval: 'Approved' },
    { id: 't6', shortId: 'TKT-1056', unit: U1, taskType: 'EC task', status: 'Open', scope: 'Unit', createdBy: 'Treasurer', createdByRole: 'treasurer', financial: true, ecApproval: 'Pending', treasurerApproval: 'Pending',
      plan: JSON.stringify({ version: 1, steps: [{ id: 's1', name: 'EC', approvers: [{ kind: 'group', value: 'EC members' }], needed: 1, canFinish: true, decisions: [] }, { id: 's2', name: 'Final', approvers: [{ kind: 'group', value: 'Final approvers' }], needed: 1, decisions: [] }], overrides: [] }) },
  ],
  ticketComments: [{ id: 'c1', ticketId: 't1', visibility: 'Public', text: 'hi' }, { id: 'c2', ticketId: 't1', visibility: 'Internal', text: 'x' }, { id: 'c3', ticketId: 't2', visibility: 'Public', text: 'y' }],
  dues: [
    { id: 'd1', shortId: 'DUE-0001', unit: U1, category: 'Maintenance', amount: 1000, status: 'Open', dueDate: '2026-11-10' },
    { id: 'd2', shortId: 'DUE-0002', unit: U2, category: 'Water bill', amount: 300, status: 'Open', readingId: 'r1', dueDate: '2026-11-10' },
    { id: 'd3', shortId: 'DUE-0003', unit: U1, category: 'Water', amount: 100, status: 'Paid', readingId: 'r1', paidAt: '2026-10-01' },
    { id: 'd4', shortId: 'DUE-0004', unit: '', category: 'Misc', amount: 50, status: 'Open' },
  ],
  unitCredits: [{ id: 'uc1', unit: U1, amount: 10 }, { id: 'uc2', unit: U2, amount: 5 }],
  amenities: [
    { id: 'b1', shortId: 'BKG-0001', unit: U1, amenity: 'Clubhouse', date: '2026-11-01', slot: 'Evening', status: 'Confirmed', totalPayable: 500, paymentStatus: 'Paid' },
    { id: 'b2', shortId: 'BKG-0002', unit: U2, amenity: 'Clubhouse', date: '2026-11-02', slot: 'Evening', status: 'Pending', totalPayable: 500, paymentStatus: 'Unpaid' },
  ],
  amenitySettings: [{ id: 'as1', gstRate: 18, adminRecipients: ['x@y.in'], reportRecipients: ['z@y.in'], dailyReport: true }],
  amenityTypes: [{ id: 'at1', name: 'Clubhouse', rate: 500, rules: 'No loud music', description: 'Hall' }],
  ledger: [
    { id: 'l1', shortId: 'LED-0001', type: 'Debit', date: '2026-10-05', amount: 100, category: 'Vendor', unit: '' },
    { id: 'l2', shortId: 'LED-0002', type: 'Credit', date: '2026-10-06', amount: 1000, category: 'Dues', unit: U1, sourceType: 'due' },
  ],
  documents: [
    { id: 'doc1', title: 'Rules', access: 'Everyone', folderId: 'f1', fileId: 'fl1' },
    { id: 'doc2', title: 'Minutes', access: 'Executive Committee', folderId: '', fileId: 'fl2' },
    { id: 'doc3', title: 'Villa doc', access: 'Villa owner / resident', unit: U1, folderId: '', fileId: 'fl3' },
    { id: 'doc4', title: 'Owners', access: 'All owners', folderId: 'f2', fileId: 'fl4' },
    { id: 'doc5', title: 'Finance', access: 'EC + Finance', folderId: '', fileId: 'fl5' },
    { id: 'doc6', title: 'Staff', access: 'Staff', folderId: '', fileId: 'fl6' },
    { id: 'doc7', title: 'Old', access: 'Restricted', unit: U2, folderId: '' },
  ],
  docFolders: [{ id: 'f1', name: 'General', parentId: '', accessRoles: [] }, { id: 'f2', name: 'EC only', parentId: 'f1', accessRoles: ['group:EC'] }],
  users: [
    { id: 'u1', name: 'Asha', roleId: 'owner', status: 'Active', unit: U1, phone: '9000000001' },
    { id: 'u2', name: 'Treasurer T', roleId: 'treasurer', status: 'Active' },
    { id: 'u3', name: 'Old President', roleId: 'president', status: 'Inactive' },
    { id: 'u4', name: 'Secretary', roleId: 'general_secretary', status: 'Active', blocks: ['A'] },
    { id: 'u5', name: 'FM', roleId: 'facility_manager', status: 'Active' },
  ],
  roles: DEFAULT_ROLES.map((r) => ({ id: r.id, name: r.name, category: r.category, permissions: r.permissions })),
  broadcasts: [
    { id: 'br1', status: 'Sent', audience: 'All residents', title: 'A' }, { id: 'br2', status: 'Sent', audience: 'Owners', title: 'B' }, { id: 'br3', status: 'Draft', audience: 'All residents', title: 'C' },
    { id: 'br4', status: 'Sent', audience: 'Selected villas', audienceUnits: [U1], title: 'D' }, { id: 'br5', status: 'Sent', audience: 'EC members', title: 'E' }, { id: 'br6', status: 'Sent', audience: 'All villas', title: 'F' },
  ],
  voteRoll: [{ id: 'vr1', unit: U1, owner: 'Asha', ballotId: 'bl1' }],
  pollVotes: [{ id: 'pv1', unit: U1, voter: 'Asha', pollId: 'x' }, { id: 'pv2', unit: U2, voter: 'Chitra', pollId: 'x' }],
  ballots: [{ id: 'bl1', status: 'Closed', title: 'B' }, { id: 'bl2', status: 'Draft', title: 'B2' }],
  ballotBox: [{ id: 'bb1', ballotId: 'bl1', choice: 'Yes' }, { id: 'bb2', ballotId: 'bl2', choice: 'No' }],
  meetings: [{ id: 'm1', title: 'AGM', visibility: 'Published' }, { id: 'm2', title: 'Internal', visibility: 'Internal (committee only)' }],
  culturalEvents: [
    { id: 'e1', name: 'Diwali', visibility: 'Published', brochureStatus: 'Published', showBrochure: 'Yes', status: 'Planned', budget: 1000, spent: 400 },
    { id: 'e2', name: 'Secret', visibility: 'Draft', status: 'Completed', budget: 1000, spent: 400 },
  ],
  culturalBrochure: [{ id: 'cb1', eventId: 'e1' }, { id: 'cb2', eventId: 'e2' }],
  culturalPrograms: [{ id: 'cp1', eventId: 'e1', participants: [{ name: 'Asha', unit: U1, phone: '1' }], capacity: 3 }, { id: 'cp2', eventId: 'e2', participants: [], capacity: 0 }],
  culturalSevas: [{ id: 'cs1', eventId: 'e1', volunteers: [{ name: 'Asha', unit: U1, phone: '1' }], needed: 2 }, { id: 'cs2', eventId: 'e2', volunteers: [], needed: 0 }],
  culturalOfferings: [{ id: 'co1', eventId: 'e1', kind: 'Fixed slot', reservedUnit: '' }, { id: 'co2', eventId: 'e1', kind: 'Fixed slot', reservedUnit: U1 }, { id: 'co3', eventId: 'e2', kind: 'Pool' }],
  culturalDonations: [{ id: 'cd1', unit: U1, status: 'Pledged', amount: 100, donor: 'Asha' }, { id: 'cd2', unit: U2, status: 'Received', amount: 200, receiptNo: 'R1' }],
  culturalExpenses: [
    { id: 'ce1', eventId: 'e1', item: 'Flowers', amount: 100, status: 'Pending approval', ecApproval: 'Pending', recordCreatedBy: 'Treasurer T' },
    { id: 'ce2', eventId: 'e1', item: 'Lights', amount: 100, status: 'Approved', ecApproval: 'Approved', recordCreatedBy: 'Treasurer T' },
    { id: 'ce3', eventId: 'e1', item: 'Sweets', amount: 100, status: 'Rejected', ecApproval: 'Rejected' },
  ],
  culturalPhotos: [{ id: 'ph1', eventId: 'e1', uploadedBy: 'Asha', caption: 'x' }, { id: 'ph2', eventId: 'e1', uploadedBy: 'Chitra', caption: 'y' }],
  gatePeople: [{ id: 'gp1', status: 'Active', invitedByUnit: '' }, { id: 'gp2', status: 'Invited', invitedByUnit: U1 }, { id: 'gp3', status: 'Under review', invitedByUnit: U2 }, { id: 'gp4', status: 'Documents pending', invitedByUnit: U1 }],
  gateLinks: [{ id: 'gl1', unit: U1 }, { id: 'gl2', unit: U2 }], gatePasses: [{ id: 'gs1', unit: U1 }, { id: 'gs2', unit: U2 }], gateVisits: [{ id: 'gv1', unit: U1 }, { id: 'gv2', unit: U2 }],
  gateApprovals: [{ id: 'ga1', unit: U1, status: 'Pending' }, { id: 'ga2', unit: U2, status: 'Pending' }, { id: 'ga3', unit: U1, status: 'Approved' }], gateVehicles: [{ id: 'gh1', unit: U1 }, { id: 'gh2', unit: U2 }],
  gateVillaRules: [{ id: 'gr1', unit: U1 }, { id: 'gr2', unit: U2 }], gatePassTemplates: [{ id: 'gt1', unit: '' }, { id: 'gt2', unit: U1 }, { id: 'gt3', unit: U2 }],
  gateFlags: [{ id: 'gf1', status: 'Open' }], gateScans: [{ id: 'gc1' }], gateWorkOrders: [{ id: 'gw1', status: 'Open' }], gateSettings: [{ id: 'gse1' }],
  audits: [{ id: 'au1', visibility: 'Published', title: 'A' }, { id: 'au2', visibility: 'Draft', title: 'B' }],
  audit: [{ id: 'ad1', unit: U1, action: 'Update', who: 'x', when: '2026-10-01T00:00:00Z' }, { id: 'ad2', unit: U2, action: 'Update', who: 'y' }, { id: 'ad3', unit: '', action: 'Create', who: 'z' }],
  serviceContacts: [{ id: 'sc1', status: 'Active', addedBy: 'Asha', name: 'Plumber' }, { id: 'sc2', status: 'Hidden', addedBy: 'Chitra', name: 'Bad' }],
  contactReviews: [{ id: 'cr1', author: 'Asha', rating: 4, contactId: 'sc1' }, { id: 'cr2', author: 'Chitra', rating: 2, contactId: 'sc1' }],
  forum: [{ id: 'fo1', title: 'Topic', replies: [], pollOptions: [], voters: [], author: 'Asha' }],
  forumPosts: [{ id: 'fp1', author: 'Asha', authorRoleId: 'owner', topicId: 'fo1', reactions: {} }, { id: 'fp2', author: 'Chitra', authorRoleId: 'owner', topicId: 'fo1', reactions: {} }],
  wishes: [{ id: 'w1', raisedBy: 'Asha', status: 'Submitted', votes: [U2], title: 'Pool' }, { id: 'w2', raisedBy: 'Chitra', status: 'Done', votes: [], title: 'Gym' }],
  attendance: [{ id: 'at1', staffName: 'FM', clockIn: '2026-10-19T03:00:00Z', clockOut: '', source: 'Self' }, { id: 'at2', staffName: 'Guard', clockIn: '2026-10-19T03:00:00Z', clockOut: '2026-10-19T11:00:00Z', source: 'Self' }],
  userProfiles: [{ id: 'up1', userName: 'Asha', bio: 'x' }, { id: 'up2', userName: 'Chitra', bio: 'y' }],
  readings: [{ id: 'rd1', status: 'Draft' }, { id: 'rd2', status: 'Published' }],
  quotations: [
    { id: 'q1', kind: 'Quotation', ticketId: 't4', vendor: 'V', amount: 100, selected: true },
    { id: 'q2', kind: 'Invoice', ticketId: 't4', vendor: 'V', amount: 100, ecApproval: 'Pending', finalApproval: 'Pending', selected: true },
    { id: 'q3', kind: 'Invoice', ticketId: 't4', vendor: 'V', amount: 100, ecApproval: 'Approved', finalApproval: 'Pending', selected: true },
    { id: 'q4', kind: 'Invoice', ticketId: 't4', vendor: 'V', amount: 100, ecApproval: 'Approved', finalApproval: 'Approved', selected: true },
  ],
  releases: [
    { id: 'rl1', ticketId: 't4', status: 'Waiting approval', amount: 50, vendor: 'V', kind: 'Advance', plan: JSON.stringify({ version: 1, steps: [{ id: 's1', name: 'EC', approvers: [{ kind: 'group', value: 'EC members' }], needed: 1, canFinish: true, decisions: [] }, { id: 's2', name: 'Final', approvers: [{ kind: 'group', value: 'Final approvers' }], needed: 1, decisions: [] }], overrides: [] }) },
    { id: 'rl2', ticketId: 't4', status: 'Approved', amount: 50, vendor: 'V', kind: 'Advance' },
    { id: 'rl3', ticketId: 't4', status: 'Paid', amount: 50, vendor: 'V', kind: 'Advance' },
    { id: 'rl4', ticketId: 't4', status: 'Rejected', amount: 50, vendor: 'V', kind: 'Advance' },
    { id: 'rl5', expenseId: 'ce1', status: 'Waiting approval', amount: 50, vendor: 'V', kind: 'Advance' },
  ],
  equipment: [{ id: 'eq1', name: 'Pump' }], vendorComments: [{ id: 'vc1', text: 'x' }],
  files: [
    { id: 'fl1', name: 'rules.pdf', ownerType: 'document', ownerId: 'doc1', size: 100 }, { id: 'fl2', name: 'minutes.pdf', ownerType: 'document', ownerId: 'doc2', size: 100 },
    { id: 'fl3', name: 'v.pdf', ownerType: 'document', size: 100 }, { id: 'fl4', name: 'o.pdf', ownerType: 'document', size: 100 }, { id: 'fl5', name: 'f.pdf', ownerType: 'document', size: 100 },
    { id: 'fl6', name: 's.pdf', ownerType: 'document', size: 100 },
    { id: 'fl7', name: 'a.jpg', ownerType: 'ticket', ownerId: 't1', size: 100 }, { id: 'fl8', name: 'b.jpg', ownerType: 'ticket', ownerId: 't2', size: 100 }, { id: 'fl9', name: 'c.jpg', ownerType: 'ticketInternal', ownerId: 't1', size: 100 },
    { id: 'fl10', name: 'd.pdf', ownerType: 'quotation', ownerId: 'q1', size: 100 }, { id: 'fl11', name: 'e.pdf', ownerType: 'audit', ownerId: 'au1', size: 100 }, { id: 'fl12', name: 'f.pdf', ownerType: 'audit', ownerId: 'au2', size: 100 },
    { id: 'fl13', name: 'g.pdf', ownerType: 'ledger', ownerId: 'l1', size: 100 }, { id: 'fl14', name: 'h.pdf', ownerType: 'reading', ownerId: 'r1', size: 100 }, { id: 'fl15', name: 'i.pdf', ownerType: 'meeting', size: 100 },
    { id: 'fl16', name: 'j.jpg', ownerType: 'culturalBrochure', ownerId: 'e1', size: 100 }, { id: 'fl17', name: 'k.jpg', ownerType: 'amenityDeposit', ownerId: 'b1', size: 100 }, { id: 'fl18', name: 'x.exe', ownerType: 'ticket', ownerId: 't1', size: 100 },
    { id: 'fl19', name: 'big.pdf', ownerType: 'ticket', ownerId: 't1', size: 99999999 },
  ],
  approverSettings: [{ id: 'ap1', roles: ['treasurer', 'president'] }], financeSettings: [{ id: 'fs1', finalCanDecideEC: true }],
};
// every other collection: one row built from its schema (so each field's editableBy is exercised)
const sample = (f, i) => {
  switch (f.type) {
    case 'number': return 7 + i; case 'boolean': return false; case 'date': return '2026-10-01'; case 'time': return '10:00';
    case 'select': return (f.options && f.options[0]) || 'x'; case 'tags': case 'people': case 'files': case 'specs': case 'roles': return [];
    default: return `v${i}`;
  }
};
for (const s of DEFAULT_SCHEMAS) {
  if (fx[s.id]) continue;
  const row = { id: `g-${s.id}`, shortId: `X-0001`, recVersion: 1 };
  s.fields.forEach((f, i) => { row[f.key] = sample(f, i); });
  if (s.fields.some((f) => f.key === 'unit')) row.unit = U1;
  fx[s.id] = [row];
}
for (const c of ALL) if (!fx[c]) fx[c] = [];

// ---------------------------------------------------------------------------------------------------- principals
const principals = [];
const roleOf = (id) => DEFAULT_ROLES.find((r) => r.id === id);
const mk = (roleId, extra = {}) => ({ roleId, role: roleOf(roleId), name: `${roleOf(roleId).name} P`, unit: '', blocks: [], community: 'la-paloma', userId: `u-${roleId}`, ...extra });
for (const r of DEFAULT_ROLES) {
  if (r.category === 'Resident') { principals.push(mk(r.id, { unit: U1, name: 'Asha' })); principals.push(mk(r.id, { unit: U2, name: 'Chitra' })); principals.push(mk(r.id, { unit: '', name: 'Nounit' })); }
  else principals.push(mk(r.id, r.id === 'treasurer' ? { name: 'Treasurer T' } : r.id === 'facility_manager' ? { name: 'FM' } : {}));
}
principals.push(mk('general_secretary', { blocks: ['A'], name: 'Secretary' }));
principals.push(mk('facility_manager', { blocks: ['B'], name: 'FM' }));
principals.push(mk('treasurer', { blocks: ['A', 'B'], name: 'Treasurer T' }));
const principalSlim = principals.map((p) => ({ roleId: p.roleId, name: p.name, unit: p.unit, blocks: p.blocks }));

// ---------------------------------------------------------------------------------------------------- the questions
const schemaOf = (c) => DEFAULT_SCHEMAS.find((s) => s.id === c);
const readRaw = async (c) => fx[c] || [];
const clone = (v) => JSON.parse(JSON.stringify(v));
const CTX_VARIANTS = [
  { second: ['treasurer', 'president'], ecFinal: true },
  { second: ['treasurer'], ecFinal: false },
];
const WRITE_COLLECTIONS_WITH_CTX = new Set([C.TICKETS, C.CULTURAL_EXPENSES, C.QUOTATIONS, C.RELEASES]);
const STATUS_VALUES = ['Approved', 'Closed', 'Cancelled', 'Paid', 'Completed', 'Pending', 'Rejected', 'Waiting approval', 'Pending approval', 'Sent', 'Hidden', 'Published', 'Open', 'Received', 'Denied'];
const mutations = (row) => {
  const out = [];
  for (const k of Object.keys(row)) {
    if (['id', 'shortId', 'recVersion'].includes(k)) continue;
    const v = row[k];
    if (/status|approval/i.test(k) && typeof v === 'string') STATUS_VALUES.filter((x) => x !== v).slice(0, 7).forEach((x) => out.push([k, x]));
    else if (typeof v === 'string') out.push([k, `${v}x`]);
    else if (typeof v === 'number') out.push([k, v + 1]);
    else if (typeof v === 'boolean') out.push([k, !v]);
    else if (Array.isArray(v)) out.push([k, [...v, k === 'affectedUnits' || k === 'votes' ? U1 : { name: 'Asha', unit: U1, phone: '1' }]]);
    else if (v === undefined) continue;
  }
  if ('unit' in row) { out.push(['unit', U1]); out.push(['unit', U2]); out.push(['unit', '']); }
  // a field the row does not have yet
  out.push(['_probe', 'x']);
  return out;
};
const tuples = [];   // writes: [principal, collection, ctx, op, rowIdx, key, valueJson, ok, reason, blockOk]
const reads = [];    // reads:  [principal, collection, canRead, canWrite, hidden[], scopeSql|null, hasPredicate, keptRowsCanonJson, maskedAllRowsCanonJson]

const { setSecondStepRoles, setFinalCanDecideEC } = authz;
for (let pi = 0; pi < principals.length; pi += 1) {
  const p = principals[pi];
  for (const c of ALL) {
    const schema = schemaOf(c);
    const rows = fx[c];
    // ---- reads
    setSecondStepRoles(CTX_VARIANTS[0].second); setFinalCanDecideEC(true);
    const canR = authz.canReadCollection(c, p);
    const canW = authz.canWriteCollection(c, p);
    const hidden = authz.hiddenFieldKeys(schema, p.roleId, p);
    const scope = await authz.rowScope(c, p, readRaw);
    let kept = rows;
    if (scope.predicate) kept = kept.filter(scope.predicate);
    if (scope.transform) kept = kept.map(scope.transform);
    kept = kept.map((r) => authz.maskRecord(r, schema, p.roleId, p));
    reads.push([pi, c, canR ? 1 : 0, canW ? 1 : 0, hidden, scope.sql ? canon(scope.sql) : 0, scope.predicate ? 1 : 0, canon(kept)]);
    // ---- writes
    const variants = WRITE_COLLECTIONS_WITH_CTX.has(c) ? CTX_VARIANTS : [CTX_VARIANTS[0]];
    for (let vi = 0; vi < variants.length; vi += 1) {
      setSecondStepRoles(variants[vi].second); setFinalCanDecideEC(variants[vi].ecFinal);
      const push = async (op, ri, key, val) => {
        const old = ri == null || op === 'create' ? null : clone(rows[ri]);
        let next = op === 'create' ? clone(rows[ri ?? 0] || { id: 'new' }) : op === 'delete' ? clone(old ?? {}) : clone(old);
        if (op === 'create') { next.id = 'new-1'; delete next.shortId; delete next.recVersion; }
        if (key != null) next[key] = clone(val);
        let v;
        try { v = authz.authorizeWrite({ collection: c, p, schema, old, next, op }); } catch (e) { v = { ok: false, reason: `THROWS:${e.message}` }; }
        let bo;
        try { bo = await authz.blockWriteOk(c, op === 'delete' ? old : next, old, p, readRaw); } catch (e) { bo = null; }
        tuples.push([pi, c, vi, op, ri == null ? -1 : ri, key, key == null ? 0 : JSON.stringify(val), v.ok ? 1 : 0, v.ok ? 0 : v.reason, bo ? 1 : 0]);
      };
      if (rows.length === 0) { await push('create', null, null); continue; }
      await push('create', 0, null);
      for (let ri = 0; ri < rows.length && ri < 6; ri += 1) {
        await push('update', ri, null);
        await push('delete', ri, null);
        for (const [k, v] of mutations(rows[ri])) await push('update', ri, k, v);
      }
    }
  }
}

const gold = { clock: '2026-10-19T12:00:00Z', ctxVariants: CTX_VARIANTS, principals: principalSlim, fixtures: fx, writes: tuples, reads };
const json = JSON.stringify(gold);
const gz = zlib.gzipSync(Buffer.from(json), { level: 9 });
fs.writeFileSync(path.join(OUT, 'test/resources/rulebook/golden.json.gz'), gz);
console.log(`principals=${principals.length} collections=${ALL.length} writes=${tuples.length} reads=${reads.length} json=${(json.length / 1e6).toFixed(1)}MB gz=${(gz.length / 1e6).toFixed(2)}MB sha=${crypto.createHash('sha1').update(json).digest('hex').slice(0, 10)}`);
const ok = tuples.filter((t) => t[7]).length;
console.log(`allowed=${ok} denied=${tuples.length - ok}`);

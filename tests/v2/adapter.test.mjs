// The app's v2 adapter, sign-in and payment gateway against a fake of the typed API (same paths, headers and JSON as backend/api's
// controllers). Run: node tests/v2/run.mjs   (bundles this file with esbuild, then runs it with node:test)
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- browser bits the app touches ----------------------------------------------------------------------------------------------------------
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.sessionStorage = { ...globalThis.localStorage };
globalThis.window = globalThis.window || { location: new URL('http://palm-meadows.localhost/'), dispatchEvent: () => true, addEventListener: () => {} };
globalThis.window.location = new URL('http://localhost/?c=palm-meadows');

// ---- a fake of /api/v1 -----------------------------------------------------------------------------------------------------------------------
const calls = [];
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', M1 = '33333333-3333-4333-8333-333333333333';
const HALL = '00000000-0000-4000-8000-00000000a001', CHAIRS = '00000000-0000-4000-8000-00000000c001';
const state = {
  units: [
    { id: A, shortId: 'UNIT-1', unitNo: 'Villa 101', blockId: null, blockName: 'Block 1', unitType: 'Villa', occupancy: 'Owner occupied', areaSqft: '2400.00', maintenancePlan: 'Monthly', sanctionedKw: null, status: 'Active', custom: {}, updatedAt: '2026-10-20T06:00:00Z', version: 4 },
    { id: B, shortId: 'UNIT-2', unitNo: 'Villa 202', blockId: null, blockName: 'Block 2', unitType: 'Villa', occupancy: 'Vacant', areaSqft: null, maintenancePlan: null, sanctionedKw: null, status: 'Active', custom: {}, updatedAt: '2026-10-20T06:00:00Z', version: 1 },
  ],
  dues: [], members: [{ id: M1, displayName: 'Asha', phone: '+919800000001', status: 'Active', roles: [{ code: 'owner', name: 'Owner', primary: true }], units: [A], createdAt: null, updatedAt: null, version: 2 }],
  orders: [], tickets: [], comments: [], quotes: [], bookings: [], kit: {
    'amenities/types': [{ id: HALL, shortId: 'AMN-1', name: 'Party Hall', rate: '5000.00', capacity: 1, bookingMode: 'Full day', version: 1 }],
    'amenities/items': [],
    'maintenance/task-types': [{ id: 'tt-res', shortId: 'TT-1', name: 'Resident Maintenance', icon: '🔧', creatorScope: 'Resident', assignmentMode: 'Role queue (staff accepts)', residentVisible: true, residentDefault: true, active: true, version: 1 },
      { id: 'tt-pur', shortId: 'TT-2', name: 'Purchase', icon: '🧾', creatorScope: 'EC / Staff', assignmentMode: 'Direct assign', residentVisible: false, residentDefault: false, active: true, version: 1 }],
    'maintenance/categories': [{ id: 'cat-1', category: 'Plumbing', subCategories: ['Leakage'], coordinator: ['facility_manager'], assetLink: null, vendor: null, notes: null, version: 1 }],
    'maintenance/quick-phrases': [{ id: 'qp-1', phrase: 'Send a plumber', category: 'Plumbing', version: 1 }],
    'finance/settings': [{ id: '00000000-0000-4000-8000-0000000000f5', shortId: 'FS-1', approvalSeparate: false, finalCanDecideEc: true, invoiceTolerancePct: '5.00', invoiceSkipWithinQuote: false, version: 3 }],
  }, staff: [{ id: 'fs-1', shortId: 'HMN-0001', membershipId: 'm-plumber', name: 'Ravi Plumber', trade: 'Plumbing', shift: 'Morning', phone: null, clockedIn: false, version: 1 }],
};
let uuidSeq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;
const KIT_FIELDS = {
  'maintenance/task-types': ['name', 'icon', 'creatorScope', 'assignmentMode', 'quotationStage', 'ecApprovalStage', 'treasurerStage', 'invoiceStage', 'paymentStage', 'residentVisible', 'residentDefault', 'active'],
  'maintenance/categories': ['category', 'subCategories', 'vendor', 'assetLink', 'coordinator', 'notes'],
  'maintenance/quick-phrases': ['phrase', 'category'],
  'maintenance/wishes': ['title', 'description', 'category', 'location', 'unitId', 'status', 'estimate', 'decisionNote'],
  'finance/settings': ['approvalSeparate', 'finalCanDecideEc', 'invoiceTolerancePct', 'invoiceSkipWithinQuote'],
  'amenities/types': ['name', 'rate', 'capacity', 'bookingMode'],
  'amenities/items': ['name', 'amenityTypeId', 'stock', 'price', 'perLabel', 'maxPerBooking', 'active'],
};
const KIT_COLLECTION = { 'amenities/types': 'amenityTypes', 'amenities/items': 'amenityItems', 'maintenance/task-types': 'taskTypes', 'maintenance/categories': 'categoryMap', 'maintenance/quick-phrases': 'quickPhrases', 'maintenance/wishes': 'wishes', 'finance/settings': 'financeSettings' };
const TT = [{ id: 'tt-res', name: 'Resident Maintenance', icon: '🔧', creatorScope: 'Resident', assignmentMode: 'Role queue (staff accepts)', residentVisible: true, residentDefault: true, canRaise: true }];
const page = (items) => ({ items, total: items.length, limit: 200, offset: 0 });
const ok = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const problem = (status, code, detail) => ok({ status, code, detail }, status);
let seq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const path = u.pathname.replace(/^\/api\/v1/, ''); const method = (init.method || 'GET').toUpperCase();
  const h = init.headers || {}; const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, path: path + u.search, headers: h, body });
  if (!path.startsWith('/public') && !path.startsWith('/auth') && h.Authorization !== 'Bearer tok-1') return problem(401, 'unauthenticated', 'Sign in');
  if (/^\/public\/communities\/[a-z0-9-]+$/.test(path)) return ok({ id: 'c0ffee00-0000-4000-8000-000000000001', slug: 'palm-meadows', name: 'Palm Meadows', status: 'Active' });
  if (path === '/auth/otp') return ok({ challengeId: 'ch-1', expiresInSeconds: 300 }, 202);
  if (path === '/auth/token') return body.code === '123456' ? ok({ status: 'signed-in', accessToken: 'tok-1', tokenType: 'Bearer', expiresAt: new Date(Date.now() + 600e3).toISOString() }) : problem(401, 'unauthenticated', 'The code is wrong or has expired');
  if (path === '/me') return ok({ membershipId: M1, personId: 'p', communityId: 'c', displayName: 'Asha', category: 'Resident', roles: ['owner'], permissions: [], units: [A], blocks: [], trade: null });
  if (path === '/roles') return ok([{ code: 'owner', name: 'Owner', category: 'Resident', permissions: [] }, { code: 'treasurer', name: 'Treasurer', category: 'EC', permissions: ['MANAGE_DUES'] }]);
  let m;
  if (path === '/units') return ok(page(state.units));
  if ((m = /^\/units\/([^/]+)$/.exec(path))) {
    const unit = state.units.find((x) => x.id === m[1]); if (!unit) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(unit, 200, { ETag: `"${unit.version}"` });
    if (h['If-Match'] !== `"${unit.version}"`) return problem(409, 'conflict', 'changed');
    Object.assign(unit, body, { version: unit.version + 1 }); return ok(unit);
  }
  if (path === '/members' && method === 'GET') return ok(page(state.members));
  if (path === '/members' && method === 'POST') { const nm = { id: `m-${++seq}`, displayName: body.displayName, phone: body.phone, status: 'Active', roles: [{ code: body.roleCode, name: body.roleCode, primary: true }], units: body.unitId ? [body.unitId] : [], version: 1 }; state.members.push(nm); return ok(nm, 201); }
  if ((m = /^\/members\/([^/]+)(\/roles|\/deactivate)?$/.exec(path))) {
    const mm = state.members.find((x) => x.id === m[1]); if (!mm) return problem(404, 'not-found', 'Not found');
    if (m[2] === '/roles') { mm.roles = body.roleCodes.map((c) => ({ code: c, name: c, primary: c === body.primaryRoleCode })); mm.version++; }
    return ok(mm);
  }
  if (path.startsWith('/dues') && method === 'GET' && path === '/dues') return ok(page(state.dues));
  if (path === '/dues' && method === 'POST') {
    const total = (Number(body.amount) * (body.categoryCode === 'Maintenance' ? 1.18 : 1)).toFixed(2);
    const d = { id: `d-${++seq}`, shortId: `DUE-000${seq}`, unitId: body.unitId, unitNo: state.units.find((x) => x.id === body.unitId).unitNo, categoryCode: body.categoryCode, category: body.categoryCode, utility: false, billedMonth: body.billedMonth, description: body.description, amount: body.amount, tax: (total - body.amount).toFixed(2), total, paid: '0.00', outstanding: total, dueDate: body.dueDate, status: 'Unpaid', paidAt: null, reason: null, version: 1 };
    state.dues.push(d); return ok(d, 201);
  }
  if ((m = /^\/dues\/([^/]+)(\/cancel|\/waive)?$/.exec(path))) {
    const d = state.dues.find((x) => x.id === m[1]); if (!d) return problem(404, 'not-found', 'Not found');
    if (m[2]) { if (h['If-Match'] !== `"${d.version}"`) return problem(409, 'conflict', 'changed'); d.status = m[2] === '/cancel' ? 'Cancelled' : 'Waived'; d.reason = body.reason; d.version++; }
    return ok(d);
  }
  if (path === '/payment-orders' && method === 'POST' && !body.purpose) {
    const dues = body.dueIds.map((id) => state.dues.find((x) => x.id === id));
    const amount = dues.reduce((s, d) => s + Number(d.outstanding), 0).toFixed(2);
    const o = { id: `o-${++seq}`, shortId: `ORD-${seq}`, unitId: dues[0].unitId, amount, currency: 'INR', status: 'Pending', provider: 'simulated', expiresAt: null, items: dues.map((d) => ({ dueId: d.id, amount: d.outstanding })), checkout: { provider: 'simulated', providerOrderRef: `sim_order_${seq}`, amount, currency: 'INR' } };
    state.orders.push(o); return ok(o, 201);
  }
  if ((m = /^\/dev\/simulated-checkout\/(.+)$/.exec(path))) return ok({ providerPaymentRef: 'sim_pay_1', signature: 'sig' });
  if ((m = /^\/payment-orders\/([^/]+)\/confirm$/.exec(path))) {
    const o = state.orders.find((x) => x.id === m[1]); o.status = 'Paid'; o.paymentId = 'aaaaaaaa-0000-4000-8000-00000000pay1'.replace('pay1', '0001');
    for (const it of o.items) { const d = state.dues.find((x) => x.id === it.dueId); d.status = 'Paid'; d.outstanding = '0.00'; d.paid = d.total; }
    return ok({ paymentId: 'pay-1', receiptNo: 'RCP-0001', unitId: o.unitId, orderId: o.id, amount: o.amount, method: 'UPI', provider: 'simulated', receivedAt: new Date().toISOString(), allocations: [], keptAsCredit: '0.00' });
  }
  if ((m = /^\/payment-orders\/([^/]+)$/.exec(path))) return ok(state.orders.find((x) => x.id === m[1]));
  if (path === '/task-types') return ok(TT);
  if (path === '/amenities/availability') return ok([{ amenityTypeId: HALL, date: '2026-11-01', slot: 'Full day', bookings: 2, items: { [CHAIRS]: 30 } }]);
  if (path === '/amenities/bookings' && method === 'GET') return ok(state.bookings);
  if (path === '/amenities/bookings' && method === 'POST') {
    const extra = Object.keys(body).filter((k) => !['amenityTypeId', 'unitId', 'date', 'slot', 'paymentMode', 'prepaymentId', 'useCredit', 'bookedFor', 'association', 'freeOfCharge', 'waiveReason', 'extras'].includes(k));
    if (extra.length) return problem(400, 'bad-request', `unknown properties ${extra}`);
    const b = { id: uuid(), shortId: `BKG-${++seq}`, amenityTypeId: body.amenityTypeId, amenity: 'Party Hall', unitId: body.unitId, unitNo: 'Villa 101', date: body.date, slot: 'Full day',
      startAt: `${body.date}T03:30:00Z`, status: body.prepaymentId ? 'Confirmed' : 'Pending payment', paymentMode: body.paymentMode, paymentStatus: body.prepaymentId ? 'Paid' : 'Pending',
      bookedFor: 'Unit', feeTotal: '5900.00', depositAmount: '2000.00', totalPayable: '7900.00', extras: [], policySnapshot: [{ hoursBefore: '72', refundPct: '100' }], depositStatus: 'Held',
      refundStatus: 'None', version: 1 };
    state.bookings.push(b); return ok(b, 201);
  }
  if ((m = /^\/amenities\/bookings\/([^/]+)(?:\/([a-z-]+))?$/.exec(path))) {
    const b = state.bookings.find((x) => x.id === m[1]); if (!b) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(b);
    if (h['If-Match'] !== `"${b.version}"`) return problem(409, 'conflict', 'changed');
    if (m[2] === 'cancel') { b.status = 'Cancelled'; b.refundStatus = body.refundToCredit ? 'Credited to unit account' : 'Refund due'; b.cancelReason = body.reason; }
    if (m[2] === 'payment') { b.paymentStatus = 'Paid'; b.status = 'Confirmed'; b.paymentMode = body.mode; }
    if (m[2] === 'deposit') { b.depositStatus = body.deduction > 0 ? 'Partly forfeited' : 'Released'; }
    b.version++; return ok(b);
  }
  if (path === '/payment-orders' && method === 'POST' && body.purpose === 'booking') {
    const o = { id: `o-${++seq}`, shortId: `ORD-${seq}`, purpose: 'booking', unitId: body.unitId, amount: body.amount, currency: 'INR', status: 'Pending', provider: 'simulated', items: [],
      checkout: { provider: 'simulated', providerOrderRef: `sim_order_${seq}`, amount: body.amount, currency: 'INR' }, paymentId: null };
    state.orders.push(o); return ok(o, 201);
  }
  if (path === '/meta/resources') return ok(Object.entries(KIT_FIELDS).map(([p, fields]) => ({ collection: KIT_COLLECTION[p], path: p, fields, readOnly: [], filters: [] })));
  if (path === '/quotations' && method === 'GET') return ok(state.quotes);
  if ((m = /^\/tickets\/([^/]+)\/quotations$/.exec(path)) && method === 'POST') {
    const amount = body.gstMode === 'Extra' ? (Number(body.amount) * (1 + body.gstRate / 100)).toFixed(2) : body.amount;
    const q = { id: uuid(), shortId: `QUO-${++seq}`, ticketId: m[1], ...body, amount, baseAmount: body.amount, selected: body.kind === 'Invoice', ecApproval: 'Pending', finalApproval: 'Pending',
      plan: { version: 1, steps: [{ id: 's1', name: 'EC', approvers: [{ kind: 'group', value: 'EC members' }], needed: 1, canFinish: true, decisions: [] }, { id: 's2', name: 'Final approval', approvers: [{ kind: 'group', value: 'Final approvers' }], needed: 1, decisions: [] }] },
      status: 'Received', whyNotMe: null, version: 1 };
    state.quotes.push(q); return ok(q, 201);
  }
  if ((m = /^\/quotations\/([^/]+)(\/[a-z-]+)?$/.exec(path))) {
    const q = state.quotes.find((x) => x.id === m[1]); if (!q) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(q);
    if (h['If-Match'] !== `"${q.version}"`) return problem(409, 'conflict', 'changed');
    if (method === 'DELETE') { state.quotes = state.quotes.filter((x) => x !== q); return ok(null, 204); }
    if (m[2] === '/select') q.selected = true;
    if (m[2] === '/decision') { q.plan.steps[0].decisions.push({ by: M1, name: 'Asha', at: '2026-10-20T10:00:00Z', value: body.value, comment: body.comment }); q.ecApproval = body.value; q.ecApprovedBy = 'Asha'; }
    if (m[2] === '/send-back') q.correctionNote = body.note;
    q.version++; return ok(q);
  }
  if ((m = /^\/(maintenance|finance|amenities)\/([a-z-]+)(?:\/([^/]+))?$/.exec(path)) && KIT_FIELDS[`${m[1]}/${m[2]}`]) {
    const key = `${m[1]}/${m[2]}`; const rows = (state.kit[key] ||= []);
    if (!m[3] && method === 'GET') return ok(rows);
    if (!m[3] && method === 'POST') {
      const extra = Object.keys(body).filter((k) => !KIT_FIELDS[key].includes(k));
      if (extra.length) return problem(400, 'bad-request', `unknown properties ${extra}`);
      const r = { id: uuid(), shortId: `K-${++seq}`, version: 1, ...body, ...(key === 'maintenance/wishes' ? { status: 'Submitted', unit: state.units.find((x) => x.id === body.unitId)?.unitNo || null, raisedBy: 'Asha', votes: [] } : {}) };
      rows.push(r); return ok(r, 201);
    }
    const r = rows.find((x) => x.id === m[3]); if (!r) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(r);
    if (h['If-Match'] !== `"${r.version}"`) return problem(409, 'conflict', 'changed');
    if (method === 'DELETE') { state.kit[key] = rows.filter((x) => x !== r); return ok(null, 204); }
    const extra = Object.keys(body).filter((k) => !KIT_FIELDS[key].includes(k));
    if (extra.length) return problem(400, 'bad-request', `unknown properties ${extra}`);
    Object.assign(r, body, { version: r.version + 1 }); return ok(r);
  }
  if (path === '/field-staff' && method === 'GET') return ok(state.staff);
  if ((m = /^\/field-staff\/([^/]+)$/.exec(path))) { const f = state.staff.find((x) => x.id === m[1]); if (h['If-Match'] !== `"${f.version}"`) return problem(409, 'conflict', 'changed'); f.clockedIn = body.clockedIn; f.version++; return ok(f); }
  if (path === '/ticket-comments') return ok(state.comments);
  if (path === '/tickets' && method === 'GET') return ok(page(state.tickets));
  if (path === '/tickets' && method === 'POST') {
    if (body.taskTypeId !== 'tt-res') return problem(422, 'unknown-task-type', 'no such type');
    const t = { id: `t-${++seq}`, shortId: `TKT-${1050 + seq}`, taskTypeId: body.taskTypeId, taskType: 'Resident Maintenance', title: body.title, description: body.description, unitId: body.unitId,
      unitNo: state.units.find((x) => x.id === body.unitId)?.unitNo, scope: body.scope, location: body.location, category: body.category, priority: body.priority, status: 'Open',
      assigneeId: null, assigneeName: null, slaDueAt: body.slaDueAt, affectedUnitIds: [], residentRating: null, raisedById: M1, raisedByName: 'Asha', raisedByRole: 'owner', awaitingParts: false,
      materialsCost: null, financial: false, createdAt: new Date().toISOString(), version: 1 };
    state.tickets.push(t); return ok(t, 201);
  }
  if ((m = /^\/tickets\/([^/]+)(\/[a-z-]+)?$/.exec(path))) {
    const t = state.tickets.find((x) => x.id === m[1]); if (!t) return problem(404, 'not-found', 'Not found');
    const verb = m[2] || '';
    if (verb === '/assignees') return ok([{ membershipId: 'm-plumber', name: 'Ravi Plumber', kind: 'Field staff', clockedIn: true, trade: 'Plumbing' }]);
    if (verb === '/comments' && method === 'POST') { const c = { id: `c-${++seq}`, shortId: `CMT-${seq}`, ticketId: t.id, authorId: M1, authorName: 'Asha', visibility: body.visibility, body: body.body, createdAt: new Date().toISOString() }; state.comments.push(c); return ok(c, 201); }
    if (method === 'GET') return ok(t);
    if (verb === '/rating') { t.residentRating = body.rating; t.version++; return ok(t); }
    if (verb === '/me-too') { if (method === 'POST') t.affectedUnitIds.push(body.unitId); else t.affectedUnitIds = t.affectedUnitIds.filter((x) => x !== u.searchParams.get('unit')); t.version++; return ok(t); }
    if (h['If-Match'] !== `"${t.version}"`) return problem(409, 'conflict', 'changed');
    if (verb === '') Object.assign(t, body);
    if (verb === '/assign') { t.assigneeId = body.assigneeId; t.assigneeName = body.assigneeId ? 'Ravi Plumber' : null; t.status = body.assigneeId ? 'Assigned' : 'Open'; }
    if (verb === '/status') { t.status = body.status; t.cancelReason = body.reason; }
    t.version++; return ok(t);
  }
  return problem(404, 'not-found', `no fake for ${method} ${path}`);
};

const { setDataSource } = await import('../../src/lib/storage/dataSource.js');
setDataSource({ mode: 'v2', baseUrl: 'http://api.test/api' });
const authApi = await import('../../src/lib/auth/authApi.js');
const { storage } = await import('../../src/lib/storage/index.js');
const last = (method, re) => [...calls].reverse().find((c) => c.method === method && re.test(c.path));

test('sign-in: the community from the page, a code, then who I am', async () => {
  const cfg = await authApi.loadAuthConfig();
  assert.equal(cfg.mode, 'enforce');
  assert.equal((await authApi.publicCommunity()).name, 'Palm Meadows');
  await authApi.requestCode({ phone: '+919800000001' });
  await assert.rejects(authApi.verifyCode({ phone: '+919800000001' }, '000000'), /wrong or has expired/);
  const r = await authApi.verifyCode({ phone: '+919800000001' }, '123456');
  assert.equal(last('POST', /^\/auth\/token/).body.communityId, 'c0ffee00-0000-4000-8000-000000000001', 'no community picker: the page says which');
  assert.equal(r.user.roleId, 'owner'); assert.deepEqual(r.user.units, ['Villa 101'], 'unit numbers, not ids');
  assert.equal(authApi.verifyInfo().roles[0].category, 'Resident');
  assert.equal(last('GET', /^\/me/).headers.Authorization, 'Bearer tok-1');
});

test('units: list mapped; a change sends only the changed, allowed fields with If-Match', async () => {
  const props = await storage.list('properties');
  assert.equal(props[0].unit, 'Villa 101'); assert.equal(props[0].areaSqft, 2400); assert.equal(props[0].zone, 'Block 1');
  const saved = await storage.put('properties', { ...props[0], occupancy: 'Tenant occupied', unit: 'Villa 999', createdBy: 'me', version: 4 });
  const c = last('PATCH', /^\/units\//);
  assert.deepEqual(c.body, { occupancy: 'Tenant occupied' }, 'the unit number and audit fields are never sent');
  assert.equal(c.headers['If-Match'], '"4"');
  assert.equal(saved.version, 5);
  await assert.rejects(storage.put('properties', { ...props[1], occupancy: 'Vacant', type: 'Apartment', version: 0 }), /changed/, 'stale version -> conflict');
});

test('bills: raised by POST (server prices tax), closed by cancel with a reason, never edited', async () => {
  const d = await storage.put('dues', { unit: 'Villa 101', category: 'Maintenance', amount: 3000, billedMonth: 'Oct 2026', dueDate: '2026-10-10', status: 'Unpaid' });
  const c = last('POST', /^\/dues$/);
  assert.deepEqual(c.body, { unitId: A, categoryCode: 'Maintenance', billedMonth: '2026-10-01', description: null, amount: '3000.00', dueDate: '2026-10-10' });
  assert.equal(d.amount, 3540); assert.equal(d.tax, 540); assert.equal(d.billedMonth, 'Oct 2026');
  const n = calls.length;
  await storage.put('dues', { ...d, amount: 1 });
  assert.equal(calls.filter((x) => x.method !== 'GET').length, calls.slice(0, n).filter((x) => x.method !== 'GET').length, 'an amount edit sends nothing');
  const cancelled = await storage.put('dues', { ...d, status: 'Cancelled', cancelReason: 'raised twice' });
  assert.equal(last('POST', /\/cancel$/).body.reason, 'raised twice'); assert.equal(last('POST', /\/cancel$/).headers['If-Match'], '"1"');
  assert.equal(cancelled.status, 'Cancelled');
  await assert.rejects(storage.remove('dues', d.id), /cancel it/);
});

test('members: new member is a POST, a role change a PUT with If-Match', async () => {
  const u = await storage.put('users', { name: 'Ravi', phone: '+919800000002', roleId: 'resident', units: ['Villa 202'] });
  assert.equal(last('POST', /^\/members$/).body.unitId, B);
  await storage.put('users', { ...u, roleId: 'helpdesk', extraRoleIds: [] });
  assert.deepEqual(last('PUT', /\/roles$/).body, { roleCodes: ['helpdesk'], primaryRoleCode: 'helpdesk' });
  assert.equal((await storage.list('roles')).find((r) => r.id === 'treasurer').permissions[0], 'MANAGE_DUES');
});

test('not yet on v2: reads are empty, writes refused loudly', async () => {
  assert.deepEqual(await storage.list('gatePasses'), []);
  await assert.rejects(storage.put('gatePasses', { id: 'p1' }), /not on the v2 back end yet/);
});

test('paying: the server prices, the simulator pays, confirm settles', async () => {
  const d = await storage.put('dues', { unit: 'Villa 101', category: 'Water', amount: 420, billedMonth: '2026-10', dueDate: '2026-10-15' });
  const { pay } = await import('../../src/lib/payments/index.js');
  const res = await pay({ purpose: 'due', refs: [d.id], amount: 1, unit: 'Villa 101' }, async () => ({ outcome: 'success', method: 'UPI' }));
  assert.equal(res.status, 'Paid');
  const create = last('POST', /^\/payment-orders$/);
  assert.deepEqual(create.body, { dueIds: [d.id] }, 'no amount from the browser');
  assert.match(create.headers['Idempotency-Key'], /^pay-[0-9a-f-]{36}$/);
  assert.equal(last('POST', /\/confirm$/).body.providerPaymentRef, 'sim_pay_1');
});

test('tickets: raise (no SLA from a resident), accept, work, close, rate; comments; field staff clock', async () => {
  const types = await storage.list('taskTypes');
  assert.equal(types[0].name, 'Resident Maintenance');
  const t = await storage.put('tickets', { id: 'client-id', taskType: 'Resident Maintenance', title: 'Leak in kitchen', description: 'Under the sink', unit: 'Villa 101', category: 'Plumbing',
    priority: 'High', status: 'Open', assignedTo: '', slaDueAt: '2026-10-25', scope: 'Unit', location: '', affectedUnits: [], attachments: [], residentRating: 0, createdBy: 'Asha', paymentStatus: 'Not Paid' });
  const raise = last('POST', /^\/tickets$/);
  assert.equal(raise.body.unitId, A); assert.equal(raise.body.taskTypeId, 'tt-res'); assert.equal(raise.body.slaDueAt, null, 'the committee sets the SLA');
  assert.equal(Object.keys(raise.body).includes('createdBy'), false, 'who raised it is the server\'s');
  assert.equal(t.ticketNumber, 'TKT-' + t.shortId.slice(4)); assert.equal(t.unit, 'Villa 101');
  const a = await storage.put('tickets', { ...t, status: 'Assigned', assignedTo: 'Ravi Plumber' });
  assert.deepEqual(last('POST', /\/assign$/).body, { assigneeId: 'm-plumber' }); assert.equal(a.status, 'Assigned');
  assert.equal(calls.filter((c) => /\/status$/.test(c.path)).length, 0, 'accepting is an assign, not a status change');
  const w = await storage.put('tickets', { ...a, status: 'In Progress', awaitingParts: true });
  assert.deepEqual(last('PATCH', /^\/tickets\//).body, { awaitingParts: true });
  assert.equal(last('POST', /\/status$/).body.status, 'In Progress');
  const closed = await storage.put('tickets', { ...w, status: 'Closed' });
  const rated = await storage.put('tickets', { ...closed, residentRating: 4 });
  assert.equal(last('POST', /\/rating$/).body.rating, 4); assert.equal(rated.residentRating, 4);
  const before = calls.filter((x) => x.method !== 'GET').length;
  await storage.put('tickets', { ...rated, quotationStatus: 'Requested', approvedAmount: 99 });
  assert.equal(calls.filter((x) => x.method !== 'GET').length, before, 'the money side of a ticket is never written on the ticket');
  await assert.rejects(storage.put('tickets', { id: 'x', title: 'With photo', category: 'Plumbing', attachments: [{ id: 'f1' }] }), /photos and files/);
  await assert.rejects(storage.remove('tickets', t.id), /cancel or close/);
  await storage.put('ticketComments', { ticketId: t.id, body: 'Coming at 4', visibility: 'Public', author: 'Asha', createdAt: new Date().toISOString() });
  assert.equal(last('POST', /\/comments$/).body.body, 'Coming at 4');
  assert.equal((await storage.list('ticketComments')).length, 1);
  const staff = await storage.list('handymen');
  const clocked = await storage.put('handymen', { ...staff[0], clockedIn: true });
  assert.equal(last('PATCH', /^\/field-staff\//).headers['If-Match'], '"1"'); assert.equal(clocked.clockedIn, true);
  assert.equal((await storage.list('categoryMap'))[0].coordinator[0], 'facility_manager');
  assert.equal((await storage.list('quickPhrases'))[0].phrase, 'Send a plumber');
});

test('registers through the resource kit: exactly the request type, units by number, If-Match, a singleton', async () => {
  const types = await storage.list('taskTypes');
  assert.deepEqual(types.map((t) => [t.name, t.canRaise]), [['Resident Maintenance', true], ['Purchase', false]], 'all types, and which I may raise');
  const w = await storage.put('wishes', { id: 'local-1', title: 'Shade over the park', description: '', unit: 'Villa 101', votes: ['x'], raisedBy: 'someone', createdAt: 'now' });
  const post = last('POST', /^\/maintenance\/wishes$/);
  assert.deepEqual(post.body, { title: 'Shade over the park', description: null, unitId: A }, 'only the request type\'s fields; the unit number becomes its id; who raised it is the server\'s');
  assert.equal(w.unit, 'Villa 101'); assert.equal(w.status, 'Submitted'); assert.equal(w.raisedBy, 'Asha');
  const w2 = await storage.put('wishes', { ...w, title: 'Shade over the kids\' park' });
  const put = last('PUT', /^\/maintenance\/wishes\//);
  assert.equal(put.headers['If-Match'], '"1"'); assert.equal(put.body.title, 'Shade over the kids\' park'); assert.equal(put.body.unitId, A); assert.equal(w2.version, 2);
  assert.equal(Object.keys(put.body).includes('votes'), false);
  await storage.remove('wishes', w.id);
  assert.equal(last('DELETE', /^\/maintenance\/wishes\//).headers['If-Match'], '"2"');
  const s = await storage.put('financeSettings', { id: 'whatever', finalCanDecideEC: false, invoiceTolerancePct: 10 });
  const sp = last('PUT', /^\/finance\/settings\//);
  assert.equal(sp.body.finalCanDecideEc, false, 'renamed for the API'); assert.equal(sp.body.invoiceTolerancePct, 10); assert.equal(sp.headers['If-Match'], '"3"', 'the one settings row');
  assert.equal(s.finalCanDecideEC, false, 'and back');
  assert.equal((await storage.list('categoryMap'))[0].coordinator[0], 'facility_manager');
});

test('quotations: add what is written, select, decide on the plan, send back; amounts are never edited', async () => {
  const q = await storage.put('quotations', { ticketId: 'tk-1', kind: 'Quotation', vendor: 'Aqua', baseAmount: 10000, amount: 11800, gstMode: 'Extra', gstRate: 18, selected: true });
  assert.deepEqual(last('POST', /\/quotations$/).body, { kind: 'Quotation', vendor: 'Aqua', amount: '10000.00', gstMode: 'Extra', gstRate: 18, quoteDate: null, note: null });
  assert.equal(last('POST', /\/select$/).headers['If-Match'], '"1"'); assert.equal(q.selected, true); assert.equal(q.amount, 11800);
  const plan = JSON.parse(q.plan);
  plan.steps[0].decisions.push({ by: 'Asha', at: '2026-10-20', value: 'Approved', comment: 'fine' });
  const d = await storage.put('quotations', { ...q, plan: JSON.stringify(plan), ecApproval: 'Approved' });
  assert.deepEqual(last('POST', /\/decision$/).body, { value: 'Approved', comment: 'fine', finish: false });
  assert.equal(d.ecApproval, 'Approved'); assert.equal(JSON.parse(d.plan).steps[0].decisions[0].by, 'Asha', 'decisions carry names for the app');
  await assert.rejects(storage.put('quotations', { ...d, amount: 1 }), /not edited/);
  await storage.put('quotations', { ...d, correctionNote: 'wrong GSTIN' });
  assert.deepEqual(last('POST', /\/send-back$/).body, { note: 'wrong GSTIN' });
  await storage.remove('quotations', q.id);
  assert.equal(last('DELETE', /^\/quotations\//).method, 'DELETE');
});

test('bookings: a resident pays first (a prepayment), books with it; others\' bookings only as "taken"; actions are commands', async () => {
  const { pay } = await import('../../src/lib/payments/index.js');
  const res = await pay({ purpose: 'booking', refs: [], amount: 7900, unit: 'Villa 101' }, async () => ({ outcome: 'success', method: 'UPI' }));
  assert.equal(res.status, 'Paid', res.message);
  assert.deepEqual(last('POST', /^\/payment-orders$/).body, { purpose: 'booking', unitId: A, amount: '7900.00' }, 'a prepayment for my unit');
  const b = await storage.put('amenities', { amenity: 'Party Hall', unit: 'Villa 101', date: '2026-11-01', slot: 'Full day', paymentMode: 'UPI', paymentRef: res.paymentId, useCredit: false,
    extras: JSON.stringify({ [CHAIRS]: 20 }), totalPayable: 1, feeTotal: 1, status: 'Confirmed' });
  const post = last('POST', /^\/amenities\/bookings$/).body;
  assert.equal(post.amenityTypeId, HALL); assert.equal(post.unitId, A); assert.equal(post.prepaymentId, res.paymentId); assert.deepEqual(post.extras, { [CHAIRS]: 20 });
  assert.equal(Object.keys(post).includes('totalPayable'), false, 'the price is the server\'s');
  assert.equal(b.status, 'Confirmed'); assert.equal(b.totalPayable, 7900); assert.equal(b.unit, 'Villa 101');
  const all = await storage.list('amenities');
  const busy = all.filter((x) => x.busy);
  assert.equal(busy.length, 1, '2 taken on that day, 1 of them mine'); assert.equal(busy[0].unit, ''); assert.equal(busy[0].amenity, 'Party Hall');
  const c = await storage.put('amenities', { ...b, _action: 'cancel', cancelReason: 'plans changed', refundTo: 'credit' });
  assert.deepEqual(last('POST', /\/cancel$/).body, { reason: 'plans changed', refundToCredit: true, waive: false, refundOverride: null });
  assert.equal(last('POST', /\/cancel$/).headers['If-Match'], '"1"'); assert.equal(c.refundStatus, 'Credited to unit account');
  await assert.rejects(storage.put('amenities', { ...c, status: 'Confirmed' }), /booking actions/);
  await assert.rejects(storage.remove('amenities', b.id), /cancel them/);
  const item = await storage.put('amenityItems', { name: 'Chairs', amenity: 'Party Hall', stock: 100, price: 15, active: true });
  assert.equal(last('POST', /^\/amenities\/items$/).body.amenityTypeId, HALL, 'the amenity by name becomes its id');
  assert.equal(item.name, 'Chairs');
});

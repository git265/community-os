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
  files: [], cbook: [], releases: [], payreqs: [], blines: [], cdonations: [], expenses: [], documents: [], orders: [], tickets: [], comments: [], quotes: [], bookings: [], broadcasts: [], votes: {}, topics: [], posts: [],
  notes: [{ id: '00000000-0000-4000-8000-0000000ee001', createdAt: '2026-10-20T06:00:00Z', event: 'bill', kind: 'bill', title: 'New bill · ₹3,540', body: 'Due 15 Oct', link: '#/billing', refId: null, sender: 'Treasurer', readAt: null }],
  passes: [], approvals: [{ id: '00000000-0000-4000-8000-0000000aa001', shortId: 'GAP-1', name: 'Ravi Uncle', unit: A, unitNo: 'Villa 101', status: 'Pending', kind: 'Guest', version: 1 }], kit: {
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
  'cultural/events': ['name', 'status', 'visibility', 'budget', 'finalOver'],
  'cultural/seva': ['eventId', 'title', 'needed'],
  'cultural/offerings': ['eventId', 'title', 'kind', 'pledgeValue'],
  'vendors/vendors': ['name', 'category', 'gstin', 'contractType', 'service', 'contactPhone', 'contactEmail', 'address', 'contractEnds', 'description'],
  'vendors/service-lines': ['vendorId', 'service', 'signedWorkers', 'shift', 'note'],
  'assets/equipment': ['name', 'area', 'type', 'status', 'quantity', 'faulty', 'specs', 'lastInspected'],
  'assets/inventory': ['item', 'category', 'location', 'uom', 'minStock', 'vendor', 'notes'],
};
const KIT_COLLECTION = { 'amenities/types': 'amenityTypes', 'amenities/items': 'amenityItems', 'maintenance/task-types': 'taskTypes', 'maintenance/categories': 'categoryMap', 'maintenance/quick-phrases': 'quickPhrases', 'maintenance/wishes': 'wishes', 'finance/settings': 'financeSettings', 'cultural/events': 'culturalEvents', 'cultural/seva': 'culturalSevas', 'cultural/offerings': 'culturalOfferings', 'vendors/vendors': 'vendors', 'vendors/service-lines': 'vendorServices', 'assets/equipment': 'equipment', 'assets/inventory': 'inventory' };
const TT = [{ id: 'tt-res', name: 'Resident Maintenance', icon: '🔧', creatorScope: 'Resident', assignmentMode: 'Role queue (staff accepts)', residentVisible: true, residentDefault: true, canRaise: true }];
const page = (items) => ({ items, total: items.length, limit: 200, offset: 0 });
const ok = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const problem = (status, code, detail) => ok({ status, code, detail }, status);
let seq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const path = u.pathname.replace(/^\/api\/v1/, ''); const method = (init.method || 'GET').toUpperCase();
  const h = init.headers || {}; const body = init.body instanceof Blob ? init.body : init.body ? JSON.parse(init.body) : null;
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
  if (path === '/gate/passes' && method === 'GET') return ok(state.passes);
  if (path === '/gate/passes' && method === 'POST') {
    const extra = Object.keys(body).filter((k) => !['visitorName', 'phone', 'unitId', 'type', 'validFrom', 'validTo', 'fromTime', 'toTime', 'days', 'vehicle', 'guestCap', 'goodsKind', 'peopleCount', 'material', 'carryingOut', 'outItems', 'photo'].includes(k));
    if (extra.length) return problem(400, 'bad-request', `unknown properties ${extra}`);
    const p = { id: uuid(), shortId: `GPS-${++seq}`, ...body, unit: body.unitId, unitNo: 'Villa 101', code: '482913', status: 'Active', usedCount: 0, version: 1 }; state.passes.push(p); return ok(p, 201);
  }
  if ((m = /^\/gate\/passes\/([^/]+)\/(cancel|admit)$/.exec(path))) {
    const p = state.passes.find((x) => x.id === m[1]);
    if (m[2] === 'cancel') { if (h['If-Match'] !== `"${p.version}"`) return problem(409, 'conflict', 'changed'); p.status = 'Cancelled'; p.version++; return ok(p); }
    if (p.status !== 'Active') return problem(422, 'pass', 'This pass was cancelled');
    return ok({ ok: true, outcome: 'admitted', visit: { id: uuid(), shortId: 'GVS-1', name: p.visitorName, kind: 'Guest', unit: p.unit, unitNo: 'Villa 101', state: 'Inside', inAt: '2026-10-20T10:00:00Z', version: 1 } });
  }
  if (path === '/gate/approvals' && method === 'GET') return ok(state.approvals);
  if ((m = /^\/gate\/approvals\/([^/]+)\/answer$/.exec(path))) { const a = state.approvals.find((x) => x.id === m[1]); a.status = body.decision; a.alwaysAllow = body.always; return ok(a); }
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
  if ((m = /^\/(maintenance|finance|amenities|cultural|vendors|assets)\/([a-z-]+)(?:\/([^/]+))?$/.exec(path)) && KIT_FIELDS[`${m[1]}/${m[2]}`]) {
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
  // ---- files and documents
  if (path === '/files' && method === 'POST') {
    const bytes = new Uint8Array(await body.arrayBuffer());
    const f = { id: uuid(), shortId: `FIL-${state.files.length + 1}`, fileName: u.searchParams.get('name'), mimeType: h['Content-Type'], sizeBytes: bytes.length, ownerType: 'upload', ownerId: null, scanStatus: 'Pending', visibility: 'Owner', bytes, version: 1 };
    state.files.push(f); return ok(f, 201);
  }
  if (path === '/files' && method === 'GET') return ok(state.files.filter((f) => f.ownerType === u.searchParams.get('ownerType') && (!u.searchParams.get('ownerId') || f.ownerId === u.searchParams.get('ownerId'))));
  if ((m = /^\/files\/([^/]+)(\/content|\/attach)?$/.exec(path))) {
    const f = state.files.find((x) => x.id === m[1]); if (!f) return problem(404, 'not-found', 'Not found');
    if (m[2] === '/content') return new Response(f.bytes, { status: 200, headers: { 'Content-Type': f.mimeType } });
    if (m[2] === '/attach') { f.ownerType = body.ownerType; f.ownerId = body.ownerId; f.version++; return ok(f); }
    if (method === 'DELETE') { state.files = state.files.filter((x) => x !== f); return ok(null, 204); }
    return ok(f);
  }
  if (path === '/documents' && method === 'GET') return ok(state.documents);
  if (path === '/documents' && method === 'POST') {
    const f = state.files.find((x) => x.id === body.fileId); f.ownerType = 'docs.document';
    const d = { ...body, id: uuid(), shortId: 'DOC-1', fileName: f.fileName, fileSize: f.sizeBytes, mimeType: f.mimeType, scanStatus: 'Pending', version: 1 }; f.ownerId = d.id;
    state.documents.push(d); return ok(d, 201);
  }
  if ((m = /^\/documents\/([^/]+)$/.exec(path))) {
    const d = state.documents.find((x) => x.id === m[1]); if (!d) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(d);
    if (h['If-Match'] !== `"${d.version}"`) return problem(409, 'conflict', 'changed');
    if (method === 'DELETE') { state.documents = state.documents.filter((x) => x !== d); return ok(null, 204); }
    Object.assign(d, body); d.version++; return ok(d);
  }
  // ---- finance
  if (path === '/finance/cash-book' && method === 'GET') return ok(state.cbook);
  if (path === '/finance/cash-book' && method === 'POST') {
    if (body.type === 'Debit' && Number(body.amount) > 50000) return problem(422, 'needs-second-approver', 'Payments above 50000 need a second approver');
    const amount = body.baseAmount ? body.baseAmount * (1 + (body.gstRate || 0) / 100) - body.baseAmount * (body.tdsRate || 0) / 100 : body.amount;
    const e = { ...body, id: uuid(), shortId: `CB-${state.cbook.length + 1}`, amount: String(amount), reconStatus: 'Unreconciled', version: 1 }; state.cbook.push(e); return ok(e, 201);
  }
  if ((m = /^\/finance\/cash-book\/([^/]+)(\/[a-z]+)?$/.exec(path))) {
    const e = state.cbook.find((x) => x.id === m[1]); if (!e) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(e);
    if (m[2] === '/reverse') { if (h['If-Match'] !== `"${e.version}"`) return problem(409, 'conflict', 'changed'); const r = { ...e, id: uuid(), shortId: 'CB-R', type: e.type === 'Debit' ? 'Credit' : 'Debit', reversalOf: e.shortId, reason: body.reason, version: 1 }; state.cbook.push(r); return ok(r, 201); }
    if (m[2] === '/statement') { e.reconStatus = body.notApplicable ? 'Not applicable' : 'Unreconciled'; e.version++; return ok(e); }
    if (h['If-Match'] !== `"${e.version}"`) return problem(409, 'conflict', 'changed');
    Object.assign(e, body); e.version++; return ok(e);
  }
  if (path === '/finance/releases' && method === 'GET') return ok(state.releases);
  if (path === '/finance/releases' && method === 'POST') { const r = { ...body, id: uuid(), shortId: 'REL-1', status: 'Waiting approval', plan: null, version: 1 }; state.releases.push(r); return ok(r, 201); }
  if ((m = /^\/finance\/releases\/([^/]+)(\/[a-z]+)?$/.exec(path))) {
    const r = state.releases.find((x) => x.id === m[1]); if (!r) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(r);
    if (h['If-Match'] !== `"${r.version}"`) return problem(409, 'conflict', 'changed');
    if (m[2] === '/pay') { const e = { id: uuid(), shortId: 'CB-P', type: 'Debit', amount: r.amount, sourceType: 'release', sourceId: r.id, reconStatus: 'Unreconciled', version: 1 }; state.cbook.push(e); Object.assign(r, { status: 'Paid', paidEntryId: e.id }); }
    else if (m[2] === '/cancel') Object.assign(r, { status: 'Cancelled', cancelReason: body.reason });
    else if (m[2] === '/decision') r.status = body.value;
    else Object.assign(r, body);
    r.version++; return ok(r);
  }
  if (path === '/finance/pay-requests' && method === 'GET') return ok(state.payreqs);
  if (path === '/finance/pay-requests' && method === 'POST') { const p = { id: uuid(), shortId: 'PR-1', description: body.description, amount: String(body.amount), status: 'Waiting', payload: JSON.stringify(body), version: 1 }; state.payreqs.push(p); return ok(p, 201); }
  if ((m = /^\/finance\/pay-requests\/([^/]+)\/decision$/.exec(path))) { const p = state.payreqs.find((x) => x.id === m[1]); p.status = body.approve ? 'Approved' : 'Rejected'; p.version++; return ok(p); }
  if (path === '/finance/bank-lines' && method === 'GET') return ok(state.blines);
  if (path === '/finance/bank-lines/import') {
    let added = 0;
    for (const l of body.lines) { const key = `${body.account}|${l.date}|${l.narration}|${l.debit}|${l.credit}`; if (state.blines.some((x) => x.key === key)) continue; state.blines.push({ ...l, key, account: body.account, id: uuid(), shortId: 'BT', matchedEntryId: null, version: 1 }); added++; }
    return ok({ added, skipped: body.lines.length - added });
  }
  if ((m = /^\/finance\/bank-lines\/([^/]+)\/(match|unmatch)$/.exec(path))) {
    const l = state.blines.find((x) => x.id === m[1]); const e = state.cbook.find((x) => x.id === (m[2] === 'match' ? body.entryId : l.matchedEntryId));
    if (m[2] === 'match') { l.matchedEntryId = e.id; Object.assign(e, { reconStatus: 'Matched', bankTxnId: l.id }); } else { l.matchedEntryId = null; Object.assign(e, { reconStatus: 'Unreconciled', bankTxnId: null }); }
    return ok(l);
  }
  // ---- cultural
  if (path === '/cultural/donations' && method === 'GET') return ok(state.cdonations);
  if (path === '/cultural/donations' && method === 'POST') { const d = { ...body, id: uuid(), shortId: 'DON-1', status: body.received ? 'Received' : 'Pledged', receiptNo: null, unitNo: 'Villa 101', version: 1 }; delete d.received; state.cdonations.push(d); return ok(d, 201); }
  if ((m = /^\/cultural\/donations\/([^/]+)(\/[a-z-]+)?$/.exec(path))) {
    const d = state.cdonations.find((x) => x.id === m[1]); if (!d) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(d);
    if (h['If-Match'] !== `"${d.version}"`) return problem(409, 'conflict', 'changed');
    if (method === 'DELETE') { state.cdonations = state.cdonations.filter((x) => x !== d); return ok(null, 204); }
    if (m[2] === '/receive') Object.assign(d, { status: 'Received', receiptNo: 'DF26-0001', mode: body.mode });
    else if (m[2] === '/paid-online') Object.assign(d, { status: 'Received', receiptNo: 'DF26-0002', mode: 'Online', paymentId: body.prepaymentId });
    else Object.assign(d, body);
    d.version++; return ok(d);
  }
  if ((m = /^\/cultural\/events\/([^/]+)\/(expenses|credit)$/.exec(path))) {
    if (m[2] === 'credit') { const e = state.kit['cultural/events'].find((x) => x.id === m[1]); e.creditedAmount = String(body.amount); e.version++; return ok(e); }
    const x = { ...body, id: uuid(), shortId: 'EXP-1', eventId: m[1], status: 'Pending approval', ecApproval: 'Pending', plan: null, version: 1 }; state.expenses.push(x); return ok(x, 201);
  }
  if (path === '/cultural/expenses') return ok(state.expenses);
  if ((m = /^\/cultural\/expenses\/([^/]+)(\/[a-z]+)?$/.exec(path))) {
    const x = state.expenses.find((e) => e.id === m[1]); if (!x) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(x);
    if (h['If-Match'] !== `"${x.version}"`) return problem(409, 'conflict', 'changed');
    if (m[2] === '/decision') Object.assign(x, { ecApproval: body.value, status: body.value });
    else if (m[2] === '/pay') x.status = 'Paid';
    else Object.assign(x, body);
    x.version++; return ok(x);
  }
  if ((m = /^\/cultural\/(seva|programme)\/([^/]+)\/signup$/.exec(path))) {
    const r = state.kit['cultural/seva'].find((x) => x.id === m[2]); r.volunteers ||= [];
    if (method === 'POST') r.volunteers.push({ membershipId: M1, name: 'Asha', unit: 'Villa 101' }); else r.volunteers = r.volunteers.filter((v) => v.membershipId !== (u.searchParams.get('membershipId') || M1));
    r.version++; return ok({ id: r.id, list: r.volunteers });
  }
  // ---- comms
  if (path === '/notifications') return ok(state.notes);
  if ((m = /^\/notifications\/([^/]+)\/read$/.exec(path))) { const n = state.notes.find((x) => x.id === m[1]); n.readAt = '2026-10-20T07:00:00Z'; return ok({ changed: 1 }); }
  if (path === '/comms/broadcasts' && method === 'GET') return ok(state.broadcasts.filter((b) => !u.searchParams.get('status') || b.status === u.searchParams.get('status')));
  if (path === '/comms/broadcasts' && method === 'POST') {
    const b = { ...body.notice, id: uuid(), shortId: `BRD-${state.broadcasts.length + 1}`, status: body.send ? 'Sent' : 'Draft', sentAt: body.send ? '2026-10-20T06:00:00Z' : null, sentBy: 'Asha',
      recipients: body.send ? 2 : 0, viewed: 0, signed: 0, pushDelivered: body.send ? 2 : 0, signedBy: [], viewedAt: null, signedAt: null, createdAt: '2026-10-20T06:00:00Z', version: 1 };
    state.broadcasts.push(b); return ok(b, 201);
  }
  if ((m = /^\/comms\/broadcasts\/([^/]+)(\/[a-z]+)?$/.exec(path))) {
    const b = state.broadcasts.find((x) => x.id === m[1]); if (!b) return problem(404, 'not-found', 'Not found');
    const verb = m[2] || '';
    if (verb === '' && method === 'GET') return ok(b);
    if (verb === '/results') { const v = state.votes[b.id] || []; return ok({ counts: b.pollOptions.map((_, i) => v.filter((x) => x.includes(String(i))).length), total: v.length, mine: v[0] || [], mineBy: null }); }
    if (verb === '/vote') { state.votes[b.id] = [body.choices, ['1']]; return ok({}); }
    if (verb === '/sign') { b.signedAt = '2026-10-20T08:00:00Z'; b.signed++; b.version++; return ok(b); }
    if (h['If-Match'] !== `"${b.version}"`) return problem(409, 'conflict', 'changed');
    if (verb === '') Object.assign(b, body);
    if (verb === '/send') { b.status = 'Sent'; b.recipients = 2; }
    if (verb === '/reschedule') Object.assign(b, body);
    b.version++; return ok(b);
  }
  if (path === '/comms/forum/topics' && method === 'GET') return ok(state.topics);
  if (path === '/comms/forum/topics' && method === 'POST') { const t = { ...body, id: uuid(), shortId: 'FT-1', replies: 0, pinned: false, status: 'Open', author: 'Asha', votes: [], version: 1 }; state.topics.push(t); return ok(t, 201); }
  if ((m = /^\/comms\/forum\/topics\/([^/]+)(\/[a-z]+)?$/.exec(path))) {
    const t = state.topics.find((x) => x.id === m[1]); if (!t) return problem(404, 'not-found', 'Not found');
    const verb = m[2] || '';
    if (verb === '' && method === 'GET') return ok(t);
    if (verb === '/results') return ok({ counts: t.pollOptions.map((_, i) => t.votes.filter((x) => x === i).length), total: t.votes.length, mine: t.votes.length ? [String(t.votes[0])] : [] });
    if (verb === '/vote') { t.votes.push(body.choice); return ok({}); }
    if (verb === '/posts' && method === 'GET') return ok(state.posts.filter((x) => x.topicId === t.id));
    if (verb === '/posts') { const p = { id: uuid(), shortId: 'FP-1', topicId: t.id, parentId: body.parentId, author: 'Asha', authorRole: 'owner', body: body.body, reactions: 0, hidden: false, version: 1 }; state.posts.push(p); t.replies++; t.version++; return ok(p, 201); }
    if (h['If-Match'] !== `"${t.version}"`) return problem(409, 'conflict', 'changed');
    Object.assign(t, body); t.version++; return ok(t);
  }
  if ((m = /^\/comms\/forum\/posts\/([^/]+)(\/[a-z]+)?$/.exec(path))) {
    const p = state.posts.find((x) => x.id === m[1]);
    if (m[2] === '/react') { p.reactions++; p.version++; return ok(p); }
    if (h['If-Match'] !== `"${p.version}"`) return problem(409, 'conflict', 'changed');
    if (method === 'DELETE') { state.posts = state.posts.filter((x) => x !== p); return ok(null, 204); }
    Object.assign(p, body); p.version++; return ok(p);
  }
  // ---- governance
  state.meetings ||= []; state.ballots ||= []; state.marks ||= []; state.box ||= [];
  if (path === '/governance/meetings' && method === 'GET') return ok(state.meetings);
  if (path === '/governance/meetings' && method === 'POST') { const x = { ...body, id: uuid(), shortId: `MTG-${state.meetings.length + 1}`, publishedAt: body.visibility === 'Published to residents' ? '2026-10-20T06:00:00Z' : null, version: 1 }; state.meetings.push(x); return ok(x, 201); }
  if ((m = /^\/governance\/meetings\/([^/]+)$/.exec(path))) {
    const x = state.meetings.find((y) => y.id === m[1]); if (!x) return problem(404, 'not-found', 'Not found');
    if (method === 'GET') return ok(x);
    if (h['If-Match'] !== `"${x.version}"`) return problem(409, 'conflict', 'changed');
    if (method === 'DELETE') { state.meetings = state.meetings.filter((y) => y !== x); return ok(null, 204); }
    Object.assign(x, body); if (body.visibility === 'Published to residents' && !x.publishedAt) x.publishedAt = '2026-10-20T07:00:00Z'; x.version++; return ok(x);
  }
  const ballotView = (b) => ({ ...b, myUnits: b.status === 'Draft' ? [] : [{ unitId: A, unitNo: 'Villa 101', voted: state.marks.some((k) => k.ballotId === b.id), whyNot: '' }],
    whyNotMe: b.status === 'Open' && !state.marks.some((k) => k.ballotId === b.id) ? '' : b.status === 'Draft' ? 'Voting has not opened yet' : 'Voting is closed', rollSize: b.status === 'Draft' ? 0 : 2 });
  if (path === '/governance/ballots' && method === 'GET') return ok(state.ballots.map(ballotView));
  if (path === '/governance/ballots' && method === 'POST') { const b = { ...body, options: body.options.length ? body.options : ['For', 'Against', 'Abstain'], id: uuid(), shortId: 'BAL-1', status: 'Draft', votesCast: 0, version: 1 }; state.ballots.push(b); return ok(ballotView(b), 201); }
  if ((m = /^\/governance\/ballots\/([^/]+)(\/[a-z/]+)?$/.exec(path))) {
    const b = state.ballots.find((y) => y.id === m[1]); if (!b) return problem(404, 'not-found', 'Not found');
    const verb = m[2] || '';
    if (verb === '' && method === 'GET') return ok(ballotView(b));
    if (verb === '/roll') return ok(b.status === 'Draft' ? [] : [{ unitId: A, unitNo: 'Villa 101', owners: ['Asha'], phoneLast4: '1001', voted: state.marks.some((k) => k.ballotId === b.id), markedOn: '2026-10-20', votedBy: null },
      { unitId: B, unitNo: 'Villa 202', owners: [], phoneLast4: null, voted: false, markedOn: null, votedBy: null }]);
    if (verb === '/box') return b.status === 'Closed' ? ok({ rows: state.box.filter((r) => r.ballotId === b.id), chain: { ok: true }, matchesClose: true }) : problem(422, 'sealed', 'Votes stay sealed');
    if (verb === '/code') { state.lastCode = body; return ok({ unitId: body.unitId, unitNo: 'Villa 101', phoneLast4: '1001', expiresIn: 300, code: null }); }
    if (verb === '/code/verify') return body.code === '123456' ? ok({ proof: 'proof-1' }) : problem(422, 'wrong-code', 'That code is not right (2 attempts left).');
    if (verb === '/votes') {
      if (body.proof !== 'proof-1') return problem(422, 'no-proof', 'Second-factor check missing or expired - request a new code');
      state.marks.push({ ballotId: b.id, unitId: body.unitId }); const r = { ballotId: b.id, seq: state.box.length + 1, receipt: 'abcdefabcdef', choice: body.choice, prevHash: '0'.repeat(64), hash: 'f'.repeat(64) };
      state.box.push(r); b.votesCast++; b.version++; return ok({ ballotId: b.id, seq: r.seq, receipt: r.receipt, hash: r.hash }, 201);
    }
    if (h['If-Match'] !== `"${b.version}"`) return problem(409, 'conflict', 'changed');
    if (verb === '/open') { b.status = 'Open'; b.rollHash = 'e'.repeat(64); b.version++; return ok(ballotView(b)); }
    if (verb === '/close') { b.status = 'Closed'; b.chainHead = 'f'.repeat(64); b.votesCounted = b.votesCast; b.version++; return ok(ballotView(b)); }
    if (method === 'DELETE') { state.ballots = state.ballots.filter((y) => y !== b); return ok(null, 204); }
    if (b.status !== 'Draft') return problem(422, 'ballot-open', 'An open ballot cannot be edited');
    Object.assign(b, body); b.version++; return ok(ballotView(b));
  }
  // ---- assets: stock movements and the condition log
  if ((m = /^\/assets\/inventory\/([^/]+)\/movements$/.exec(path)) && method === 'POST') {
    const it = state.kit['assets/inventory'].find((x) => x.id === m[1]);
    const q = Number(body.quantity); const bal = body.kind === 'Received' ? Number(it.quantity || 0) + q : body.kind === 'Issued' ? Number(it.quantity || 0) - q : q;
    if (bal < 0) return problem(422, 'not-enough', 'Only so much in stock');
    it.quantity = String(bal); it.version++; state.lastMove = body;
    return ok({ item: { id: it.id, quantity: it.quantity, minStock: it.minStock, lastRestocked: body.kind === 'Received' ? '2026-10-20' : null }, movement: { kind: body.kind, balance: String(bal) } }, 201);
  }
  if (path === '/assets/condition-log' && method === 'POST') {
    const eq = state.kit['assets/equipment'].find((x) => x.id === body.assetId); eq.status = body.condition; eq.version++;
    return ok({ id: uuid(), shortId: 'ILG-1', ...body, assetName: eq.name }, 201);
  }
  // ---- the service directory
  state.contacts ||= []; state.reviews ||= [];
  if (path === '/vendors/directory' && method === 'GET') return ok(state.contacts);
  if (path === '/vendors/directory' && method === 'POST') { const c = { ...body, id: uuid(), shortId: 'SVC-1', status: 'Active', addedBy: 'Asha', addedByUnit: 'Villa 101', rating: null, reviews: 0, recommends: 0, version: 1 }; state.contacts.push(c); return ok(c, 201); }
  if ((m = /^\/vendors\/directory\/([^/]+)(\/[a-z]+)?$/.exec(path))) {
    const c = state.contacts.find((x) => x.id === m[1]); if (!c) return problem(404, 'not-found', 'Not found');
    if (m[2] === '/reviews') return ok(state.reviews.filter((r) => r.contactId === c.id));
    if (m[2] === '/review') {
      let r = state.reviews.find((x) => x.contactId === c.id);
      if (!r) { r = { id: uuid(), shortId: 'CRV-1', contactId: c.id, author: 'Asha', unitNo: 'Villa 101', version: 1 }; state.reviews.push(r); } else r.version++;
      Object.assign(r, body); c.reviews = state.reviews.filter((x) => x.contactId === c.id).length; c.rating = String(r.rating); return ok(r);
    }
    if (method === 'GET') return ok(c);
    if (h['If-Match'] !== `"${c.version}"`) return problem(409, 'conflict', 'changed');
    if (method === 'DELETE') { state.contacts = state.contacts.filter((x) => x !== c); return ok(null, 204); }
    Object.assign(c, body); c.version++; return ok(c);
  }
  if ((m = /^\/vendors\/reviews\/([^/]+)$/.exec(path)) && method === 'DELETE') { state.reviews = state.reviews.filter((r) => r.id !== m[1]); return ok(null, 204); }
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
  assert.deepEqual(await storage.list('ecRoles'), []);
  await assert.rejects(storage.put('ecRoles', { id: 'p1' }), /not on the v2 back end yet/);
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

test('gate: a pass is POSTed (the code is the server\'s) and cancelled; a resident answers an approval; the desk is the server\'s', async () => {
  const p = await storage.put('gatePasses', { visitorName: 'Meera', unit: 'Villa 101', type: 'One-time', code: '000000', status: 'Active', usedCount: 5, days: [] });
  const post = last('POST', /^\/gate\/passes$/).body;
  assert.equal(post.unitId, A); assert.equal('code' in post, false); assert.equal('usedCount' in post, false);
  assert.equal(p.code, '482913'); assert.equal(p.unit, 'Villa 101');
  const c = await storage.put('gatePasses', { ...p, status: 'Cancelled' });
  assert.equal(last('POST', /\/cancel$/).headers['If-Match'], '"1"'); assert.equal(c.status, 'Cancelled');
  const [ap] = await storage.list('gateApprovals');
  const answered = await storage.put('gateApprovals', { ...ap, status: 'Approved', alwaysAllow: true });
  assert.deepEqual(last('POST', /\/answer$/).body, { decision: 'Approved', always: true }); assert.equal(answered.status, 'Approved');
  await assert.rejects(storage.put('gateVisits', { id: 'v1', state: 'Inside' }), /gate desk/);
  assert.deepEqual(await storage.list('gateFlags'), [], 'residents see no flags');
  const engine = await import('../../src/lib/gate/engine.js');
  const r = await engine.admitPass(c);
  assert.equal(r.ok, false); assert.equal(r.reason, 'This pass was cancelled', 'a refusal comes back as the reason, not an exception');
});

test('comms: the inbox is the server\'s; a notice goes as a draft the server sends; a reader signs and votes; the forum counts its replies', async () => {
  const [n] = await storage.list('notifications');
  assert.equal(n.title, 'New bill · ₹3,540'); assert.equal(n.read, false); assert.equal(n.toName, 'Asha', 'addressed to me, so the bell shows it');
  await storage.put('notifications', { ...n, read: true });
  assert.equal(last('POST', /^\/notifications\//).path, `/notifications/${n.id}/read`);
  const writes = calls.filter((x) => x.method !== 'GET').length;
  await storage.putMany('notifications', [{ event: 'announcement', title: 'Hello', toRoleIds: ['owner'] }]);
  assert.equal(calls.filter((x) => x.method !== 'GET').length, writes, 'the app composing a notification sends nothing: the server notifies from the event');
  const b = await storage.put('broadcasts', { type: 'Poll', audience: 'Selected villas', audienceUnits: ['Villa 101'], subject: 'Pool timings?', message: '', pollOptions: ['Morning', 'Evening'],
    status: 'Sent', recipients: 99, viewed: 0, pushDelivered: 99, signedBy: '', requiresSignature: true, reminderFrequency: 'None', sentAt: '2026-10-20' });
  const post = last('POST', /^\/comms\/broadcasts$/).body;
  assert.equal(post.send, true); assert.deepEqual(post.notice.unitIds, [A]); assert.equal('recipients' in post.notice, false, 'counts are the server\'s');
  assert.equal(b.recipients, 2); assert.deepEqual(b.audienceUnits, ['Villa 101']);
  const signed = await storage.put('broadcasts', { ...b, signedBy: 'Asha' });
  assert.equal(last('POST', /\/sign$/).path, `/comms/broadcasts/${b.id}/sign`); assert.equal(signed.signedBy, 'Asha');
  await storage.put('pollVotes', { broadcastId: b.id, voter: 'Asha', unit: 'Villa 101', choices: ['0'] });
  assert.deepEqual(last('POST', /\/vote$/).body, { choices: ['0'] });
  const votes = (await storage.list('pollVotes')).filter((v) => v.broadcastId === b.id);
  assert.equal(votes.length, 2, 'mine and one anonymous'); assert.deepEqual(votes[0].choices, ['0']); assert.equal(votes[1].voter, '', 'who else voted is not shown');
  const d = await storage.put('broadcasts', { type: 'Notice', audience: 'All residents', subject: 'Draft', message: '<p>x</p>', status: 'Draft' });
  await storage.put('broadcasts', { ...d, subject: 'Draft 2', status: 'Sent' });
  assert.deepEqual(calls.slice(-2).map((c) => [c.method, c.path, c.headers['If-Match']]), [['PUT', `/comms/broadcasts/${d.id}`, '"1"'], ['POST', `/comms/broadcasts/${d.id}/send`, '"2"']]);
  // forum
  const t = await storage.put('forum', { title: 'Pool timings', category: 'Amenities', kind: 'Poll', pollOptions: [{ label: '6-9', votes: 0 }, { label: '7-10', votes: 0 }], replies: 0, voters: [] });
  assert.deepEqual(last('POST', /^\/comms\/forum\/topics$/).body.pollOptions, ['6-9', '7-10']);
  await storage.put('forumPosts', { topicId: t.id, parentId: '', author: 'Asha', body: '<p>7-10</p>', reactions: 0 });
  assert.deepEqual(last('POST', /\/posts$/).body, { parentId: null, body: '<p>7-10</p>' });
  const t1 = await storage.put('forum', { ...t, replies: 7 });
  assert.equal(t1.replies, 1, 'the reply count is the server\'s');
  const voted = await storage.put('forum', { ...t1, pollOptions: [{ label: '6-9', votes: 0 }, { label: '7-10', votes: 1 }], voters: ['Asha'] });
  assert.deepEqual(last('POST', /\/topics\/[^/]+\/vote$/).body, { choice: 1 }); assert.deepEqual(voted.voters, ['Asha']); assert.equal(voted.pollOptions[1].votes, 1);
  const [post1] = await storage.list('forumPosts');
  const reacted = await storage.put('forumPosts', { ...post1, reactions: 1 });
  assert.equal(reacted.reactions, 1);
  await storage.remove('forumPosts', post1.id);
  assert.equal(last('DELETE', /^\/comms\/forum\/posts\//).headers['If-Match'], '"2"');
});

test('files and documents: bytes go up as the body; a ticket\'s photo is attached after the ticket is saved; a document is filed with its file', async () => {
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const f = await storage.put('files', { name: 'leak.png', mime: 'image/png', size: 7, dataUrl: png, ownerType: 'ticket', ownerId: 'local-1' });
  const up = last('POST', /^\/files\?/);
  assert.equal(up.path, '/files?name=leak.png'); assert.equal(up.headers['Content-Type'], 'image/png'); assert.ok(up.body instanceof Blob, 'the bytes, not JSON');
  assert.equal(f.ownerType, 'upload', 'unattached until its record is saved');
  assert.equal((await storage.get('files', f.id)).dataUrl, png, 'read back as the same data URL');
  const t = await storage.put('tickets', { title: 'Leak with photo', category: 'Plumbing', description: 'see photo', unit: 'Villa 101', taskType: 'Resident Maintenance', attachments: [{ fileId: f.id, name: 'leak.png', mime: 'image/png' }] });
  assert.deepEqual(last('POST', /\/attach$/).body, { ownerType: 'maintenance.ticket', ownerId: t.id });
  assert.equal(t.attachments[0].fileId, f.id);
  const listed = (await storage.list('tickets')).find((x) => x.id === t.id);
  assert.equal(listed.attachments.length, 1); assert.equal(listed.hasPhotos, true);
  const pdf = await storage.put('files', { name: 'bye-laws.pdf', mime: 'application/pdf', size: 4, dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF').toString('base64') });
  const d = await storage.put('documents', { title: 'Bye-laws', category: 'Association', version: 'v3', access: 'All owners', fileId: pdf.id, fileName: 'x', scanStatus: 'Clean (server scan)' });
  assert.deepEqual(last('POST', /^\/documents$/).body, { fileId: pdf.id, title: 'Bye-laws', category: 'Association', edition: 'v3', access: 'All owners', unitId: null, expiry: null, folderId: null });
  assert.equal(d.version, 'v3', 'the document\'s own label'); assert.equal(d.fileName, 'bye-laws.pdf');
  const d2 = await storage.put('documents', { ...d, access: 'Villa owner / resident', unit: 'Villa 101' });
  assert.equal(last('PUT', /^\/documents\//).headers['If-Match'], '"1"'); assert.equal(last('PUT', /^\/documents\//).body.unitId, A); assert.equal(d2.unit, '');
  await storage.remove('documents', d.id);
  assert.equal(last('DELETE', /^\/documents\//).headers['If-Match'], '"2"');
});

test('cultural: a pledge is POSTed (status and receipt are the server\'s), received or paid online by command; reservations and totals are not written; sign-ups are commands', async () => {
  const ev = await storage.put('culturalEvents', { name: 'Diwali', status: 'Open', visibility: 'Published', budget: 50000, finalOver: 5000 });
  const p = await storage.put('culturalDonations', { eventId: ev.id, donor: 'Asha', unit: 'Villa 101', kind: 'Donation', towards: 'General', amount: 1001, status: 'Pledged', receiptNo: 'FAKE-1', mode: 'UPI' });
  const post = last('POST', /^\/cultural\/donations$/).body;
  assert.equal(post.unitId, A); assert.equal(post.received, false); assert.equal('receiptNo' in post, false); assert.equal('status' in post, false);
  const r = await storage.put('culturalDonations', { ...p, status: 'Received', mode: 'Cash', receiptNo: 'X' });
  assert.deepEqual(last('POST', /\/receive$/).body, { mode: 'Cash', reference: null }); assert.equal(r.receiptNo, 'DF26-0001', 'the server numbers receipts');
  const p2 = await storage.put('culturalDonations', { eventId: ev.id, donor: 'Asha', unit: 'Villa 101', amount: 2500, status: 'Pledged' });
  const pre = '00000000-0000-4000-8000-0000000fee01';
  await storage.put('culturalDonations', { ...p2, status: 'Received', gatewayRef: pre });
  assert.deepEqual(last('POST', /\/paid-online$/).body, { prepaymentId: pre });
  const off = await storage.put('culturalOfferings', { eventId: ev.id, title: 'Abhishekam', kind: 'Fixed slot', pledgeValue: 5001 });
  const writes = calls.filter((x) => x.method !== 'GET').length;
  await storage.put('culturalOfferings', { ...off, reservedBy: 'Asha', reservedUnit: 'Villa 101' });
  const evNow = await storage.get('culturalEvents', ev.id);
  await storage.put('culturalEvents', { ...evNow, collected: 123, pledged: 9, donors: 1 });
  assert.equal(calls.filter((x) => x.method !== 'GET').length, writes, 'a reservation is made by pledging, and the totals are the server\'s');
  await storage.put('culturalEvents', { ...evNow, creditedAmount: 47000, creditNote: 'to the fund' });
  assert.deepEqual(last('POST', /\/credit$/).body, { amount: 47000, note: 'to the fund' });
  const seva = await storage.put('culturalSevas', { eventId: ev.id, title: 'Stall', needed: 2, volunteers: [] });
  await storage.put('culturalSevas', { ...seva, volunteers: [{ name: 'Asha', unit: 'Villa 101' }] });
  assert.equal(last('POST', /\/signup$/).path, `/cultural/seva/${seva.id}/signup`);
  const s2 = await storage.get('culturalSevas', seva.id);
  await storage.put('culturalSevas', { ...s2, volunteers: [] });
  assert.equal(last('DELETE', /\/signup/).path, `/cultural/seva/${seva.id}/signup`, 'leaving as myself');
  const x = await storage.put('culturalExpenses', { eventId: ev.id, item: 'Flowers', amount: 3000, status: 'Pending approval', ecApproval: 'Pending' });
  assert.deepEqual(last('POST', /\/expenses$/).body, { item: 'Flowers', category: null, vendor: null, amount: 3000, estimate: null, date: null, fund: null, note: null });
  const xa = await storage.put('culturalExpenses', { ...x, ecApproval: 'Approved', ecNote: 'ok', finalRequired: false, status: 'Approved' });
  assert.deepEqual(last('POST', /\/decision$/).body, { value: 'Approved', comment: 'ok', finish: true });
  await storage.put('culturalExpenses', { ...xa, status: 'Paid' });
  assert.equal(last('POST', /\/pay$/).headers['If-Match'], '"2"');
});

test('finance: a payment is POSTed (taxes are the server\'s), corrected by reversal, matched to a statement line; bill lines are not booked twice; releases are paid by command', async () => {
  const e = await storage.put('ledger', { date: '2026-10-20', type: 'Debit', description: 'Pipes', amount: 99, baseAmount: 10000, gstRate: 18, tdsRate: 2, account: 'HDFC Main', mode: 'Bank transfer', sourceId: 'manual:1', reconStatus: 'Unreconciled' });
  const post = last('POST', /^\/finance\/cash-book$/).body;
  assert.equal(post.baseAmount, 10000); assert.equal(post.sourceId, null, 'only real ids go to the server'); assert.equal('reconStatus' in post, false);
  assert.equal(e.amount, 11600);
  const writes = calls.filter((x) => x.method !== 'GET').length;
  await storage.put('ledger', { date: '2026-10-20', type: 'Credit', description: 'Maintenance Oct', amount: 3540, sourceId: 'due:abc', sourceType: 'duePayment' });
  assert.equal(calls.filter((x) => x.method !== 'GET').length, writes, 'a bill\'s payment is already in the server\'s books');
  await assert.rejects(storage.put('ledger', { ...e, amount: 5 }), /reverse it/);
  const e2 = await storage.put('ledger', { ...e, category: 'Repairs' });
  assert.deepEqual(last('PATCH', /^\/finance\/cash-book\//).body.category, 'Repairs'); assert.equal(e2.category, 'Repairs');
  await storage.putMany('bankTxns', [{ date: '2026-10-20', account: 'HDFC Main', narration: 'NEFT AQUA', debit: 11600, credit: 0, balance: 1000 }, { date: '2026-10-20', account: 'HDFC Main', narration: 'INT', debit: 0, credit: 5, balance: 1005 }]);
  assert.equal(last('POST', /\/bank-lines\/import$/).body.lines.length, 2, 'one import for the statement');
  const [line] = (await storage.list('bankTxns')).filter((l) => l.debit > 0);
  await storage.put('ledger', { ...e2, reconStatus: 'Matched', bankTxnId: line.id });
  assert.deepEqual(last('POST', /\/match$/).body, { entryId: e.id });
  const m = await storage.get('ledger', e.id);
  await storage.put('ledger', { ...m, reconStatus: 'Unreconciled', bankTxnId: '' });
  assert.equal(last('POST', /\/unmatch$/).path, `/finance/bank-lines/${line.id}/unmatch`);
  const rv = await storage.put('ledger', { date: '2026-10-21', type: 'Credit', amount: 11600, description: 'Reversal', reversalOf: e.id, reason: 'twice', sourceType: 'reversal' });
  assert.deepEqual(last('POST', /\/reverse$/).body, { reason: 'twice' }); assert.equal(rv.reversalOf, 'CB-1');
  await assert.rejects(storage.remove('ledger', e.id), /reverse it/);
  const rel = await storage.put('releases', { ticketId: '00000000-0000-4000-8000-00000000aaaa', kind: 'Against invoice', amount: 3000, vendor: 'Aqua', status: 'Waiting approval', plan: '' });
  assert.deepEqual(last('POST', /^\/finance\/releases$/).body, { ticketId: '00000000-0000-4000-8000-00000000aaaa', expenseId: null, kind: 'Against invoice', amount: 3000, vendor: 'Aqua', note: null });
  state.releases[0].status = 'Approved';
  const paidLine = await storage.put('ledger', { date: '2026-10-21', type: 'Debit', amount: 3000, description: 'Release', sourceType: 'release', sourceId: rel.id, mode: 'UPI', ref: 'U1' });
  assert.deepEqual(last('POST', /\/releases\/[^/]+\/pay$/).body, { mode: 'UPI', ref: 'U1', date: '2026-10-21' }); assert.equal(paidLine.sourceType, 'release');
  await assert.rejects(storage.put('ledger', { date: '2026-10-21', type: 'Debit', amount: 60000, description: 'Lift AMC' }), /second approver/);
  const pr = await storage.put('payRequests', { description: 'Lift AMC', amount: 60000, status: 'Waiting', payload: JSON.stringify({ date: '2026-10-21', type: 'Debit', amount: 60000, description: 'Lift AMC', vendor: 'Otis' }) });
  assert.equal(last('POST', /^\/finance\/pay-requests$/).body.vendor, 'Otis');
  await storage.put('payRequests', { ...pr, status: 'Approved' });
  assert.deepEqual(last('POST', /\/pay-requests\/[^/]+\/decision$/).body, { approve: true, note: null });
});

test('governance: a meeting with its papers; a ballot drafted, opened on the server (its roll, not the screen\'s), a vote by code and proof, sealed until closed', async () => {
  const f = await storage.put('files', { name: 'agenda.pdf', mime: 'application/pdf', size: 3, dataUrl: 'data:application/pdf;base64,YWJj', ownerType: 'meeting', ownerId: 'local-1' });
  const mt = await storage.put('meetings', { title: 'AGM', committee: 'General body / AGM', date: '2026-10-25', startTime: '10:00', status: 'Scheduled', visibility: 'Internal (committee only)', agenda: '<p>Accounts</p>',
    minutes: '<p></p>', agendaFiles: [{ fileId: f.id, name: 'agenda.pdf' }] });
  const mpost = last('POST', /^\/governance\/meetings$/).body;
  assert.equal(mpost.minutes, null, 'empty minutes are no minutes'); assert.equal('agendaFiles' in mpost, false, 'papers are attached files, not fields');
  assert.deepEqual(last('POST', /\/attach$/).body, { ownerType: 'governance.agenda', ownerId: mt.id });
  assert.equal(mt.agendaFiles.length, 1);
  await storage.put('meetings', { ...mt, visibility: 'Published to residents' });
  assert.equal(last('PUT', /^\/governance\/meetings\//).headers['If-Match'], '"1"');
  assert.ok((await storage.get('meetings', mt.id)).publishedAt, 'the publishing time is the server\'s');

  const draft = await storage.put('ballots', { title: 'Adopt the accounts', kind: 'Resolution', options: [], opensOn: '2026-10-20', closesOn: '2026-10-20', quorumPct: 50, passPct: 50, status: 'Draft', roll: [{ unit: 'Villa 999' }], rollHash: 'x' });
  const bpost = last('POST', /^\/governance\/ballots$/).body;
  assert.equal('roll' in bpost, false); assert.equal('status' in bpost, false, 'status, roll and fingerprint are not sent');
  const opened = await storage.put('ballots', { ...draft, status: 'Open', roll: [{ unit: 'Villa 999', owners: ['Me'] }], rollHash: 'x' });
  assert.equal(last('POST', /\/open$/).path, `/governance/ballots/${draft.id}/open`);
  assert.equal(opened.status, 'Open'); assert.deepEqual(opened.roll.map((r) => r.unit), ['Villa 101', 'Villa 202'], 'the roll frozen by the server');
  await assert.rejects(storage.put('ballots', { ...opened, title: 'Something else' }), /open ballot cannot be edited/);

  const { requestOtp, verifyOtp, whyCannotVote } = await import('../../src/lib/evoting.js');
  const me = { roleId: 'owner', unit: 'Villa 101', name: 'Asha' };
  assert.equal(whyCannotVote(opened, me), '', 'the server\'s verdict');
  assert.equal(whyCannotVote({ ...opened, whyNotMe: 'Only registered owners can vote' }, me), 'Only registered owners can vote');
  const sms = await requestOtp(opened, me);
  assert.equal(sms.phoneLast4, '1001'); assert.equal(sms.code, ''); assert.deepEqual(state.lastCode, { unitId: A });
  await assert.rejects(verifyOtp(opened, me, '000000'), /not right/);
  const proof = await verifyOtp(opened, me, '123456');
  await storage.put('voteRoll', { ballotId: opened.id, unit: 'Villa 101', proof });
  assert.equal(calls.filter((x) => /\/votes$/.test(x.path)).length, 0, 'the mark alone writes nothing');
  const rc = await storage.put('ballotBox', { ballotId: opened.id, choice: 'For' });
  assert.deepEqual(last('POST', /\/votes$/).body, { unitId: A, proof: 'proof-1', choice: 'For' });
  assert.equal(rc.receipt, 'abcdefabcdef'); assert.equal(rc.seq, 1);
  await assert.rejects(storage.put('ballotBox', { ballotId: opened.id, choice: 'For' }), /No verified voter roll mark/);
  assert.equal((await storage.list('voteRoll')).length, 1, 'which units voted');
  assert.equal((await storage.list('ballotBox')).length, 0, 'sealed while open');
  await assert.rejects(storage.remove('voteRoll', `${opened.id}-${A}`), /never be changed/);
  const closed = await storage.put('ballots', { ...(await storage.get('ballots', opened.id)), status: 'Closed' });
  assert.equal(closed.status, 'Closed'); assert.equal(closed.chainHead, 'f'.repeat(64));
  assert.deepEqual((await storage.list('ballotBox')).map((r) => r.choice), ['For']);
});

test('vendors: the register through the kit (a service line names its vendor by id); the directory: added and reviewed, the rating is the server\'s', async () => {
  const v = await storage.put('vendors', { name: 'Aqua Pumps', category: 'Maintenance', gstin: '29ABCDE1234F1Z5', contractType: 'AMC', attachments: [] });
  assert.equal(last('POST', /^\/vendors\/vendors$/).body.name, 'Aqua Pumps'); assert.equal('attachments' in last('POST', /^\/vendors\/vendors$/).body, false);
  await storage.put('vendorServices', { vendorName: 'Aqua Pumps', service: 'Plumbing', signedWorkers: 3 });
  assert.equal(last('POST', /^\/vendors\/service-lines$/).body.vendorId, v.id, 'the vendor by id');
  await assert.rejects(storage.put('vendorServices', { vendorName: 'Nobody', service: 'Plumbing' }), /not known to the back end/);
  const c = await storage.put('serviceContacts', { name: 'Raju electrician', category: 'Electrician', phone: '+91 98450 12345', addedBy: 'Someone else', addedByUnit: 'Villa 9', rating: 5 });
  const cpost = last('POST', /^\/vendors\/directory$/).body;
  assert.equal('addedBy' in cpost, false); assert.equal('rating' in cpost, false, 'who added it and the rating are the server\'s');
  assert.equal(c.addedByUnit, 'Villa 101');
  await storage.put('contactReviews', { contactId: c.id, rating: 4, comment: 'Quick', recommend: 'Yes', author: 'Asha', unit: 'Villa 101' });
  assert.deepEqual(last('PUT', /\/review$/).body, { rating: 4, comment: 'Quick', recommend: 'Yes' });
  assert.equal((await storage.get('serviceContacts', c.id)).rating, 4);
  const [rv] = await storage.list('contactReviews');
  await storage.remove('contactReviews', rv.id);
  assert.equal(last('DELETE', /^\/vendors\/reviews\//).path, `/vendors/reviews/${rv.id}`);
  await storage.put('serviceContacts', { ...(await storage.get('serviceContacts', c.id)), status: 'Hidden', hiddenReason: 'Complaints' });
  assert.equal(last('PUT', /^\/vendors\/directory\//).body.hiddenReason, 'Complaints');
});

test('assets: specs stay JSON text in the app; a quantity change is a stock movement; a condition entry goes to the server, which moves the asset', async () => {
  const eq = await storage.put('equipment', { name: 'STP pump A', area: 'STP', type: 'Pump', status: 'Working', quantity: 2, faulty: 0, specs: '{"Power (kW)":"7.5"}', files: [] });
  assert.deepEqual(last('POST', /^\/assets\/equipment$/).body.specs, { 'Power (kW)': '7.5' }, 'sent as JSON');
  assert.equal((await storage.get('equipment', eq.id)).specs, '{"Power (kW)":"7.5"}', 'and read back as text');
  const salt = await storage.put('inventory', { item: 'Softener salt', uom: 'Kg', minStock: 20, quantity: 50, attachments: [] });
  assert.equal('quantity' in last('POST', /^\/assets\/inventory$/).body, false, 'the quantity is not a field');
  assert.deepEqual(state.lastMove, { kind: 'Counted', quantity: 50, note: null }, 'the opening count');
  assert.equal(salt.quantity, 50);
  await storage.put('inventory', { ...(await storage.get('inventory', salt.id)), quantity: 17.5 });
  assert.deepEqual(state.lastMove, { kind: 'Counted', quantity: 17.5, note: null });
  const before = calls.length;
  await storage.put('inventory', { ...(await storage.get('inventory', salt.id)), notes: 'Keep dry' });
  assert.equal(calls.slice(before).filter((x) => /movements/.test(x.path)).length, 0, 'no movement when the quantity did not change');
  const entry = await storage.put('infraLog', { assetId: eq.id, assetName: 'STP pump A', date: '2026-10-20', condition: 'Needs attention', source: 'Inspection', note: 'Noisy', by: 'Asha' });
  assert.equal('by' in last('POST', /^\/assets\/condition-log$/).body, false, 'who recorded it is the server\'s');
  assert.equal(entry.assetName, 'STP pump A');
  assert.equal((await storage.get('equipment', eq.id)).status, 'Needs attention');
  await assert.rejects(storage.remove('infraLog', entry.id), /kept as written/);
});


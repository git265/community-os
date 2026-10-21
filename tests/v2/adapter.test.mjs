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
const state = {
  units: [
    { id: A, shortId: 'UNIT-1', unitNo: 'Villa 101', blockId: null, blockName: 'Block 1', unitType: 'Villa', occupancy: 'Owner occupied', areaSqft: '2400.00', maintenancePlan: 'Monthly', sanctionedKw: null, status: 'Active', custom: {}, updatedAt: '2026-10-20T06:00:00Z', version: 4 },
    { id: B, shortId: 'UNIT-2', unitNo: 'Villa 202', blockId: null, blockName: 'Block 2', unitType: 'Villa', occupancy: 'Vacant', areaSqft: null, maintenancePlan: null, sanctionedKw: null, status: 'Active', custom: {}, updatedAt: '2026-10-20T06:00:00Z', version: 1 },
  ],
  dues: [], members: [{ id: M1, displayName: 'Asha', phone: '+919800000001', status: 'Active', roles: [{ code: 'owner', name: 'Owner', primary: true }], units: [A], createdAt: null, updatedAt: null, version: 2 }],
  orders: [],
};
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
  if (path === '/payment-orders' && method === 'POST') {
    const dues = body.dueIds.map((id) => state.dues.find((x) => x.id === id));
    const amount = dues.reduce((s, d) => s + Number(d.outstanding), 0).toFixed(2);
    const o = { id: `o-${++seq}`, shortId: `ORD-${seq}`, unitId: dues[0].unitId, amount, currency: 'INR', status: 'Pending', provider: 'simulated', expiresAt: null, items: dues.map((d) => ({ dueId: d.id, amount: d.outstanding })), checkout: { provider: 'simulated', providerOrderRef: `sim_order_${seq}`, amount, currency: 'INR' } };
    state.orders.push(o); return ok(o, 201);
  }
  if ((m = /^\/dev\/simulated-checkout\/(.+)$/.exec(path))) return ok({ providerPaymentRef: 'sim_pay_1', signature: 'sig' });
  if ((m = /^\/payment-orders\/([^/]+)\/confirm$/.exec(path))) {
    const o = state.orders.find((x) => x.id === m[1]); o.status = 'Paid';
    for (const it of o.items) { const d = state.dues.find((x) => x.id === it.dueId); d.status = 'Paid'; d.outstanding = '0.00'; d.paid = d.total; }
    return ok({ paymentId: 'pay-1', receiptNo: 'RCP-0001', unitId: o.unitId, orderId: o.id, amount: o.amount, method: 'UPI', provider: 'simulated', receivedAt: new Date().toISOString(), allocations: [], keptAsCredit: '0.00' });
  }
  if ((m = /^\/payment-orders\/([^/]+)$/.exec(path))) return ok(state.orders.find((x) => x.id === m[1]));
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
  assert.deepEqual(await storage.list('tickets'), []);
  await assert.rejects(storage.put('tickets', { id: 't1' }), /not on the v2 back end yet/);
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

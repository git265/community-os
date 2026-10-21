// Tampered requests (r77): every one of these is a request the app itself never makes - an edited payload, another unit's id, a hidden
// field, a smuggled bulk row, a forged author. The server must refuse it, or save only what the caller is allowed to save.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, seedTenant, pool as mkPool, purge, rowOf, rowsOf, rolePhone } from './harness.mjs';
import { TYPED } from '../store/tables.mjs';
const TENANT = 'tamper';
const { DEFAULT_ROLES } = await import('../../../src/lib/access/roles.js');
const phoneOf = (roleId) => rolePhone(DEFAULT_ROLES.findIndex((r) => r.id === roleId));

let S, pool; const tok = {};
const who = { own1: '+91 98000 00011', own2: '+91 98000 00012', treas: '+91 98000 00002', pres: '+91 98000 00001', root: '+91 98000 00003', guard: '+91 98000 00021',
  plumber: phoneOf('handyman_plumbing'), helpdesk: phoneOf('helpdesk'), fm: phoneOf('facility_manager') };
const doc = (c, r) => (TYPED[c]
  ? pool.query(`INSERT INTO ${TYPED[c].table} (tenant, id, data) VALUES ($1,$2,$3)`, [TENANT, r.id, JSON.stringify({ recVersion: 1, ...r })])
  : pool.query('INSERT INTO documents (tenant, collection, id, data) VALUES ($1,$2,$3,$4)', [TENANT, c, r.id, JSON.stringify({ recVersion: 1, ...r })]));
const put = (k, c, rec) => S.call('PUT', `/${c}/${rec.id}`, { token: tok[k], body: rec });
const del = (k, c, id) => S.call('DELETE', `/${c}/${id}`, { token: tok[k] });
const get = (k, c, id) => S.call('GET', `/${c}/${id}`, { token: tok[k] });
const refused = (r, msg) => { assert.equal(r.status, 403, `${msg}: ${r.status} ${JSON.stringify(r.body)}`); };
const now = () => new Date().toISOString();

before(async () => {
  pool = mkPool(); await seedTenant(pool, TENANT); await pool.query('DELETE FROM auth_attempts');
  await doc('taskTypes', { id: 'tt-ec', name: 'EC Task', residentVisible: false, creatorScope: 'EC / Staff' });
  await doc('broadcasts', { id: 'br-1', status: 'Sent', audience: 'All residents', subject: 'AGM', type: 'Poll', pollOptions: ['Yes', 'No'], signedBy: 'Omar Owner', recipients: 4, viewed: 2 });
  await doc('amenitySettings', { id: 'ams-1', gstin: 'X', adminRecipients: ['a'] });
  await doc('forum', { id: 'fo-1', title: 'Pool hours', kind: 'Poll', replies: 0, pinned: false, status: 'Open', pollOptions: [{ label: 'Yes', votes: 0 }, { label: 'No', votes: 0 }], voters: [] });
  await doc('notifications', { id: 'n-v2', toUnit: 'V-2', title: 'Your bill', read: false });
  await doc('notifications', { id: 'n-v1', toUnit: 'V-1', title: 'Your bill', read: false });
  await doc('culturalEvents', { id: 'ev-1', name: 'Diwali', visibility: 'Published', status: 'Planned' });
  await doc('handymen', { id: 'hm-1', name: 'Ravi', trade: 'Electrical', clockedIn: true });
  S = await startServer({ port: 8121, tenant: TENANT });
  for (const [k, ph] of Object.entries(who)) { tok[k] = (await S.otp(ph)).token; assert.ok(tok[k], `sign-in ${k}`); }
});
after(async () => { S?.stop(); await purge(pool, TENANT); await pool.end(); });

describe('no rule, no write', () => {
  test('a resident or a plumber cannot create, change or delete settings and reference lists', async () => {
    for (const k of ['own1', 'plumber']) {
      for (const c of ['communityConfig', 'blocks', 'facilities', 'importantNumbers', 'numberSections', 'vendorServices', 'notificationSettings', 'gateCheckpoints', 'gateRounds', 'culturalBrochure', 'communities']) {
        refused(await put(k, c, { id: `x-${c}`, name: 'Hacked' }), `${k} create ${c}`);
      }
      refused(await put(k, 'hackedCollection', { id: 'x1', a: 1 }), `${k} invents a collection`);
    }
    refused(await put('own1', 'serviceNotices', { id: 'sn-1', title: 'No water today', active: true }), 'a resident posts an outage notice');
  });
  test('deleting is not a back door: broadcasts and amenity settings', async () => {
    refused(await del('own1', 'broadcasts', 'br-1'), 'resident deletes an announcement');
    refused(await del('own1', 'amenitySettings', 'ams-1'), 'resident deletes amenity settings');
    refused(await del('plumber', 'handymen', 'hm-1'), 'a plumber removes a colleague from the roster');
    assert.ok(await rowOf(pool, 'broadcasts', 'br-1', TENANT)); assert.ok(await rowOf(pool, 'amenitySettings', 'ams-1', TENANT));
  });
});

describe('you cannot touch what you cannot see', () => {
  test('another unit\'s ticket, another trade\'s ticket', async () => {
    refused(await put('own1', 'tickets', { id: 'tk-2', unit: 'V-2', title: 'Lamp', status: 'Cancelled', category: 'Electrical', taskType: 'Resident Maintenance' }), 'resident cancels V-2\'s ticket');
    refused(await put('plumber', 'tickets', { id: 'tk-2', unit: 'V-2', title: 'Lamp', status: 'In Progress', category: 'Electrical', priority: 'Low', taskType: 'Resident Maintenance', description: 'Lamp out' }), 'plumber works an electrical ticket');
    assert.equal((await rowOf(pool, 'tickets', 'tk-2', TENANT)).status, 'Open');
  });
  test('a plumber cannot hand a ticket to someone outside the crew', async () => {
    const cur = (await get('plumber', 'tickets', 'tk-1')).body;
    refused(await put('plumber', 'tickets', { ...cur, assignedTo: 'Mallory', status: 'Assigned' }), 'move the ticket out of the plumber\'s view');
  });
  test('a comment cannot be added to someone else\'s ticket', async () => {
    refused(await put('own1', 'ticketComments', { id: 'cm-x', ticketId: 'tk-2', visibility: 'Public', body: 'spam' }), 'comment on V-2\'s ticket');
    assert.equal((await put('own1', 'ticketComments', { id: 'cm-ok', ticketId: 'tk-1', visibility: 'Public', body: 'thanks', author: 'Pat President' })).status, 200);
    assert.equal((await rowOf(pool, 'ticketComments', 'cm-ok', TENANT)).author, 'Olive Owner', 'the author is the caller');
  });
});

describe('hidden fields and starting values', () => {
  test('a resident cannot approve, flag or price their own ticket, and cannot wipe what they cannot see', async () => {
    await pool.query(`UPDATE tickets SET data = data || $2::jsonb WHERE tenant=$1 AND id='tk-1'`, [TENANT, JSON.stringify({ financial: true, ecApproval: 'Pending', approvedAmount: 5000 })]);
    const mine = (await get('own1', 'tickets', 'tk-1')).body;
    assert.equal(mine.ecApproval, undefined); assert.equal(mine.financial, undefined);
    const r = await put('own1', 'tickets', { ...mine, description: 'Leak is worse', ecApproval: 'Approved', treasurerApproval: 'Approved', approvedAmount: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const saved = await rowOf(pool, 'tickets', 'tk-1', TENANT);
    assert.equal(saved.description, 'Leak is worse'); assert.equal(saved.ecApproval, 'Pending'); assert.equal(saved.treasurerApproval, undefined);
    assert.equal(saved.approvedAmount, 5000); assert.equal(saved.financial, true, 'the hidden flag survives a save that did not carry it');
    assert.equal(r.body.ecApproval, undefined, 'the reply is masked like a read');
  });
  test('a new request: the server decides status, assignee and author; odd keys and other units are refused', async () => {
    const base = { unit: 'V-1', title: 'Tap', category: 'Plumbing', priority: 'Low', taskType: 'Resident Maintenance', description: 'x', scope: 'Unit' };
    refused(await put('own1', 'tickets', { id: 'tk-n1', ...base, status: 'Completed' }), 'start as Completed');
    refused(await put('own1', 'tickets', { id: 'tk-n2', ...base, priority: 'Ultra' }), 'a priority that does not exist');
    refused(await put('own1', 'tickets', { id: 'tk-n3', ...base, unit: 'V-2' }), 'raise for another villa');
    refused(await put('own1', 'tickets', { id: 'tk-n4', ...base, taskType: 'EC Task' }), 'raise a committee task');
    refused(await put('own1', 'tickets', { id: 'tk-n5', ...base, discount: 100 }), 'an unknown field');
    const ok = await put('own1', 'tickets', { id: 'tk-n6', ...base, status: 'Assigned', assignedTo: 'Mallory', createdBy: 'Pat President', createdByRole: 'owner', approvedAmount: 99999, financial: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const t = await rowOf(pool, 'tickets', 'tk-n6', TENANT);
    assert.equal(t.assignedTo, ''); assert.equal(t.status, 'Open'); assert.equal(t.createdBy, 'Olive Owner'); assert.equal(t.approvedAmount, undefined); assert.equal(t.financial, undefined);
  });
});

describe('bulk writes check every row', () => {
  test('a bad row anywhere in a batch refuses the batch', async () => {
    const water = { unit: 'V-1', category: 'Water', amount: 300, status: 'Unpaid', dueDate: '2026-11-10', readingId: 'rd-1' };
    const r = await S.call('POST', '/dues/_create-many', { token: tok.helpdesk, body: { rows: [water, { ...water, category: 'Maintenance', amount: 99999, readingId: '' }] } });
    refused(r, 'a meter-reading role smuggles a maintenance bill into a water bill run');
    assert.equal((await rowsOf(pool, 'dues', TENANT)).filter((d) => d.amount === 99999).length, 0);
  });
  test('a "new" row cannot overwrite an existing one, and metadata cannot be forged', async () => {
    refused(await S.call('POST', '/dues/_create-many', { token: tok.treas, body: { rows: [{ id: 'due-1', unit: 'V-1', category: 'Maintenance', amount: 1, status: 'Paid', dueDate: '2026-10-10' }] } }), 'create over due-1');
    assert.equal((await rowOf(pool, 'dues', 'due-1', TENANT)).amount, 1000);
    const u = await S.call('POST', '/dues/_update-many', { token: tok.treas, body: { rows: [{ id: 'due-2', amount: 2100, recordCreatedBy: 'Nobody', shortId: 'DUE-FAKE' }] } });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const d2 = await rowOf(pool, 'dues', 'due-2', TENANT); assert.equal(d2.amount, 2100); assert.notEqual(d2.recordCreatedBy, 'Nobody'); assert.notEqual(d2.shortId, 'DUE-FAKE');
  });
  test('records with server-side rules are saved one at a time', async () => {
    refused(await S.call('POST', '/amenities/_update-many', { token: tok.fm, body: { rows: [{ id: 'bk-x', status: 'Cancelled' }] } }), 'bookings in bulk');
    refused(await S.call('POST', '/tickets/_update-many', { token: tok.plumber, body: { rows: [{ id: 'tk-2', status: 'Closed' }] } }), 'tickets in bulk');
  });
});

describe('who wrote it is the server\'s to say', () => {
  test('forum posts, reviews and poll votes carry the caller and the caller\'s villa', async () => {
    assert.equal((await put('own1', 'forumPosts', { id: 'fp-1', topicId: 'fo-1', author: 'Pat President', authorRoleId: 'owner', body: 'I approve' })).status, 200);
    assert.equal((await rowOf(pool, 'forumPosts', 'fp-1', TENANT)).author, 'Olive Owner');
    const v = await put('own1', 'pollVotes', { id: 'pv-1', broadcastId: 'br-1', voter: 'Omar Owner', unit: 'V-2', choices: ['Yes'] });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const pv = await rowOf(pool, 'pollVotes', 'pv-1', TENANT); assert.equal(pv.voter, 'Olive Owner'); assert.equal(pv.unit, 'V-1');
  });
  test('forum poll: one vote, one answer, as yourself', async () => {
    const t = (await get('own1', 'forum', 'fo-1')).body;
    refused(await put('own1', 'forum', { ...t, pollOptions: [{ label: 'Yes', votes: 50 }, { label: 'No', votes: 0 }], voters: ['Olive Owner'] }), 'stuff the poll');
    refused(await put('own1', 'forum', { ...t, pollOptions: [{ label: 'Yes', votes: 1 }, { label: 'No', votes: 0 }], voters: ['Omar Owner'] }), 'vote as someone else');
    refused(await put('own1', 'forum', { ...t, pinned: true }), 'pin a topic');
    assert.equal((await put('own1', 'forum', { ...t, pollOptions: [{ label: 'Yes', votes: 1 }, { label: 'No', votes: 0 }], voters: ['Olive Owner'] })).status, 200);
    const t2 = (await get('own1', 'forum', 'fo-1')).body;
    refused(await put('own1', 'forum', { ...t2, pollOptions: [{ label: 'Yes', votes: 2 }, { label: 'No', votes: 0 }], voters: ['Olive Owner', 'Olive Owner'] }), 'vote twice');
  });
  test('signing an announcement adds only your own name', async () => {
    const b = (await get('own1', 'broadcasts', 'br-1')).body;
    refused(await put('own1', 'broadcasts', { ...b, signedBy: '' }), 'remove another owner\'s signature');
    refused(await put('own1', 'broadcasts', { ...b, signedBy: 'Omar Owner, Gina Gone' }), 'sign for someone else');
    refused(await put('own1', 'broadcasts', { ...b, subject: 'Changed' }), 'edit the announcement');
    assert.equal((await put('own1', 'broadcasts', { ...b, signedBy: 'Omar Owner, Olive Owner' })).status, 200);
    const saved = await rowOf(pool, 'broadcasts', 'br-1', TENANT); assert.equal(saved.viewed, 2, 'the staff-only counter is untouched');
  });
});

describe('notifications, files, attendance, passes, pledges', () => {
  test('the bell: only your own rows, only "read", in-app links, the sender is recorded', async () => {
    refused(await put('own1', 'notifications', { id: 'n-v2', toUnit: 'V-2', title: 'Your bill', read: true }), 'mark someone else\'s message read');
    refused(await put('own1', 'notifications', { id: 'n-v1', toUnit: 'V-1', title: 'Changed text', read: true }), 'rewrite your own message');
    assert.equal((await put('own1', 'notifications', { id: 'n-v1', toUnit: 'V-1', title: 'Your bill', read: true })).status, 200);
    refused(await del('own1', 'notifications', 'n-v1'), 'delete a message');
    refused(await put('own1', 'notifications', { id: 'n-x', toUnit: 'V-2', title: 'Pay here', link: 'https://evil.example/pay' }), 'a link out of the app');
    assert.equal((await put('own1', 'notifications', { id: 'n-y', toUnit: 'V-2', title: 'Hello', link: '#/billing', by: 'Treasurer' })).status, 200);
    assert.equal((await rowOf(pool, 'notifications', 'n-y', TENANT)).by, 'Olive Owner');
  });
  test('file bytes: checked on the server, never replaced by someone else, served safely', async () => {
    const run = Date.now().toString(36); const A = `fl-a-${run}`, B = `fl-b-${run}`, Cc = `fl-c-${run}`;   // bytes on disk outlive the test database
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const raw = (k, id, body, type) => fetch(`${S.base}/files/${id}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${tok[k]}`, 'X-Community-Id': TENANT, 'Content-Type': type }, body });
    assert.equal((await raw('own1', A, png, 'image/png')).status, 204);
    assert.equal((await raw('own2', A, png, 'image/png')).status, 403, 'another person overwrites a pending upload');
    assert.equal((await raw('own1', B, Buffer.from('<script>alert(1)</script>'), 'text/html')).status, 400, 'HTML is not an allowed type');
    assert.equal((await raw('own1', Cc, Buffer.from('<script>alert(1)</script>'), 'image/png')).status, 400, 'a script pretending to be a picture');
    assert.equal((await put('own1', 'files', { id: A, name: 'a.png', size: png.length, ownerType: 'ticket', ownerId: 'tk-1', hasContent: true })).status, 200);
    assert.equal((await raw('own1', A, png, 'image/png')).status, 403, 'a saved file is not replaced, not even by its uploader');
    const g = await fetch(`${S.base}/files/${A}/content`, { headers: { Authorization: `Bearer ${tok.own1}`, 'X-Community-Id': TENANT } });
    assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/png'); assert.match(g.headers.get('content-security-policy') || '', /sandbox/);
    const other = await fetch(`${S.base}/files/${A}/content`, { headers: { Authorization: `Bearer ${tok.own2}`, 'X-Community-Id': TENANT } });
    assert.equal(other.status, 404, 'another villa cannot fetch the photo of my ticket');
  });
  test('attendance: the clock is the server\'s', async () => {
    const early = new Date(Date.now() - 3 * 3600e3).toISOString();
    refused(await put('plumber', 'attendance', { id: 'at-x', staffName: 'Test Handyman · Plumbing', clockIn: early, clockOut: '', source: 'Self' }), 'clock in three hours ago');
    const inAt = now();
    assert.equal((await put('plumber', 'attendance', { id: 'at-1', staffName: 'Test Handyman · Plumbing', clockIn: inAt, clockOut: '', source: 'Self' })).status, 200);
    const row = (await get('plumber', 'attendance', 'at-1')).body;
    refused(await put('plumber', 'attendance', { ...row, clockOut: now(), hours: 12 }), 'claim twelve hours');
    refused(await put('plumber', 'attendance', { id: 'at-2', staffName: 'Ravi', clockIn: now(), clockOut: '', source: 'Self' }), 'clock in a colleague');
  });
  test('guest passes: the gate counts the uses', async () => {
    const pass = { id: 'gp-1', unit: 'V-1', visitorName: 'Asha', type: 'One-time', status: 'Active', code: '123456' };
    refused(await put('own1', 'gatePasses', { ...pass, usedCount: 3 }), 'a pass that starts used');
    assert.equal((await put('own1', 'gatePasses', { ...pass, usedCount: 0 })).status, 200);
    const p = (await get('own1', 'gatePasses', 'gp-1')).body;
    refused(await put('own1', 'gatePasses', { ...p, usedCount: 0, status: 'Used' }), 'mark it used');
    refused(await put('own2', 'gatePasses', { ...p, unit: 'V-2' }), 'take over another villa\'s pass');
  });
  test('a pledge cannot claim to be paid or confirmed', async () => {
    const pl = { id: 'dn-1', eventId: 'ev-1', unit: 'V-1', amount: 500, status: 'Pledged', donor: 'Olive' };
    refused(await put('own1', 'culturalDonations', { ...pl, gatewayRef: 'pay_123' }), 'a fake gateway reference');
    refused(await put('own1', 'culturalDonations', { ...pl, confirmedBy: 'Treasurer' }), 'a confirmation field');
    refused(await put('own1', 'culturalDonations', { ...pl, unit: 'V-2' }), 'pledge in another villa\'s name');
    assert.equal((await put('own1', 'culturalDonations', pl)).status, 200);
  });
});

describe('record metadata is the server\'s (created / last updated: when and by whom)', () => {
  const FORGED = { recordCreatedAt: '2000-01-01T00:00:00.000Z', recordCreatedBy: 'Forged Creator', lastUpdatedAt: '2000-01-02T00:00:00.000Z', lastUpdatedBy: 'Forged Updater',
    updatedAt: '2000-01-03T00:00:00.000Z', shortId: 'FAKE-0001', timeline: [{ field: 'status', to: 'Paid', by: 'Forged' }], dateStamps: { paidAt: '2000-01-01' } };
  const fresh = (iso) => Math.abs(Date.parse(iso) - Date.now()) < 120000;
  const serverMade = (row, actor, created) => {
    for (const k of ['recordCreatedBy', 'lastUpdatedBy']) assert.ok(!String(row[k]).includes('Forged'), `${k}: ${row[k]}`);
    assert.ok(fresh(row.lastUpdatedAt), `lastUpdatedAt ${row.lastUpdatedAt}`); assert.ok(fresh(row.updatedAt), `updatedAt ${row.updatedAt}`);
    assert.match(row.lastUpdatedBy, new RegExp(actor)); assert.notEqual(row.shortId, 'FAKE-0001');
    if (created) { assert.ok(fresh(row.recordCreatedAt)); assert.match(row.recordCreatedBy, new RegExp(actor)); }
    assert.ok(!JSON.stringify(row.timeline || []).includes('Forged')); assert.notEqual(row.dateStamps?.paidAt, '2000-01-01');
  };
  test('a single save: create and update', async () => {
    assert.equal((await put('treas', 'dues', { id: 'due-m1', unit: 'V-1', category: 'Maintenance', amount: 10, status: 'Unpaid', dueDate: '2026-12-01', ...FORGED })).status, 200);
    serverMade(await rowOf(pool, 'dues', 'due-m1', TENANT), 'Tia Treasurer', true);
    const before = await rowOf(pool, 'dues', 'due-m1', TENANT);
    assert.equal((await put('treas', 'dues', { ...before, amount: 11, ...FORGED, recVersion: before.recVersion })).status, 200);
    const after = await rowOf(pool, 'dues', 'due-m1', TENANT);
    serverMade(after, 'Tia Treasurer', false);
    assert.equal(after.recordCreatedAt, before.recordCreatedAt, 'created stays as first stamped'); assert.equal(after.recordCreatedBy, before.recordCreatedBy);
    assert.equal(after.recVersion, before.recVersion + 1);
  });
  test('a ticket\'s number and status trail', async () => {
    const r = await put('own1', 'tickets', { id: 'tk-m1', unit: 'V-1', title: 'T', category: 'Plumbing', priority: 'Low', taskType: 'Resident Maintenance', description: 'x', scope: 'Unit', ticketNumber: 'TKT-9999', statusHistory: [{ status: 'Closed', by: 'Forged' }], ...FORGED });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = await rowOf(pool, 'tickets', 'tk-m1', TENANT);
    serverMade(t, 'Olive Owner', true); assert.notEqual(t.ticketNumber, 'TKT-9999'); assert.equal(t.ticketNumber, t.shortId);
    assert.ok(!JSON.stringify(t.statusHistory).includes('Forged'));
  });
  test('bulk create, update and import', async () => {
    const row = { unit: 'V-2', category: 'Maintenance', amount: 5, status: 'Unpaid', dueDate: '2026-12-01', ...FORGED };
    const c = await S.call('POST', '/dues/_create-many', { token: tok.treas, body: { rows: [{ id: 'due-m2', ...row }] } });
    assert.equal(c.status, 200, JSON.stringify(c.body)); serverMade(await rowOf(pool, 'dues', 'due-m2', TENANT), 'Tia Treasurer', true);
    const old = await rowOf(pool, 'dues', 'due-m2', TENANT);
    const u = await S.call('POST', '/dues/_update-many', { token: tok.treas, body: { rows: [{ id: 'due-m2', amount: 6, ...FORGED }] } });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const nu = await rowOf(pool, 'dues', 'due-m2', TENANT); serverMade(nu, 'Tia Treasurer', false); assert.equal(nu.recordCreatedAt, old.recordCreatedAt); assert.equal(nu.amount, 6);
    const i = await S.call('POST', '/bankTxns/_import-many', { token: tok.treas, body: { rows: [{ date: '2026-10-01', amount: 100, narration: 'NEFT', ...FORGED }] } });
    assert.equal(i.status, 200, JSON.stringify(i.body));
    const imported = (await rowsOf(pool, 'bankTxns', TENANT)).find((r) => r.narration === 'NEFT'); serverMade(imported, 'Tia Treasurer', true);
  });
});

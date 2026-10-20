// The "golden" answers the Java phone check and the property / meeting hooks (com.communityos.people) are tested against.
//
//   TZ=Asia/Kolkata node --import ./register-hooks.mjs test/gen-people-golden.mjs    (from backend/contract-server; or: npm run gen:people)
//
// It asks the REAL JavaScript for:
//   phones   - validatePhone / phoneKey (src/lib/phone.js on libphonenumber-js "min") for many typed numbers, from every country code
//   prePut   - propertyPreWrite: the refusal or the normalised property (people folded in, numbers in E.164, one number = one person)
//   postPut  - propertyPostWrite: users invited / re-linked / deactivated, invites revoked and sent, SMS + WhatsApp rows, the audit line
//   meeting  - meetingPreWrite (publishedAt) and meetingPostWrite (who is told, and what)
//   link     - communityUrl: the address an invite link starts with, for the kinds of address an install can have
// PeopleConformanceCheck replays them in Java and names every place the answer differs.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let CURRENT = Date.parse('2026-10-20T09:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(CURRENT); }
  static now() { return CURRENT; }
};
// ids and invite tokens: a counter, so the Java replay can hand out the same ones
let ids = 0, tokens = 0;
const realCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
  subtle: realCrypto.subtle,
  randomUUID: () => `id-${++ids}`,
  getRandomValues: (a) => { const n = ++tokens; for (let i = 0; i < a.length; i += 1) a[i] = (n * 37 + i * 11) & 255; return a; },
} });
console.warn = () => {};

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const OUT = path.resolve(here, '../../spring/src/test/resources/people/golden.json.gz');
const { setServerAdapter } = await import(path.join(SRC, 'storage/index.js'));
const community = await import(path.join(SRC, 'community.js'));
const phone = await import(path.join(SRC, 'phone.js'));
const props = await import(path.join(SRC, 'propertyServer.js'));
const meetings = await import(path.join(SRC, 'meetingServer.js'));
const meta = JSON.parse(fs.readFileSync(path.resolve(here, '../../../node_modules/libphonenumber-js/metadata.min.json'), 'utf8'));
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };

let seed = 20261020;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
Math.random = rnd;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const U = undefined;
const strip = (o) => JSON.parse(JSON.stringify(o));
const digits = (n, first = '0123456789') => pick(first.split('')) + Array.from({ length: n - 1 }, () => pick('0123456789'.split(''))).join('');

let DB = {};
const mem = {
  list: async (c) => structuredClone(DB[c] || []),
  get: async (c, id) => structuredClone((DB[c] || []).find((r) => r.id === id) || null),
  put: async (c, row) => { const rows = (DB[c] ||= []); const i = rows.findIndex((r) => r.id === row.id); if (i >= 0) rows[i] = structuredClone(row); else rows.push(structuredClone(row)); return row; },
  putMany: async (c, rows) => { for (const r of rows) await mem.put(c, r); return rows; },
  remove: async (c, id) => { DB[c] = (DB[c] || []).filter((r) => r.id !== id); },
};
setServerAdapter(() => mem);

// ---- phone numbers ------------------------------------------------------------------------------------------------------
const CODES = Object.keys(meta.country_calling_codes);
const FULL = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0xFF10 + Number(d)));
const ARABIC = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const SEPS = [' ', ' ', '-', '.', '', ' ', ' ', '/', '–'];
const spaced = (s) => { let out = ''; for (const ch of s) { out += ch; if (chance(0.25)) out += pick(SEPS); } return out; };
function typed() {
  const cc = pick([...Array(6).fill('91'), ...CODES]);
  const plan = meta.countries[meta.country_calling_codes[cc]?.[0]] || meta.nonGeographic?.[cc];
  const lengths = plan?.[3] || [int(4, 12)];
  let nn = digits(pick([...lengths, ...lengths, int(3, 14)]), cc === '91' && chance(0.7) ? '6789' : '0123456789');
  if (chance(0.15) && plan?.[5]) nn = plan[5] + nn;            // national prefix typed after the country code
  const head = pick(['+' + cc, '+' + cc, '+' + cc + ' ', '+ ' + cc, '+(' + cc + ')', '00' + cc, cc, '+0' + cc, '+' + cc + '-', '＋' + cc]);
  let s = head + (chance(0.6) ? spaced(nn) : ` ${nn}`);
  if (chance(0.06)) s = FULL(s);
  if (chance(0.04)) s = ARABIC(s);
  if (chance(0.08)) s += pick([' ext 12', ' x5', ' ext. 301', '#22', ';ext=4', ' ,,123', ' - 77#', ' anexo 9', ' доб 3', ' extension 20']);
  if (chance(0.05)) s = pick(['tel:', 'Call ', 'mob: ', '(', '  ']) + s + pick(['', ' now', ')', ';isub=12', '  ']);
  if (chance(0.03)) s = `tel:${nn};phone-context=${pick(['+' + cc, 'example.com', '', '+', 'bad..'])}`;
  if (chance(0.04)) s = pick(['  ', '\n', '\t', ' ', '　']) + s + pick(['', ' ', '\n']);
  return s;
}
const PLACEHOLDERS = ['+91 99999 99999', '+91 98765 43210', '+91 12345 67890', '+91 9898989898', '+91 98989 89899', '+1 555 555 5555', '+91 8888888888', '+44 7777 777777', '+91 6543210987', '+91 0123456789'];
const FIXED = ['', ' ', '+', '++91 98450 71234', '+91', '+9', '+0', '+91 9', '+91 98', '+91 984', '+91 98450 71234', '+91-98450-71234', '+91 (984) 507-1234', '98450 71234', '+919845071234', '+1 650 253 0000',
  '+1 (212) 555-0123', '+44 20 7946 0958', '+44 7911 123456', '+971 50 123 4567', '+65 9123 4567', '+61 412 345 678', '+49 30 901820', '+33 6 12 34 56 78', '+7 912 345-67-89', '+7 701 123 4567', '+800 1234 5678',
  '+882 1234 5678', '+870 773 123 456', '+979 1234 5678', '+39 06 6982', '+39 3123456789', '+262 269 61 12 34', '+590 690 30 12 34', '+1 340 123 4567', '+1 876 123 4567', '+91 080 2345 6789', '+91 80 2345 6789',
  '+91 11 2345 6789', '+91 1800 123 4567', '+91 140 123 4567', '+86 139 1234 5678', '+86 10 1234 5678', '+234 803 123 4567', '+20 100 123 4567', 'hello', '+abc', '+91 98450 71234 ext 5', 'tel:+91-98450-71234',
  `+91 ${'9'.repeat(260)}`, '+91 98450 71234\n', '+৯১', '+1 800 FLOWERS', '+91 98450 7123', '+91 98450 712345', '+999 123 4567', '+42 123 4567', '+383 44 123 456', '+290 22123', '+672 3 12345', '+595 961 456789'];

// ---- properties ---------------------------------------------------------------------------------------------------------
const NAMES = ['Asha Rao', 'asha rao', 'Ravi Kumar', 'Meena Iyer', 'Kiran', 'Tara', ' Farid ', 'Pia', '', 'Asha Rao', 'Ravi Kumar'];
const POOL = ['+91 98450 71234', '+919845071234', '+91 99000 12345', '+91 70220 55555', '+91 81234 56780', '+44 7911 123456', '+1 650 253 0000', '98450 71234', '+91 99999 99999', '+91 98450', '+91 63600 11223', '+971 50 123 4567', '', U, '+91 90080 12345', '+91 7406 123456', '+91 99000 12345', '+91 81234 56780'];
const UNITS = ['A-9', 'A-10', 'B-2', 'Villa 12', 'Villa 3'];
const RELS = ['Additional owner', 'Additional tenant', 'Family / other contact', U, ''];
const person = (i) => strip({ id: chance(0.8) ? `P${i}` : U, relation: pick(RELS), name: pick(NAMES), phone: pick(POOL), email: pick([U, '', ' a@x.in ', 'b@x.in']) });
function property(id, unit) {
  return strip({
    id, shortId: chance(0.8) ? `UNIT-00${int(10, 99)}` : U, unit, owner: pick([...NAMES, 'Asha Rao', 'Ravi Kumar']), ownerPhone: pick(POOL), ownerEmail: pick([U, '', 'o@x.in']),
    occupancy: pick(['Owner occupied', 'Owner occupied', 'Tenant occupied', 'Tenant occupied', 'Vacant', 'Vacant', '', U, 'Owner occupied', 'Tenant occupied']), tenant: pick([U, '', 'Kiran', 'Tara', 'Meena Iyer']), tenantPhone: pick(POOL), tenantEmail: pick([U, 't@x.in']),
    people: pick([U, [], Array.from({ length: int(1, 3) }, (_, i) => person(i)), 'x']), secondaryOwner: pick([U, U, U, 'Pia', '']), secondaryOwnerPhone: pick([U, '+91 70220 55555', '']),
    recVersion: 1, block: pick([U, 'A', 'B']),
  });
}
const ROLES = [{ id: 'owner', category: 'Resident' }, { id: 'resident', category: 'Resident' }, { id: 'tenant', category: 'Resident' }, { id: 'ec_member', category: 'EC' }, { id: 'facility_manager', category: 'Staff' }];
function users() {
  return Array.from({ length: int(0, 6) }, (_, i) => strip({
    id: `U${i}`, shortId: chance(0.8) ? `USR-00${10 + i}` : U, name: pick(NAMES.filter(Boolean)), phone: pick(POOL), email: pick([U, '', 'u@x.in']), status: pick(['Active', 'Active', 'Invited', 'Inactive', U]),
    roleId: pick(['owner', 'owner', 'resident', 'ec_member', 'facility_manager', U]), extraRoleIds: pick([U, [], ['resident'], ['ec_member'], ['owner', 'resident']]), units: pick([U, [], [pick(UNITS)], [pick(UNITS), pick(UNITS)]]),
    deactivatedAt: pick([U, U, '2026-01-01T00:00:00.000Z']), deactivatedReason: pick([U, U, 'old']), recVersion: 1,
  }));
}
function invites() {
  return Array.from({ length: int(0, 4) }, (_, i) => strip({ id: `I${i}`, shortId: `PIV-000${i + 1}`, phone: pick(['+919845071234', '+919900012345', '+447911123456', '+917022055555']), unit: pick(UNITS), status: pick(['Sent', 'Sent', 'Revoked', 'Used']), token: `t${i}` }));
}

// ---- meetings -----------------------------------------------------------------------------------------------------------
const VIS = [meetings.INTERNAL, meetings.PUBLISHED, U, '', 'Something else'];
function meeting(base) {
  const m = strip({
    id: 'MT1', title: pick(['AGM 2026', 'EC meeting', 'Budget review']), committee: pick(['EC', 'General body', U]), date: pick(['2026-11-02', '2026-11-09', U, '']), startTime: pick([U, '', '18:30', '10:00']), endTime: pick([U, '20:00']),
    location: pick([U, '', 'Clubhouse', 'Online']), status: pick(['Scheduled', 'Scheduled', 'Cancelled', 'Held', U]), visibility: pick(VIS), minutes: pick([U, U, '', '<p>Minutes</p>']), publishedAt: pick([U, '', '2026-10-01T10:00:00.000Z']),
  });
  if (!base) return m;
  const n = { ...base };
  for (const k of ['date', 'startTime', 'location', 'status', 'visibility', 'minutes', 'title', 'publishedAt', 'endTime', 'agenda']) if (chance(0.25)) n[k] = m[k] ?? pick(['x', U]);
  return strip(n);
}

// ---- run ----------------------------------------------------------------------------------------------------------------
const TRACK = ['users', 'portalInvites', 'notificationOutbox', 'notifications'];
const cleanRow = (r) => { const { id, ...rest } = r; return rest; };
const snapshot = () => Object.fromEntries(TRACK.map((c) => [c, new Map((DB[c] || []).filter((r) => r.id !== undefined).map((r) => [r.id, JSON.stringify(r)]))]));
function diff(before, auditBefore) {
  const changed = {}, created = {};
  for (const c of TRACK) {
    const rows = (DB[c] || []).filter((r) => r.id !== undefined);
    changed[c] = Object.fromEntries(rows.filter((r) => before[c].has(r.id) && before[c].get(r.id) !== JSON.stringify(r)).map((r) => [r.id, strip(r)]));
    created[c] = strip(rows.filter((r) => !before[c].has(r.id)).map(cleanRow));
  }
  const audit = (DB.audit || []).slice(auditBefore).map((a) => ({ who: a.who, whoName: a.whoName, what: a.what, action: a.action, summary: a.summary, unit: a.unit || '', recordId: a.recordId || '' }));
  return { changed, created, audit };
}
const HOSTS = ['http://localhost:5173', 'http://localhost:5173', 'https://app.communityos.in', 'http://192.168.1.5:5173', 'https://communityos.example.com', 'http://lapaloma.localhost:5173', 'https://hoa.example.co.in:8443'];
const loc = (u) => { const x = new URL(u); return { hash: '', search: '', pathname: '/', hostname: x.hostname, host: x.host, port: x.port, protocol: x.protocol, origin: x.origin, href: `${x.origin}/` }; };

const phones = [];
for (const s of [...FIXED, ...PLACEHOLDERS]) phones.push(s);
for (let i = 0; i < 24000; i += 1) phones.push(typed());
const phoneOut = phones.map((s) => ({ in: s, out: strip(phone.validatePhone(s)), key: phone.phoneKey(s) }));

const cases = [];
const kinds = new Map();
const tick = (k) => kinds.set(k, (kinds.get(k) || 0) + 1);
for (let n = 0; n < 2500; n += 1) {
  CURRENT = Date.parse('2026-10-20T09:00:00.000Z') + int(0, 400) * 3600_000;
  const host = pick(HOSTS), slug = pick(['la-paloma', 'la-paloma', 'green-acres', 'x1']);
  globalThis.window.location = loc(host); community.setCommunity(slug);
  const unit = pick(UNITS);
  const others = Array.from({ length: int(0, 4) }, (_, i) => property(`PR${i}`, pick(UNITS)));
  const old = chance(0.6) ? property('PRX', unit) : null;
  const w = strip({ properties: [...others, ...(old ? [old] : [])], users: users(), portalInvites: invites(), roles: chance(0.8) ? ROLES : [], mergeFields: chance(0.8) ? [{ id: 'M1', token: '{{SOCIETY_NAME}}', defaultValue: pick(['La Paloma', '', U]) }] : [],
    notificationPrefs: [{ id: 'NP1', userName: 'Asha Rao', whatsapp: true, sms: chance(0.5) }], notificationSettings: [] });
  const ops = [];
  const run = async (op, fn) => {
    DB = structuredClone(w); ids = 0; tokens = 0;
    const before = snapshot(); const auditBefore = (DB.audit || []).length;
    let ret;
    try { ret = await fn(); } catch (e) { ret = { crash: String(e?.message || e) }; }
    ops.push({ ...op, expected: { ret: ret === U ? null : strip(ret), ...diff(before, auditBefore) } });
    tick(op.kind);
  };
  const record = property('PRX', unit);
  if (old && chance(0.3)) Object.assign(record, { owner: old.owner, ownerPhone: old.ownerPhone });
  await run({ kind: 'prePut', record, old }, () => props.propertyPreWrite({ record, old, isNew: !old }));
  // the post-write runs on what the pre-write stored (or, now and then, on a raw record as an import would leave it)
  DB = structuredClone(w); ids = 0;
  const pre = await props.propertyPreWrite({ record, old, isNew: !old });
  const next = pre.record && chance(0.85) ? strip(pre.record) : strip(record);
  const oldNorm = old && chance(0.8) ? strip((await props.propertyPreWrite({ record: old, old: null, isNew: true })).record || old) : old;
  const actor = pick(['Asha Rao (Owner)', 'Super Admin', 'FM Farid (Facility Manager)']);
  await run({ kind: 'postPut', old: oldNorm, next, actor, host, slug }, () => props.propertyPostWrite({ old: oldNorm, next, actor }));
  if (chance(0.4)) {
    const impact = props.accessImpact(oldNorm, next);
    ops.push({ kind: 'impact', old: oldNorm, next, expected: { ret: strip(impact) } }); tick('impact');
  }
  const mOld = chance(0.6) ? meeting() : null;
  const mNext = meeting(mOld);
  await run({ kind: 'meetingPre', record: mNext, old: mOld }, () => meetings.meetingPreWrite({ record: mNext, old: mOld }));
  const mPre = (await meetings.meetingPreWrite({ record: mNext, old: mOld })).record;
  const mPost = chance(0.8) ? mPre : mNext;
  await run({ kind: 'meetingPost', old: mOld, next: mPost, actor }, () => meetings.meetingPostWrite({ old: mOld, next: mPost, actor }));
  cases.push({ now: new RealDate(CURRENT).toISOString(), world: w, ops });
}

const links = [];
for (const h of HOSTS) for (const s of ['la-paloma', 'green-acres', 'platform', 'Odd Slug']) { globalThis.window.location = loc(h); links.push({ host: h, slug: s, url: community.communityUrl(s) }); }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify({ version: 1, defaultCommunity: community.DEFAULT_COMMUNITY, phones: phoneOut, cases, links })));
const ok = phoneOut.filter((p) => p.out.ok).length;
console.log(`phones=${phoneOut.length} valid=${ok} cases=${cases.length} ${JSON.stringify(Object.fromEntries(kinds))} -> ${path.relative(process.cwd(), OUT)}`);

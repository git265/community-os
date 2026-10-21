// Writes the browser's La Paloma sample data (src/lib/seed) as the demo the v2 server loads:
//   node tools/export-demo-seed.mjs        ->  backend/api/src/main/resources/demo/la-paloma.json
// Run it again whenever the browser sample data changes. The server (demo/DemoData.java) loads that file through its services.
//
// Rows keep the browser's own shape and seed ids, with two changes:
//   * the registers the resource kit serves (RESOURCES in src/lib/storage/v2/v2map.js) are written as the API's request body:
//     renamed fields, JSON text parsed, a unit number as {"$unit": "Villa 135"}, a row named by key as {"$ref": "vendors:v1"}
//   * a reference to another seed row is {"$ref": "collection:id"}; the server swaps it for the id it gave that row
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!process.env.COS_EXPORT_RUN) {
  const out = `${root}tools/.out/export-demo-seed.mjs`;
  await build({ entryPoints: [fileURLToPath(import.meta.url)], bundle: true, platform: 'node', format: 'esm', outfile: out, external: ['esbuild'],
    define: { 'import.meta.env': '{"DEV":false}' }, loader: { '.png': 'empty', '.svg': 'empty', '.css': 'empty' }, logLevel: 'error',
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
  const r = spawnSync(process.execPath, [out, root], { stdio: 'inherit', env: { ...process.env, COS_EXPORT_RUN: '1', TZ: 'Asia/Kolkata' } });   // the sample data's local times are La Paloma's
  rmSync(`${root}tools/.out`, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

// ---- the bundled run: the browser code needs a window and a session store -------------------------------------------------------------
globalThis.window = { location: new URL('http://localhost/c/la-paloma'), addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
globalThis.location = globalThis.window.location;
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.sessionStorage = mem(); globalThis.localStorage = mem();
const { provisionSource } = await import('../src/lib/seed/seedData.js');
const { RESOURCES } = await import('../src/lib/storage/v2/v2map.js');
const { LOCAL_COLLECTIONS } = await import('../src/lib/storage/v2/V2ApiAdapter.js');
const dir = process.argv[2] || root;

const seed = await provisionSource({ slug: 'la-paloma', demoData: true }, null);

// which field of which collection names another seed row (the same table seedCommunity uses, and the kit's id fields)
const REFS = {
  ticketComments: { ticketId: 'tickets' }, quotations: { ticketId: 'tickets' }, tickets: { selectedQuotationId: 'quotations', assetId: 'equipment' },
  infraLog: { assetId: 'equipment', ticketId: 'tickets' }, forumPosts: { topicId: 'forum', parentId: 'forumPosts' }, vendorComments: { vendorId: 'vendors' },
  eventWork: { eventId: 'culturalEvents' }, culturalPrograms: { eventId: 'culturalEvents' }, culturalSevas: { eventId: 'culturalEvents' },
  culturalDonations: { eventId: 'culturalEvents', offeringId: 'culturalOfferings' }, culturalOfferings: { eventId: 'culturalEvents', donationId: 'culturalDonations' },
  culturalExpenses: { eventId: 'culturalEvents' }, contactReviews: { contactId: 'serviceContacts' }, audits: { auditorVendorId: 'vendors' },
  dues: { readingId: 'readings' }, gateLinks: { personId: 'gatePeople' },
  gateVisits: { personId: 'gatePeople', passId: 'gatePasses', workOrderId: 'gateWorkOrders', approvalId: 'gateApprovals' }, gateApprovals: { visitId: 'gateVisits' },
  gateFlags: { visitId: 'gateVisits', personId: 'gatePeople' }, gateWorkOrders: { rosterIds: 'gatePeople' }, gateRounds: { checkpointIds: 'gateCheckpoints' },
  shifts: { staffId: 'handymen' }, equipment: { planId: 'infraPlans' },
};
// a field the server keeps as an id but the browser as text: never tokenise it (equipment.planId is the map's name, not a row)
const ids = Object.fromEntries(Object.entries(seed).map(([c, rows]) => [c, new Set(rows.map((r) => r.id))]));
const ref = (c, id) => {
  if (id == null || id === '') return null;
  if (ids[c]?.has(id)) return { $ref: `${c}:${id}` };
  const other = Object.keys(ids).find((k) => ids[k].has(id));            // the browser data points across collections now and then (an asset that is a stock item)
  return other ? { $ref: `${other}:${id}` } : null;                      // a dangling reference: nothing to point at
};
const withRefs = (c, r) => {
  const out = { ...r };
  for (const [f, target] of Object.entries(REFS[c] || {})) {
    if (!(f in out)) continue;
    out[f] = Array.isArray(out[f]) ? out[f].map((x) => ref(target, x)).filter(Boolean) : ref(target, out[f]);
  }
  return out;
};
const META = new Set(['shortId', 'recVersion', 'recordCreatedAt', 'recordCreatedBy', 'lastUpdatedAt', 'lastUpdatedBy', 'version']);
function kitBody(c, r) {
  const spec = RESOURCES[c]; const ren = spec.rename || {};
  const units = { ...(spec.unit ? { unit: 'unitId' } : {}), ...(spec.units || {}) };
  const keyRefs = spec.refs || {};
  const body = { id: r.id };
  for (const [k, v0] of Object.entries(withRefs(c, r))) {
    if (k === 'id' || META.has(k)) continue;
    let v = v0;
    if (units[k]) { body[units[k]] = v ? { $unit: v } : null; continue; }
    if (keyRefs[k]) {
      const kr = keyRefs[k]; const row = (seed[kr.collection] || []).find((x) => x[kr.key] === v);
      body[kr.field] = row ? { $ref: `${kr.collection}:${row.id}` } : null; continue;
    }
    const f = ren[k] || k;
    if ([...(spec.json || []), ...(spec.jsonText || [])].includes(f) && typeof v === 'string') { try { v = v ? JSON.parse(v) : null; } catch { v = null; } }
    body[f] = v === '' ? null : v;
  }
  return body;
}
// per collection: where the browser keeps a value in another shape than the API takes (the same value, written the server's way)
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];                          // the browser counts weekdays Mon=0 .. Sun=6
const days = (b) => { if (Array.isArray(b.weekdays)) b.weekdays = b.weekdays.map((x) => (typeof x === 'number' ? DAYS[x] : x)); return b; };
const asText = (b, ...fields) => { for (const f of fields) if (b[f] != null && typeof b[f] !== 'string') b[f] = JSON.stringify(b[f]); return b; };
const fy = (v) => { const m = /^FY ?(\d{2})$/i.exec(v || ''); return m ? `20${Number(m[1]) - 1}-${m[1]}` : v; };   // FY27 -> 2026-27
const EXTRA = {
  reportSchedules: (b, r) => {
    b.unitIds = (r.units || []).map((u) => ({ $unit: u })); b.memberIds = (r.people || []).map((p) => ({ $member: p })); delete b.units; delete b.people;
    b.roleIds = (r.roleIds || []).map((code) => ({ $role: code }));
    return b;
  },
  amenitySettings: (b) => asText(b, 'adminRecipients', 'reportRecipients'),
  audits: (b) => asText(b, 'parameters'),
  siteHolidays: (b) => asText(b, 'effects'),
  siteServices: days, siteCalendar: days,
  mergeFields: (b) => { b.token = String(b.token || '').replace(/^\{\{(.*)\}\}$/, '{$1}'); return b; },     // {{SOCIETY_NAME}} -> {SOCIETY_NAME}
  budgetLines: (b) => { b.fy = fy(b.fy); return b; },
  gateCheckpoints: (b) => { b.code = String(b.code || '').replace(/[^A-Za-z0-9]/g, ''); return b; },             // the code on the QR sticker: letters and digits
  incidents: (b) => { if (b.reportedAt && Number.isNaN(Date.parse(b.reportedAt))) b.reportedAt = null; return b; },   // "Today, 09:21": the server stamps it
  gatePeople: (b) => { if (b.phone) b.phone = String(b.phone).replace(/[^+0-9]/g, ''); return b; },          // +91 98450 11221 -> +919845011221
  approvalPolicies: (b) => { if (typeof b.steps === 'string') b.steps = JSON.parse(b.steps); return b; },
};

const collections = {}; const kinds = {};
for (const [c, rows] of Object.entries(seed)) {
  if (LOCAL_COLLECTIONS.includes(c)) { kinds[c] = 'browser-only'; continue; }   // kept in the browser on v2 (communityConfig ...)
  if (RESOURCES[c]) { kinds[c] = 'register'; collections[c] = rows.map((r) => (EXTRA[c] ? EXTRA[c](kitBody(c, r), r) : kitBody(c, r))); continue; }
  kinds[c] = 'flow'; collections[c] = rows.map((r) => withRefs(c, r));
}
mkdirSync(`${dir}backend/api/src/main/resources/demo`, { recursive: true });
const file = `${dir}backend/api/src/main/resources/demo/la-paloma.json`;
writeFileSync(file, JSON.stringify({ source: 'src/lib/seed (the browser sample data)', exportedAt: new Date().toISOString(), kinds, collections }));
const n = Object.values(collections).reduce((s, x) => s + x.length, 0);
console.log(`${file}: ${Object.keys(collections).length} collections, ${n} rows`);

// Global search: jump to any page, a section inside a page, or a record. Works on what the signed-in role may open and read:
// pages come from the role's menu, records come through secureStorage (so row-level scope - a resident's own villa - still applies).
import { secureStorage } from './storage/secureStorage.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { canReadCollection } from './security/authz.js';
import { getPrincipal } from './security/principal.js';

/** Extra keywords so people find a page by what they want to do, not by its name. */
export const PAGE_KEYWORDS = {
  dashboard: 'home overview command center clock in out attendance',
  properties: 'villa apartment flat unit owner resident tenant directory register phone',
  approvals: 'approve reject pending quotation invoice expense final ec treasurer',
  tickets: 'maintenance task complaint repair issue ticket plumbing electrical',
  billing: 'dues payment invoice ledger fund accounting treasurer bank receipt',
  utilities: 'water dg diesel generator meter reading bill gas',
  assets: 'inventory stock asset equipment invoice ocr',
  amenities: 'booking clubhouse party hall tennis court gym pool reserve',
  security: 'visitor gate guard incident entry',
  shifts: 'workforce attendance clock in clock out gps shift staff roster report timesheet',
  calendar: 'trash garbage waste pickup collection workers contractors allowed construction calendar schedule',
  vendors: 'vendor contractor supplier amc contract',
  notifications: 'alerts whatsapp sms email message channel',
  cultural: 'festival event donation seva ganesh vinayaka diwali programme agenda upi qr pledge',
  communications: 'announcement broadcast notice poll message',
  governance: 'meeting committee minutes vote ballot election agm',
  documents: 'document file folder upload bylaws pdf',
  users: 'user account login access invite',
  roles: 'role permission access',
  audit: 'audit log history trail who changed',
};

/** Sections inside pages (opened through the page + a tab hint). */
export const SECTIONS = [
  { label: 'Community setup — blocks & towers', page: 'setup', tab: '', kw: 'block tower phase wing zone units bulk add range' },
  { label: 'Community setup — facilities & locations', page: 'setup', tab: '', kw: 'clubhouse pool swimming gym court parking stp wtp gate location facility' },
  { label: 'Community setup — currency & financial year', page: 'setup', tab: '', kw: 'currency rupee dollar financial year april january lakh million property types plot shop' },
  { label: 'Clock in / clock out', page: 'shifts', tab: 'attendance', kw: 'attendance punch gps location duty' },
  { label: 'Attendance report', page: 'shifts', tab: 'attendance', kw: 'timesheet hours late report csv staff' },
  { label: 'Shift planner', page: 'shifts', tab: 'shifts', kw: 'roster morning afternoon night week month' },
  { label: 'Site & GPS rules', page: 'shifts', tab: 'site', kw: 'geofence radius location latitude longitude' },
  { label: 'Trash pickup calendar', page: 'calendar', tab: 'Trash pickup', kw: 'garbage waste wet dry collection' },
  { label: 'Workers allowed calendar', page: 'calendar', tab: 'Workers allowed', kw: 'contractor construction repair work hours holiday' },
  // Billing & finance
  { label: 'Dues & bills', page: 'billing', tab: 'dues', kw: 'maintenance water dg bill unpaid overdue owner villa pay receipt status' },
  { label: 'Publish maintenance fee', page: 'billing', tab: 'dues', kw: 'yearly quarterly instalment annual fee publish all owners template notice' },
  { label: 'Defaulters & demand notices', page: 'billing', tab: 'defaulters', kw: 'overdue defaulter demand notice final notice legal arrears aging 30 60 90 days waive late fee' },
  { label: 'Financial reports', page: 'billing', tab: 'reports', kw: 'income expenditure fund statement sinking corpus tds cash book unit statement ledger levy report print csv' },
  { label: 'Special levy', page: 'billing', tab: 'dues', kw: 'levy assessment one-time lift repainting corpus collection fund per sq ft' },
  { label: 'Late fees', page: 'billing', tab: 'dues', kw: 'late fee interest penalty grace overdue percent' },
  { label: 'Credits & advances', page: 'billing', tab: 'dues', kw: 'credit note adjustment advance overpayment refund next bill' },
  { label: 'Payment reminders', page: 'billing', tab: 'dues', kw: 'remind unpaid frequency overdue nudge send reminder' },
  { label: 'Treasurer dashboard', page: 'billing', tab: 'dashboard', kw: 'cash balance headroom collections summary' },
  { label: 'Accounts & budget', page: 'billing', tab: 'bank', kw: 'bank account statement budget fd balance import' },
  { label: 'Payments — cultural expenses', page: 'billing', tab: 'pay:cultural', kw: 'pay expense festival event approved treasurer' },
  { label: 'Payments — maintenance tasks & invoices', page: 'billing', tab: 'pay:maintenance', kw: 'pay invoice task vendor skip diesel electricity bill approved' },
  { label: 'Payments — association utilities', page: 'billing', tab: 'pay:assoc', kw: 'electricity water gas internet diesel common area stp wtp clubhouse street lights bill pay association supplier' },
  { label: 'Utilities — association bills', page: 'utilities', tab: 'assoc', kw: 'association bills add list filter water clubhouse stp wtp common area street lights internet provider account' },
  { label: 'Inventory — import from Excel, mapping rules', page: 'assets', tab: 'inventory', kw: 'inventory stock import excel xlsx csv upload mapping rules category tag items supplies spreadsheet' },
  { label: 'Payments — collections', page: 'billing', tab: 'pay:collections', kw: 'received income water dg maintenance amenity collected year month summary' },
  { label: 'Payments — all payments', page: 'billing', tab: 'pay:all', kw: 'ledger transactions gst reference attachment' },
  // Utilities
  { label: 'Meter readings', page: 'utilities', tab: 'readings', kw: 'water dg reading photo meter publish bill' },
  { label: 'Utility billing & rate cards', page: 'utilities', tab: 'billing', kw: 'rate fixed charge tax per unit collection progress reminder' },
  { label: 'Bill templates', page: 'utilities', tab: 'templates', kw: 'notice template water dg message merge field' },
  // Amenities
  { label: 'Book an amenity', page: 'amenities', tab: 'book', kw: 'clubhouse party hall tennis gym pool reserve slot bookings' },
  { label: 'Amenity payments', page: 'amenities', tab: 'payments', kw: 'deposit refund gst booking paid' },
  { label: 'Amenity rates', page: 'amenities', tab: 'rates', kw: 'rate fee price deposit cancellation policy gst' },
  { label: 'Amenity notification templates', page: 'amenities', tab: 'notifications', kw: 'message template subject whatsapp sms email booking confirmation recipients outbox' },
  { label: 'Amenity reports', page: 'amenities', tab: 'reports', kw: 'daily summary report schedule send' },
  // Audits
  { label: 'Audits — by area', page: 'audits', tab: 'audits.overview', kw: 'stp wtp pool fire safety area result due overdue filter year month' },
  { label: 'Audits — timeline (10 years)', page: 'audits', tab: 'audits.timeline', kw: 'history years month grid trend' },
  { label: 'Audits — all audits', page: 'audits', tab: 'audits.history', kw: 'list score auditor result report' },
  // Inventory / assets
  { label: 'Inventory — add stock from invoice', page: 'assets', kw: 'stock invoice upload ocr zoom document warranty item' },
  { label: 'Equipment & asset warranty', page: 'assets', kw: 'warranty expiry equipment register amc service serial' },
];

const RECORDS = [
  { c: C.TICKETS, page: 'tickets', icon: '◉', kind: 'Task', text: (r) => `${r.ticketNumber || ''} ${r.title || ''} ${r.unit || ''} ${r.category || ''}`, title: (r) => `${r.ticketNumber || ''} ${r.title || ''}`.trim(), sub: (r) => [r.status, r.unit].filter(Boolean).join(' · '), link: (r) => `#/ticket/${r.ticketNumber}` },
  { c: C.PROPERTIES, page: 'properties', icon: '⌂', kind: 'Property', text: (r) => `${r.unit || ''} ${r.owner || ''} ${r.tenant || ''}`, title: (r) => `${r.unit || ''}${r.owner ? ` · ${r.owner}` : ''}` , sub: (r) => r.occupancy || '' },
  { c: C.VENDORS, page: 'vendors', icon: '♙', kind: 'Vendor', text: (r) => `${r.name || ''} ${r.service || ''} ${r.category || ''}`, title: (r) => r.name, sub: (r) => r.service || r.category || '' },
  { c: C.DOCUMENTS, page: 'documents', icon: '▤', kind: 'Document', text: (r) => `${r.title || ''} ${r.category || ''} ${r.fileName || ''}`, title: (r) => r.title, sub: (r) => r.category || '' },
  { c: C.CULTURAL_EVENTS, page: 'cultural', icon: '🎭', kind: 'Event', text: (r) => `${r.name || ''} ${r.type || ''} ${r.venue || ''}`, title: (r) => r.name, sub: (r) => [r.type, r.status].filter(Boolean).join(' · ') },
  { c: C.BROADCASTS, page: 'communications', icon: '✉', kind: 'Announcement', text: (r) => `${r.subject || ''} ${r.type || ''}`, title: (r) => r.subject, sub: (r) => r.type || '' },
  { c: C.MEETINGS, page: 'governance', icon: '⚖', kind: 'Meeting', text: (r) => `${r.title || ''} ${r.committee || ''}`, title: (r) => r.title, sub: (r) => [r.committee, r.date].filter(Boolean).join(' · ') },
  { c: C.INVENTORY, page: 'assets', icon: '⚡', kind: 'Stock item', text: (r) => `${r.item || ''} ${r.category || ''} ${r.location || ''}`, title: (r) => r.item, sub: (r) => r.location || '' },
  { c: C.HANDYMEN, page: 'shifts', icon: '🕒', kind: 'Staff', text: (r) => `${r.name || ''} ${r.trade || ''}`, title: (r) => r.name, sub: (r) => [r.trade, r.shift].filter(Boolean).join(' · '), tab: 'attendance' },
  { c: C.DUES, page: 'billing', icon: '₹', kind: 'Bill', tab: 'dues', text: (r) => `${r.shortId || ''} ${r.unit || ''} ${r.category || ''} ${r.billedMonth || ''} ${r.status || ''}`, title: (r) => `${r.shortId || ''} ${r.category || ''} · ${r.unit || ''}`.trim(), sub: (r) => [r.billedMonth, r.status].filter(Boolean).join(' · ') },
  { c: C.EQUIPMENT, page: 'assets', icon: '⚙', kind: 'Equipment', text: (r) => `${r.name || ''} ${r.type || ''} ${r.area || ''} ${r.make || ''} ${r.model || ''} ${r.serialNo || ''}`, title: (r) => r.name, sub: (r) => [r.area, r.warrantyUntil ? `warranty to ${r.warrantyUntil}` : ''].filter(Boolean).join(' · ') },
  { c: C.AMENITIES, page: 'amenities', icon: '🏊', kind: 'Booking', text: (r) => `${r.shortId || ''} ${r.amenity || ''} ${r.unit || ''} ${r.date || ''}`, title: (r) => `${r.shortId || ''} ${r.amenity || ''}`.trim(), sub: (r) => [r.unit, r.date, r.status].filter(Boolean).join(' · ') },
  { c: C.USERS, page: 'users', icon: '👤', kind: 'User', text: (r) => `${r.name || ''} ${r.phone || ''} ${r.email || ''}`, title: (r) => r.name, sub: (r) => r.status || '' },
];

const norm = (s) => String(s || '').toLowerCase();
const matches = (hay, terms) => terms.every((t) => hay.includes(t));

/**
 * Load the searchable records the signed-in person may read. Nothing is kept between searches: the search box asks once when the first word is typed
 * (`session`, which lives only while the box is open) and every further key filters that answer; closing the box drops it.
 */
async function loadRecords(session) {
  if (session?.data) return session.data;
  if (session?.loading) return session.loading;
  const p = getPrincipal();
  const run = (async () => {
  const out = [];
  for (const def of RECORDS) {
    if (!canReadCollection(def.c, p)) continue;
    let rows = []; try { rows = await secureStorage.list(def.c); } catch { rows = []; }
    for (const r of rows.slice(0, 1500)) out.push({ def, r, hay: norm(def.text(r)) });
  }
  return out;
  })();
  if (session) session.loading = run.then((d) => { session.data = d; session.loading = null; return d; });
  return session ? session.loading : run;
}

/** results: [{type:'page'|'section'|'record', id, label, sub, icon, page, tab?, link?}] */
export async function search(query, { pages, session }) {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  const open = new Map(pages.map((x) => [x.id, x]));
  const rank = (label) => (norm(label).startsWith(terms[0] || '') ? 0 : 1);
  const pageHits = pages.filter((x) => !terms.length || matches(norm(`${x.label} ${PAGE_KEYWORDS[x.id] || ''}`), terms)).map((x) => ({ type: 'page', id: `p-${x.id}`, label: x.label, sub: 'Page', icon: x.icon, page: x.id, o: rank(x.label) }));
  const secHits = terms.length ? SECTIONS.filter((s) => open.has(s.page) && matches(norm(`${s.label} ${s.kw}`), terms)).map((s) => ({ type: 'section', id: `s-${s.label}`, label: s.label, sub: `in ${open.get(s.page).label}`, icon: '↳', page: s.page, tab: s.tab, o: rank(s.label) })) : [];
  let recHits = [];
  if (terms.length && terms.join('').length >= 2) {
    const all = await loadRecords(session);
    recHits = all.filter((x) => open.has(x.def.page) && matches(x.hay, terms)).slice(0, 40).map((x) => ({ type: 'record', id: `r-${x.def.c}-${x.r.id}`, label: x.def.title(x.r) || '(untitled)', sub: `${x.def.kind}${x.def.sub(x.r) ? ` · ${x.def.sub(x.r)}` : ''}`, icon: x.def.icon, page: x.def.page, tab: x.def.tab, link: x.def.link?.(x.r), o: 2 }));
  }
  return [...pageHits, ...secHits, ...recHits].sort((a, b) => a.o - b.o).slice(0, 30);
}

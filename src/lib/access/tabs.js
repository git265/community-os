// Page tabs a Super Admin can switch on/off per role (Roles & permissions -> a role -> "Page tabs").
// A tab that is switched off is hidden for that role even if the role's permissions would otherwise allow it.
// Nothing here GRANTS access: a tab still needs the permission its screen already requires.
export const TAB_CATALOG = [
  { page: 'Billing & Finance', tabs: [['billing.dashboard', 'Dashboard'], ['billing.taxsplit', 'Tax split'], ['billing.itc', 'Input credit'], ['billing.dues', 'Dues'], ['billing.defaulters', 'Defaulters'], ['billing.reports', 'Reports'], ['billing.bank', 'Accounts & budget'], ['billing.pay', 'Payments']] },
  { page: 'Payments', tabs: [['pay.pay', 'Payments'], ['pay.reconcile', 'Bank matching'], ['pay.analysis', 'Analysis'], ['pay.routing', 'Account routing'], ['pay.s.cultural', 'Section: Cultural'], ['pay.s.maintenance', 'Section: Maintenance'],  ['pay.s.assoc', 'Section: Association utilities'], ['pay.s.collections', 'Section: Collections'], ['pay.s.all', 'Section: All payments']] },
  { page: 'Utilities', tabs: [['util.readings', 'Meter readings'], ['billing.utility', 'Utility billing (rate cards & collection)'], ['util.assoc', 'Association bills'], ['util.templates', 'Bill templates']] },
  { page: 'Reports', tabs: [['reports.scheduled', 'Scheduled'], ['reports.sent', 'Sent'], ['reports.gst', 'GST report'], ['reports.health', 'Data health']] },
  { page: 'Audits', tabs: [['audits.overview', 'By area'], ['audits.timeline', 'Timeline'], ['audits.history', 'All audits']] },
  { page: 'Cultural', tabs: [['cultural.events', 'Events'], ['cultural.budget', 'Budget vs actual'], ['cultural.overview', 'Event: Overview'], ['cultural.offerings', 'Event: Offerings'], ['cultural.programme', 'Event: Programme'], ['cultural.brochure', 'Event: Brochure'], ['cultural.seva', 'Event: Volunteer seva'], ['cultural.donations', 'Event: Donations'], ['cultural.expenses', 'Event: Expenses'], ['cultural.photos', 'Event: Photos']] },
  { page: 'Workforce', tabs: [['onsite.live', 'On site now'], ['workforce.attendance', 'Attendance'], ['onsite.attendance', 'Attendance: household & contractors'], ['workforce.shifts', 'Shift planner'], ['onsite.devices', 'Devices'], ['workforce.site', 'Site & GPS rules']] },
  { page: 'Security & Visitors', tabs: [['gate.console', 'Gate console'], ['gate.visits', 'Visits'], ['gate.flags', 'Ghost flags'], ['gate.registry', 'Registry'], ['gate.crews', 'Crews'], ['gate.vehicles', 'Vehicles'], ['gate.patrol', 'Patrol'], ['gate.badge', 'My badge'], ['gate.incidents', 'Incidents'], ['gate.rules', 'Rules & alerts'], ['gate.reports', 'Reports'], ['gate.mygate', 'Import from MyGate'], ['gate.sim', 'Gate simulator']] },
  { page: 'Audit Trail', tabs: [['audit.log', 'Trail'], ['audit.coverage', 'Coverage']] },
  { page: 'Accounts & budget', tabs: [['bank.summary', 'Accounts & deposits'], ['bank.budget', 'Budget'], ['bank.fixed', 'Fixed expenses'], ['bank.statements', 'Bank statements']] },
  { page: 'Maintenance', tabs: [['tickets.tickets', 'Tickets'], ['tickets.wishlist', 'Wishlist'], ['tickets.coverage', 'Category coverage'], ['tickets.approvers', 'Final approvers'], ['tickets.types', 'Task Types'], ['tickets.planned', 'Planned works']] },
  { page: 'Properties', tabs: [['properties.units', 'Units'], ['properties.owners', 'Owners']] },
  { page: 'Communications', tabs: [['comms.announce', 'Announcements & polls'], ['comms.notices', 'Notices'], ['comms.evote', 'E-voting'], ['comms.templates', 'Announcement templates'], ['comms.forum', 'Forum']] },
  { page: 'Amenities', tabs: [['amenities.book', 'Bookings'], ['amenities.payments', 'Payments'], ['amenities.rates', 'Rates & rules'], ['amenities.notifications', 'Notifications'], ['amenities.reports', 'Reports']] },
  { page: 'Maintenance task details', tabs: [['tickets.d.money', 'Costs & approvals'], ['tickets.d.chat', 'Chat'], ['tickets.d.history', 'History']] },
  { page: 'Community setup', tabs: [['setup.blocks', 'Blocks & units'], ['setup.facilities', 'Facilities & locations'], ['setup.details', 'Community details'], ['setup.settings', 'Money & financial year'], ['setup.lists', 'Lists']] },
  { page: 'Notifications', tabs: [['notif.inbox', 'My notifications'], ['notif.prefs', 'My channels'], ['notif.settings', 'Channel settings'], ['notif.log', 'Delivery log']] },
  { page: 'Site map', tabs: [['sitemap.map', 'Map'], ['sitemap.tasks', 'Tasks'], ['sitemap.board', 'Health board'], ['sitemap.list', 'All assets'], ['sitemap.setup', 'Plans & layers']] },
  { page: 'Plant & Assets', tabs: [['assets.plant', 'Water & sewage plants'], ['assets.summary', 'Monthly summary'], ['assets.dg', 'DG fuel log'], ['assets.electricity', 'Electricity bills'], ['assets.villas', 'Villa electricity'], ['assets.inventory', 'Inventory'], ['assets.equipment', 'Equipment & assets'], ['assets.logs', 'Other logs (added by Super Admin)']] },
];

/** Is this tab open to the role? Super Admin always sees everything (so nobody can lock themselves out). */
export function tabOpen(role, id) {
  if (!role) return false;
  if (role.id === 'super_admin') return true;
  // switching a page off hides every tab under it, whatever the tab's own switch says
  const page = tabPage(id);
  if (page && (role.hiddenPages || []).includes(page)) return false;
  return !(role.hiddenTabs || []).includes(id);
}

const PAGE_OF_PREFIX = { onsite: 'shifts', gate: 'security', billing: 'billing', pay: 'billing', bank: 'billing', tickets: 'tickets', properties: 'properties', comms: 'communications', amenities: 'amenities', assets: 'assets', sitemap: 'sitemap', util: 'utilities', audits: 'audits', reports: 'reports', cultural: 'cultural', workforce: 'shifts', audit: 'audit', setup: 'setup', notif: 'notifications' };
/** The left-menu page a tab id lives under ('billing.utility' moved to Utilities). */
export function tabPage(id) {
  if (id === 'billing.utility') return 'utilities';
  return PAGE_OF_PREFIX[String(id).split('.')[0]] || '';
}

/** Whole pages (left menu) a Super Admin can switch off per role. Like tabs, switching a page ON never grants access the permissions don't give. */
export const PAGE_CATALOG = [
  ['dashboard', 'Command Center'], ['properties', 'Unit Directory'], ['tickets', 'Maintenance'], ['billing', 'Billing & Finance'], ['utilities', 'Utilities & Assets: meters & bills'],
  ['assets', 'Utilities & Assets: plant & inventory'], ['sitemap', 'Site map'], ['amenities', 'Amenities'], ['security', 'Security & Visitors'], ['mygate', 'My Gate'], ['shifts', 'Workforce'], ['calendar', 'Calendar'], ['notifications', 'Notifications'], ['cultural', 'Cultural'], ['vendors', 'Vendors'], ['communications', 'Communications'],
  ['audits', 'Audits'], ['reports', 'Reports'], ['setup', 'Community setup'], ['directory', 'Service directory'], ['governance', 'Governance'], ['documents', 'Documents'], ['users', 'Users'], ['audit', 'Audit Trail'],
];
/** Super Admin always sees every page (Roles & Permissions and the Studio can never be hidden from them). */
export function pageOpen(role, id) {
  if (!role) return false;
  if (role.id === 'super_admin') return true;
  return !(role.hiddenPages || []).includes(id);
}

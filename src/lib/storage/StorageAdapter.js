// StorageAdapter is the ONLY contract the rest of the app depends on for
// persistence. Every module (Properties, Tickets, Billing, ...) reads and
// writes through this interface instead of touching sessionStorage or
// fetch() directly. That means swapping the backend later is a one-line
// change in src/lib/storage/index.js - no module code changes.
//
// Each "collection" (e.g. "properties", "tickets", "customFields:properties")
// is a flat list of JSON records: { id, ...fields }. That shape maps 1:1 onto
// a future Postgres table with a JSONB `data` column:
//
//   CREATE TABLE properties (
//     id UUID PRIMARY KEY,
//     data JSONB NOT NULL,
//     updated_at TIMESTAMPTZ DEFAULT now()
//   );
//
// so V2ApiAdapter (storage/v2) implements the exact same methods against the
// Spring Boot API (backend/api) with zero changes to any component or module.

/**
 * @typedef {Object} StorageAdapter
 * @property {(collection: string) => Promise<any[]>} list
 * @property {(collection: string, params: object) => Promise<{rows:any[],total:number,page:number,pageSize:number,pages:number}>} query  // server-side paging/sort/filter, see queryEngine.js
 * @property {(collection: string, id: string) => Promise<any|null>} get
 * @property {(collection: string, record: any) => Promise<any>} put   // upsert by id
 * @property {(collection: string, records: any[]) => Promise<any[]>} putMany   // upsert many in ONE write (bill runs, imports, reminders)
 * @property {(collection: string, id: string) => Promise<void>} remove
 * @property {(collection: string, records: any[]) => Promise<void>} replaceAll
 */

export const COLLECTIONS = Object.freeze({
  COMMUNITY_CONFIG: 'communityConfig', // one row: financial-year start, currency symbol, number grouping, property types (set by the Super Admin)
  BLOCKS: 'blocks', // the community's blocks / towers / phases / lanes (units are grouped by these)
  FACILITIES: 'facilities', // named places: Clubhouse A, Pool 2, STP-1, Gate 3 ... used wherever a location is chosen
  PROPERTIES: 'properties',
  TICKETS: 'tickets', // generic Task/Ticket engine - see modules/tickets/ticketEngine.js
  TASK_TYPES: 'taskTypes', // per-type workflow config: who can create, assignment mode, financial stages
  TICKET_COMMENTS: 'ticketComments', // public/internal discussion thread, one row per post
  QUICK_PHRASES: 'quickPhrases',
  TRADE_AVAILABILITY: 'tradeAvailability',
  HANDYMEN: 'handymen',
  DUES: 'dues',
  FUNDS: 'funds',
  BILLING_TEMPLATES: 'billingTemplates',
  LEDGER: 'ledger',
  WORKFORCE: 'workforce',
  DOC_FOLDERS: 'docFolders', // folders of the document repository (nested by parentId)
  CULTURAL_EVENTS: 'culturalEvents', // festivals & cultural events (Vinayaka Chavithi, Diwali, ...)
  CULTURAL_PROGRAMS: 'culturalPrograms', // the programme schedule of an event (with optional participant sign-up)
  CULTURAL_SEVAS: 'culturalSevas', // volunteer duties ("seva") residents sign up for
  CULTURAL_OFFERINGS: 'culturalOfferings', // priced seva offerings devotees reserve (decoration, annadanam, ...) or contribute to as a pool
  CULTURAL_DONATIONS: 'culturalDonations', // donations / sponsorships / pledges with receipts
  CULTURAL_EXPENSES: 'culturalExpenses', // event spending with bills
  SERVICE_NOTICES: 'serviceNotices', // "power cut / no water" notices staff post; residents see them before raising a request
  CULTURAL_BROCHURE: 'culturalBrochure', // pages of an event's brochure (cover, text + picture, programme, offerings, photos, contact)
  CULTURAL_PHOTOS: 'culturalPhotos', // event photo gallery (thumbnail on the row, full image in object storage)
  ATTENDANCE: 'attendance', // clock-in / clock-out sessions with GPS position
  ATTENDANCE_SETTINGS: 'attendanceSettings', // site location, allowed radius and how strictly it is enforced (one row)
  SITE_HOLIDAYS: 'siteHolidays', // holiday list: what each holiday does to trash pickup and to workers' access
  SITE_SERVICES: 'siteServices', // the community's timetabled services (trash pickup, workers, water tanker...) - admin-editable
  SITE_CALENDAR: 'siteCalendar', // trash-pickup and workers-allowed rules shown on the community calendar
  SHIFTS: 'shifts', // one row per staff member per day (planned shift)
  AMENITY_TYPES: 'amenityTypes',
  AMENITIES: 'amenities',
  AMENITY_SETTINGS: 'amenitySettings', // GST no., payment rules, who is told, report schedule (one row)
  NOTIFICATION_TEMPLATES: 'notificationTemplates', // per event + channel + audience message wording
  NOTIFICATION_PREFS: 'notificationPrefs', // one row per person: which extra channels (WhatsApp / SMS / E-mail) they want besides the app
  NOTIFICATION_SETTINGS: 'notificationSettings', // community-wide: which extra channels are offered for each kind of notification
  NOTIFICATION_OUTBOX: 'notificationOutbox', // every message queued for e-mail / SMS / WhatsApp (system-written)
  PORTAL_INVITES: 'portalInvites', // sign-in links sent to registered phone numbers (system-written)
  UNIT_CREDITS: 'unitCredits', // refunds credited to a villa's account, and their later use (system-written)
  AMENITY_ITEMS: 'amenityItems', // add-on items with a stock count (chairs, tables, tents ...) that a booking can take in any quantity
  VENDOR_SERVICES: 'vendorServices', // what each vendor is signed for: service line + number of workers (a facilities vendor may cover several services)
  NUMBER_SECTIONS: 'numberSections', // the sections (Emergency, Community office...) of Important numbers; Super Admin manages them
  IMPORTANT_NUMBERS: 'importantNumbers', // emergency / community / on-call phone numbers shown on the Command Center
  GATE_PEOPLE: 'gatePeople', // the vetted registry: maids, drivers, riders, crews
  GATE_LINKS: 'gateLinks', // person <-> villa: days and hours a maid / cook / driver may enter
  GATE_PASSES: 'gatePasses', // resident-made guest passes (one-time, recurring, event)
  GATE_VISITS: 'gateVisits', // every entry, from arrival to exit
  GATE_APPROVALS: 'gateApprovals', // live approval requests with the visitor's photo
  GATE_FLAGS: 'gateFlags', // ghost entry flags
  GATE_VEHICLES: 'gateVehicles', // FASTag / plate registry
  GATE_WORKORDERS: 'gateWorkOrders', // crew jobs with a roster
  GATE_VILLA_RULES: 'gateVillaRules', // per villa: delivery rule, away mode, what to be told about
  GATE_PASS_TEMPLATES: 'gatePassTemplates', // saved pass presets (a villa's own, or community-wide)
  GATE_CHECKPOINTS: 'gateCheckpoints', // patrol checkpoints (QR codes on posts)
  GATE_ROUNDS: 'gateRounds', // scheduled patrol rounds
  GATE_SCANS: 'gateScans', // every checkpoint scan
  GATE_PULSE: 'gatePulse', // last activity per guard console (system heartbeat, not user data)
  GATE_SETTINGS: 'gateSettings', // community-wide gate rules and notification matrix (one row)
  INCIDENTS: 'incidents',
  VENDORS: 'vendors',
  BROADCASTS: 'broadcasts',
  NOTICE_TEMPLATES: 'noticeTemplates',
  MERGE_FIELDS: 'mergeFields',
  FORUM: 'forum',
  FORUM_POSTS: 'forumPosts',
  WISHES: 'wishes', // wishlist: ideas raised by residents or the EC, voted per villa
  INFRA_PLANS: 'infraPlans', // site plans (an image + optional scale) that infrastructure is drawn on; one community can have several
  INFRA_LAYERS: 'infraLayers', // how each kind of asset is drawn (point / line / zone, colour); built-in defaults, a community adds or hides its own
  MAP_VERSIONS: 'mapVersions', // every change to where an asset sits or how the plan is set up, with what it was before (undo / restore)
  INFRA_LOG: 'infraLog', // condition history per asset: who found what, when, and which task fixed it
  EVENT_WORK: 'eventWork', // work to do for an event (before / during / after), staff needed and when, owned by the Facility Manager or MEP
  REPORT_SCHEDULES: 'reportSchedules', // scheduled reports: which report, format, how often, how delivered, to whom
  REPORT_RUNS: 'reportRuns', // every report that was produced (system-written): summary, table and who it went to
  MEETINGS: 'meetings',
  EC_ROLES: 'ecRoles',
  SUBCOMMITTEES: 'subcommittees',
  APPROVALS: 'approvals',
  DOCUMENTS: 'documents',
  CATEGORY_MAP: 'categoryMap', // ticket category -> vendor (optional) + coordinators (who shows in "assign to")
  APPROVER_SETTINGS: 'approverSettings', // which roles may give the final (second-step) approval on financial tasks
  DEPOSITS: 'deposits', // fixed deposits and other investments, each held with a bank account
  BANK_ACCOUNTS: 'bankAccounts', // the association's real bank accounts + FDs (from the Treasurer's Account Summary sheet)
  BANK_TXNS: 'bankTxns', // bank statement lines per account, categorised to a budget head
  BUDGET_LINES: 'budgetLines', // annual budget (FY) income and expense lines
  FIXED_EXPENSES: 'fixedExpenses', // recurring monthly commitments + months still to pay
  LOG_TYPES: 'logTypes', // Super Admin defined logs (name + fields): pest control, generator service, chemical dosing ...
  LOG_ENTRIES: 'logEntries', // entries of those logs: date + the values of the log's fields
  PLANT_LOGS: 'plantLogs', // one record per day: Bhagiratha / WTP / STP meter readings and salt & chlorine stock
  DG_FUEL_LOGS: 'dgFuelLogs', // diesel refills of the DG set with run-hour / kWh meter readings -> consumption performance
  USER_PROFILES: 'userProfiles', // the extra profile details a person keeps up to date themselves (alternate phone, emergency contact, vehicles, language); name / phone / role / villa stay Super Admin managed
  INVENTORY_RULES: 'inventoryRules', // mapping rules for the Excel inventory import: words in an item description -> its category (and unit / store)
  ASSOC_BILLS: 'assocBills', // utility bills the association itself pays (water, gas, internet ... for the common area, STP, clubhouse ...)
  ELECTRICITY_BILLS: 'electricityBills', // one record per supply bill (clubhouse, STP, WTP, common area ...) with the key facts from the bill
  VILLA_ELECTRICITY: 'villaElectricity', // monthly units / amount / maximum demand per villa
  EQUIPMENT: 'equipment', // STP / WTP / clubhouse equipment register (motors, pumps, panels ...)
  BALLOTS: 'ballots', // e-voting: the question, options, window and frozen voter roll
  VOTE_ROLL: 'voteRoll', // e-voting: which units have voted (never what)
  BALLOT_BOX: 'ballotBox', // e-voting: anonymous votes in a hash chain (hidden until the ballot closes)
  POLL_VOTES: 'pollVotes', // WhatsApp-style poll answers
  VILLA_IMPORT_RULES: 'villaImportRules', // Super Admin's mapping of villa-electricity Excel columns
  LEDGER_SKIPS: 'ledgerSkips', // approved invoices / tasks the Treasurer chose NOT to record in the payments cross-check (with a reason)
  TAX_SETTINGS: 'taxSettings', // GST limit per unit per month, registration status and turnover (one row)
  TAX_COMPONENTS: 'taxComponents', // per bill category: counts toward the GST limit or not, GST rate, destination account
  PAYMENT_ROUTING: 'paymentRouting', // which bank account each kind of payment (maintenance, cultural, utilities, amenities...) goes through by default
  AUDITS: 'audits', // periodic audits (STP, WTP, pool, fire, lift...) with results kept as history
  SERVICE_CONTACTS: 'serviceContacts', // community-recommended technicians, drivers, cooks...
  CONTACT_REVIEWS: 'contactReviews', // ratings and reviews of those contacts, one per villa
  IMPORT_PROFILES: 'importProfiles', // admin-defined mapping of bank-statement Excel columns to portal fields
  LEVIES: 'levies', // one-off special assessments (purpose, per-unit rule, fund, due date); the bills are dues rows carrying levyId
  DEMAND_NOTICES: 'demandNotices', // reminder / demand / final notices sent to defaulting units (legal trail)
  APPROVAL_POLICIES: 'approvalPolicies', // community-written approval rules (who approves what, in which order)
  RELEASES: 'releases', // staged / advance fund releases against an approved task amount
  PAY_REQUESTS: 'payRequests', // payments above the approval limit, waiting for a second approver
  RECURRING_BILLS: 'recurringBills', // monthly expenses that raise their own association bill (rent, AMC, security...)
  CASH_COUNTS: 'cashCounts', // physical cash counted against the cash book
  FINANCE_SETTINGS: 'financeSettings', // estimates behind the "Can we cover it?" headroom (single row)
  QUOTATIONS: 'quotations', // competing quotations collected per task
  VENDOR_COMMENTS: 'vendorComments', // internal discussion per vendor
  INVENTORY: 'inventory', // supplies in stock per category
  UTILITY_TYPES: 'utilityTypes', // utilities that are metered and billed per unit (Water, DG, + any the Super Admin adds: gas, borewell, ...)
  READINGS: 'readings', // monthly water / DG meter readings per unit (+ meter photos)
  FILES: 'files', // uploaded file bytes (data URL) kept apart from document rows -> object storage later
  COMMUNITIES: 'communities', // PLATFORM registry: one row per community (not stored inside any community)
  USERS: 'users',
  ROLES: 'roles',
  ROLE_GROUPS: 'roleGroups', // permission groups: default permissions + access level, inherited by roles
  AUDIT: 'audit',
  SCHEMA: 'schema', // per-section field definitions, incl. custom attributes
});

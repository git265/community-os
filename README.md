# CommunityOS

A modular React app for community/HOA management. Runs today on `sessionStorage`
with zero backend, and is structured so swapping in a Spring Boot +
PostgreSQL(JSONB) backend later touches one file, not the app.

## Why it's structured this way

**One storage contract, two implementations.**
`src/lib/storage/StorageAdapter.js` documents the interface
(`list / get / put / remove / replaceAll`) every module uses.
`SessionStorageAdapter.js` implements it against the browser tab's session.
`ApiStorageAdapter.js` implements the *same* interface against a REST API.
`src/lib/storage/index.js` is the single switch point:

```js
// src/lib/storage/index.js
const USE_API = import.meta.env.VITE_USE_API === 'true';
export const storage = USE_API ? ApiStorageAdapter : SessionStorageAdapter;
```

Flip `VITE_USE_API=true` and point `VITE_API_BASE_URL` at your Spring Boot
service — every module keeps working unchanged, because none of them import
`sessionStorage` or `fetch` directly; they only call `storage.*`.

**Records map straight onto JSONB.** Every record is `{ id, ...fields }`, a
flat JSON object. On the Spring Boot side that's one table per collection,
with a JSONB `data` column — custom attributes need no migration, they're
just new keys inside `data`.

**Schema-driven fields, not hardcoded forms.** `src/lib/schema/registry.js`
defines every section as an array of `FieldDef`s:
`{ key, label, type, viewableBy, editableBy, isCustom }`. `DynamicForm` and
`DynamicTable` render off that array, so every field is editable by
construction, Super Admin can add custom attributes to any section at
runtime (Studio), and access is controlled per field per role.

**Roles and permissions are data, not code.** Roles live in a `ROLES`
collection (seeded from `src/lib/access/roles.js`), each with a `category`
(EC / Staff / Resident) and a list of the 17 named permissions it holds.
Super Admin can create custom roles and toggle permissions live from
**Roles & Permissions**, using the same compact list→detail pattern as
Studio (a 17-role × 17-permission grid would be unreadable, so clicking a
role opens just that role's toggles).

## Project layout

```
src/
  lib/
    storage/    # StorageAdapter contract + Session/Api implementations
    schema/     # field definitions + runtime schema store (custom attrs)
    access/     # roles (17-role/17-permission model) + roleStore + view/edit helpers
    audit/      # auto-logging helper used by useCollection
    seed/       # demo data for a fresh session
  context/      # AppContext: current user/role, roles, schema registry, useCollection hook
  components/   # DynamicForm, DynamicTable, SectionPage, Modal, CompactList, LoginScreen
  modules/      # one folder per section
  App.jsx       # login gate, permission-driven nav, responsive shell
```

## Running it

```bash
npm install
npm run dev      # web, http://localhost:5173
npm run build    # static build in dist/
```

## Web, iPhone, Android from one codebase

Responsive web app (sidebar nav ≥900px, bottom nav + "More" sheet below
that) with a `manifest.webmanifest`, so "Add to Home Screen" on iPhone/
Android installs it full-screen with no separate code path. For an actual
native shell, wrap the `dist/` build with [Capacitor](https://capacitorjs.com/)
— no UI changes needed.

## Swapping to Spring Boot + PostgreSQL later

1. Build REST endpoints matching `ApiStorageAdapter.js`'s calls, each backed
   by a table with a JSONB `data` column.
2. Set `VITE_USE_API=true` and `VITE_API_BASE_URL=https://your-api`.
3. Ship. No module, form, table, or permission code changes.

Two follow-ups worth doing at that point: swap the login screen's role pick
for a real authenticated session (JWT/OAuth), and enforce `viewableBy`/
`editableBy`/permissions server-side too — the client-side checks are a UX
convenience, not a security boundary.

## Identity & access

- **Login screen** — quick-pick demo accounts grouped by category (Executive
  Committee / Facility Staff / Owners & Residents), matching the 17 seeded
  roles: Super Admin, President, General Secretary, Treasurer, 5 EC
  sub-committees, Facility Manager, 5 handyman trades, Owner, Resident.
  Picking an Owner/Resident role asks a second question — which villa/unit —
  so the session carries a `unit`; that's what lets Maintenance (and the
  Properties directory) scope a resident to their own villa only.
- **17-permission model** (`MANAGE_ROLES`, `MANAGE_TICKETS`, `MODERATE_FORUM`,
  `VIEW_AUDIT_LOG`, etc.) drives which nav sections a role sees — handymen
  see only Maintenance; Security and Vendors require their specific
  permission; Billing's Ledger/Fund/Utility tabs are hidden from anyone
  without `MANAGE_LEDGER`/`MANAGE_UTILITY_BILLING` (residents still see and
  pay their own Dues).
- **Profile menu** — click the avatar or sidebar identity card to edit your
  display name/phone or switch accounts.

## What's real in each module (not just more tables)

- **Command Center** — metrics, a collection-performance chart, a
  fund-position donut (balances computed live from the ledger, not a static
  field), workforce panel, all derived from stored data.
- **Properties & Residents** — Units table plus a separate **Owners** table
  with click-to-call phone numbers; per-unit drill-down (Overview, Dues,
  Tickets, Documents, Amenities, Activity) cross-linking every module by
  unit number.
- **Maintenance — generic Task/Ticket engine** (`modules/tickets/`). One
  schema and one status machine (`Open → Assigned → In Progress → On Hold →
  Closed`, plus `Cancelled`/`Reopened`) drive both simple resident tickets
  and EC/FM/MEP operational tasks — which workflow applies is **data**
  (`TASK_TYPES`, Super-Admin/Facility-Manager-editable from the module's own
  "Task Types" tab), not code, so adding a new type (the seeded demo
  includes a ready-made "Pest Control" example) needs no code change.
  - **Role-queue → Accept**: a Resident Maintenance ticket is first assigned
    to a *role* (e.g. `Assigned Role = Plumbing`); every clocked-in staff
    member of that trade sees it and any one of them clicks **Accept**,
    which re-reads the ticket before writing and refuses if someone already
    took it — the closest a client-only, sessionStorage demo can get to the
    row-level lock a real backend (`SELECT ... FOR UPDATE` / optimistic
    version check) would use so two staff can't accept the same ticket at
    once. EC/FM/Super Admin can instead directly assign or reassign anyone,
    any time.
  - **EC/FM/MEP tasks** (EC Maintenance, Purchase, Capital Project,
    Emergency, ...) add an optional, independently-tracked financial
    workflow — `Quotation status`, `Invoice status`, `Payment status` —
    shown as a separate "Financial workflow" card, never folded into the
    core Task Status, and visible only to EC/Facility-Manager-level roles.
  - **Public vs. Internal discussion**: every ticket has one discussion
    thread; Internal posts (FM ↔ MEP ↔ EC ↔ Helpdesk) are tagged and hidden
    from residents entirely, Public posts (Owner ↔ Helpdesk ↔ Assigned
    Staff) are visible to everyone who can open the ticket.
  - **Resident-facing "My Maintenance"** — a simplified view with Open/In
    Progress/Closed counts and ticket cards (`#TKT-1057`, category emoji,
    status, assigned-to, created date). A resident only ever sees tickets
    for their own villa and only task types marked resident-visible — EC
    tasks, quotations, invoices and Treasurer discussions never reach them,
    on this page or from the Properties directory's per-unit Tickets tab.
  - Handymen still clock in to see their queue; new role-queue tickets still
    **auto-assign** to the clocked-in same-trade technician with the fewest
    open jobs, and clocking out still **auto-reassigns** that handyman's
    open tickets to the next available one.
- **Billing & Finance** — Dues (search/filter/stat cards); a DG/Water
  **utility billing calculator** ((current−previous)×rate+fixed+tax) whose
  "Generate bills" really creates a Dues record per property and whose
  "Send reminder" stamps every unpaid bill; Fund position with progress
  bars against budget; a Chart of Accounts ledger, with **fund balances
  computed live** as opening balance + ledger net (Credit−Debit).
- **Amenities** — a catalog with rules & regulations (must be acknowledged
  before booking), a day-based mini-calendar for full-day amenities
  (Clubhouse, Party Hall, Gym) and an hourly grid with **shared capacity**
  ("2/2 taken") for others, payment-mode selection, and clash detection
  everywhere.
- **Security & Visitors** — gate log with check-in/out, live "who's inside"
  stat chips, and incident reporting with a real status workflow (Open → EC
  review → Resolved) and an "Assign committee" action.
- **Vendors & Contracts** — category, contact info, and ledger entries can
  reference a vendor by name for spend tracking.
- **Communications** — a broadcast composer with a **notice template
  designer** (click a merge-field chip to insert `{{TOKEN}}` at the cursor,
  fill values, live preview), e-signature + reminder-frequency settings
  with a working "Sign & dismiss" action, a real reach estimate from the
  Properties directory, and a **threaded forum**: nested replies with
  trunk-line connectors, emoji reactions, delete-your-own-post-within-10-
  minutes, and live-percentage poll voting.
- **Governance** — EC roster, sub-committees, open approvals as editable
  panels, an upcoming-meeting agenda with a working text export, and the
  full searchable meetings list.
- **Documents** — search and category/access filters.
- **Roles & Permissions / Studio** — both use a compact list→detail editor
  (never a giant role×field grid); Super Admin can create custom roles and
  add custom attributes to any section, including all the newer ones.
- **Audit Trail** — search/section/action filters, pagination, and a detail
  modal on every row; every entry comes from an actual create/update/delete
  made through the app.

Every list in the portal is one generic component, `ServerTable` (see below).

## Known simplifications

A few things were intentionally kept simple given the scope of this build:
- Per-unit document access is filterable/displayable by unit but not
  cryptographically restricted to "that unit's specific owner" — there's no
  real per-user auth binding a login to one property.
- Handyman clock-in is trade-level, not tied to one specific named
  individual's login (multiple demo handymen can share a trade).
- Broadcast "viewed" tracking is a manual demo counter, not real delivery
  receipts.
- "Accept ticket" locking is a re-read-before-write check in the browser,
  not a real database transaction — correct for one user at a time, but a
  real backend should still enforce this with a DB-level lock/optimistic
  version check, since nothing stops two browser tabs from racing.
  Similarly, the five stage toggles on a Task Type (Quotation / EC Approval
  / Treasurer / Invoice / Payment) configure whether the EC-approval and
  Treasurer-authorization *sub-steps* are expected, but at the ticket level
  they're folded into the three fields that actually exist on a ticket
  (`quotationStatus`, `invoiceStatus`, `paymentStatus`) rather than five
  independent fields — their option lists (e.g. `EC Approved`, `Treasurer
  Authorized`) already carry those sub-steps.
- A resident session is scoped to one villa picked at login, not a real
  per-person account — any demo "Owner"/"Resident" login for a given villa
  can act as that villa's resident.

## Latest changes (Oct 2026)
- Maintenance: mobile list (no horizontal scroll), workflow chips with arrows,
  technician-only status dropdown, owner/admin/FM/MEP close-with-comment,
  owner cancel, 30-minute description edit window, photo upload (owner,
  technician, EC/FM), category-filtered assignee dropdown. Only Facility
  Manager and MEP among Facility Staff can create tasks.
- Properties: residents see only their own unit plus a contact-only directory;
  outstanding dues removed from the table.
- Amenities: bookings list on top (residents see only their own villa),
  compact amenity chips, calendar-first booking with greyed-out full days,
  admin-editable rules, pay & confirm.
- Forms: higher-contrast inputs, required-field validation in all schema forms
  and the ticket forms.

## Oct 7 changes — records, security, tables, rich text, uploads

**Every record has an Id + metadata.** `secureStorage.put` stamps `id` (e.g.
`DUE-3F9A12BC`), `recVersion`, `recordCreatedAt/By`, `lastUpdatedAt/By`; clients
cannot forge them. `RecordMeta` shows them on every form/detail, plus an
"Audit history" list for audit readers.

**Audit trail captures changed fields.** Each Update stores
`changes: [{field,label,from,to}]`, the record Id and unit; blocked attempts are
logged as `Denied`. No-op saves write nothing. The Audit page and a unit's
Activity tab show before/after values.

**Authorization (lib/security/authz.js, applied in lib/storage/secureStorage.js).**
Every read and write passes through, in order: collection access (permission /
category) → row scope (residents: own unit only; documents by access level;
other units' bookings masked; other units' properties reduced to the contact
directory) → field masking (`viewableBy`) on reads and `editableBy` on writes →
business rules (residents can only *Cancel* tickets; handymen cannot touch
financial fields or create tasks; internal EC/FM/MEP tasks can only be assigned
to EC members or vendors, never owners/residents/facility staff). Roles/schema
(Studio) writes need `MANAGE_ROLES` and are audited. **This is client-side
enforcement for the demo; the Spring Boot API must apply the same rules
(`@PreAuthorize` per endpoint + a field filter driven by the schema). Never rely
on the browser as a security boundary.**

**One generic server-side table.** `components/ServerTable.jsx` asks
`storage.query(collection, {page, pageSize=50, sort, filters, search, dateRange})`
for one page at a time, with per-field filters, date range, sortable headers,
page-size switch, and card rows on phones. `SessionStorageAdapter.query` and the
shared `queryEngine.js` implement it now; `ApiStorageAdapter.query` maps to
`GET /api/{collection}/query?page=&pageSize=&sort=field:dir&search=&dateKey=&from=&to=&f.field=value`
returning `{rows,total,page,pageSize,pages}`. Used by Maintenance, Properties,
Documents, Billing, Vendors, Governance and Audit.

**Rich-text comments.** `RichTextEditor` (bold/italic/underline/lists/link, paste
as plain text) + `RichText` renderer, with an allow-list HTML sanitizer applied
on save and on render. Used for ticket discussion, ticket close notes and forum
replies. The backend must sanitize again (e.g. OWASP Java HTML Sanitizer).

**File uploads (Documents).** Allowed: PDF, XLS/XLSX, TXT/CSV (images for ticket
photos). Checks: extension + MIME allow-list, size, magic-byte signature, PDF
active content (/JavaScript, /Launch, /EmbeddedFile), Office macros, EICAR test
virus. **A browser cannot run a real antivirus engine**, so the status is shown
as "passed local checks", not "clean". Set `VITE_SCAN_URL` to a backend endpoint
(POST multipart `file` → `{clean, signature?}`) fronting ClamAV and the status
becomes "clean (server scan)"; the backend must also re-validate and quarantine.
Demo limit is 1 MB (browser storage quota).

**Maintenance.** Ticket list is a table sorted newest first. Residents/owners can
only Cancel their own ticket (no Close). Internal tasks created by EC/FM/MEP are
assigned from an EC-members + vendors pool.

**Properties & Residents.** The resident contact directory now shows phone
numbers (plus a Call button). A unit's detail has Overview / Dues / Tickets /
Documents / Amenities / Activity, each with a "View all in …" jump to that
module pre-filtered to the unit.

## Oct 8 changes — facilities contract, quotations/approvals, ledger link

- **Category coverage** (Maintenance → *Category coverage*, also under Vendors): each ticket category → contracted vendor (e.g. ARC for amenities/electrical/plumbing/landscaping/cultural, SecureFirst for security), who coordinates it (Facility Manager / MEP) and the EC sponsor. Choosing a category on a new task fills **Assign to** from this table.
- **Task workflow**: assignee collects ≥2 quotations (`quotations` collection, with files) → one is selected → EC approval → Treasurer approval. **Superseded (Oct 8, later):** approvals are now read-only for everyone except the right role - see *Oct 8 (later)* below. Quotation/Invoice status values *EC Approved* / *Treasurer Approved* are selectable only by EC members. Sequencing is enforced in `secureStorage.put` (Treasurer after EC; quotations are now optional).
- **Financial indicator**: tasks flagged *Involves a financial transaction* show 💰, are filterable, and link to **Chart of Accounts** entries (`taskRef`). Billing → Chart of accounts lists financial tasks not yet in the ledger with a one-click "Record in ledger". Ledger vendor is a searchable combobox; entries take file attachments.
- **Ids**: `id` is a UUID primary key and is never shown; `shortId` (TKT-1051, LED-0004 …, per module) is what the UI and audit trail display.
- **Files** (tickets, quotations, ledger): images, PDF, Excel, Word, text/CSV — validated (type, signature, size, macros/active content, EICAR, optional ClamAV hook) and only stored when the form is saved. File visibility follows the owning record.
- **Ticket form** no longer autosaves: edits are held and written once with *Save changes* (one audit entry listing only changed fields). The discussion forum and raw file bytes are not audited.
- **EC members are owners too**: EC logins can pick a villa and raise maintenance requests like any owner.

Spring Boot notes: add `category_map`, `quotations` tables/collections; `files.ownerType/ownerId`; generate `shortId` from a per-module sequence; re-implement `ticketFinanceGuard` / approval sequencing from `lib/security/authz.js` and `secureStorage.js` server-side.

## Users, roles and categories

- **Category** (`EC` / `Staff` / `Resident`) is a property of a **role**, set when the role is created and changeable in *Roles & Permissions → click role → Category* (audited, with a confirmation because it changes data access for everyone holding the role). The three categories are fixed in code (`lib/access/roles.js`) because row/field rules key off them.
- **User** (*Administration → Users*): name, phone, email, status, one primary role, optional additional roles and the villa(s) owned. A user's category always comes from their role.
- **Sign-in**: the login screen lists active users (*People*); someone with several roles picks which to sign in as. *Demo roles* is kept for previews. Spring Boot replaces this screen with real authentication and a `users` table.

## Oct 8 (later) — approvals, vendors, utilities, inventory

- **Approvals**: EC approval is editable only by EC-category roles, and *Approved by* / date are stamped from the logged-in user (not typeable). Treasurer approval is editable only by the Treasurer / President (and after the EC approval). Everyone else, including Facility Manager and MEP, sees both read-only. Enforced in `ticketFinanceGuard` (`lib/security/authz.js`). **Quotations are optional.**
- **Vendors**: not every vendor has a contract - *Engagement* = Contract / AMC / Local (no contract). Optional address, rich-text description, contract/AMC documents, and a per-vendor **discussion** (`vendorComments`, not audited). Spend / compliance / rating are gone: money lives in **Billing & Finance → Chart of accounts** (pick the vendor on the entry) and is summarised in the new **Vendor ledger** tab.
- **Utilities (Operations → Utilities (Water & DG))**: monthly meter readings per villa with photos (`readings` collection). Previous reading is prefilled from last month. *Publish* turns a reading into a Water/DG bill in Dues using the rate card and the chosen **notice template**; the due carries the readings, the rendered notice and the photos, so the owner sees them by clicking the bill in Billing → Dues. Published readings are locked. Permission **MANAGE_UTILITY_READINGS** (Facility Manager, MEP, Helpdesk, and EC by category) - give it to any role in Roles & Permissions. New **Helpdesk** staff role + seeded user.
- **Inventory** (Operations → Inventory): supplies per category with quantity, re-order level (auto Low / Out of stock) and attached documents. EC, Facility Manager and MEP maintain it.
- **Chart of accounts** is visible (read-only) to the Facility Manager. Clicking a financial task in the Chart of accounts (or a ledger entry's linked task) opens that task's details in Maintenance.
- **Forms**: every data-entry form has a specific header and a one-line purpose. Dates cannot be picked in the past (`allowPast: true` on the schema field marks events that already happened - possession date, transaction date, quotation date, reading date, last restocked, broadcast sent date); date filters in search stay unrestricted.

Spring Boot notes: new collections `vendorComments`, `inventory`, `readings`; `dues` gains meter fields (`readingId`, `previousReading`, ..., `notice`, `photos`); `files.ownerType` adds `vendor`, `inventory`, `reading` (a resident may read a `reading` file only when one of their own dues points at it - see `filesScope`). Re-implement the `DUES`/`READINGS` custom guards server-side.

## Oct 8 (evening) — task form, coordinators, payments, My home

- **Rich text**: *Additional details* on a task, ticket description, inventory notes and amenity *Rules & regulations* all use the one shared `RichTextEditor` / `RichText` pair (schema type `richtext`), so toolbar changes apply everywhere. Rules now sit above the booking calendar.
- **Materials / vendor cost** shows only when the task is flagged financial.
- **Coordinated by** is now a list of **roles** (schema type `roles`, multi-select chips in Vendors → Category coverage). **Assign to** on a task lists the contracted vendor, the EC sponsor and the active users in those coordinator roles (`coordinatorUsers` in `ticketEngine.js`; the same rule is enforced in `secureStorage.put`). Names + roles of users are now readable by staff (phone/email stay admin-only).
- **Vendors**: fuzzy duplicate check while typing (`lib/fuzzy.js`, schema flag `suggestSimilar`) and an exact-duplicate block on save.
- **My home / Properties**: click a row in Dues, Tickets, Documents or Amenities for its details; the *Activity* tab is EC-only; "View all in …" links are gone; the contact directory sits behind a **View all contacts** button.
- **Pay a due** (`components/PayDue.jsx`): one flow used from Billing → Dues, My home → Dues and a unit's page. Owners pay online (simulated - plug the gateway into `confirm`); finance roles record cheque/cash/transfer with reference and date. The bill gets paid-on, mode, reference, paid-by and a receipt number. Residents can change nothing else on a bill (`DUES` guard).
- **Utilities**: the previous reading is filled from the villa's last reading (or last published bill) whenever one exists, and says where it came from.

## Oct 8 (afternoon) - SLA, compact approvals, quotations & invoices with GST
- **SLA due** is a date, must be today or later, and after the task is created only an EC member can change it (UI + `ticketSlaGuard` in authz.js).
- **Approvals** are one slim card: EC step, then Treasurer step, each with Approve / Reject / Undo for the people allowed to decide. The old Quotation status / Invoice status dropdowns and the second set of approval selects are gone.
- **Quotations and invoices** are uploaded on the task (both live in the Quotations collection, `kind` = Quotation | Invoice). Choosing a quotation, or uploading an invoice, sets the amount under approval (`approvalStage`) and restarts EC -> Treasurer. FM / MEP may reset approvals to Pending but can never record one.
- **Invoice GST**: invoice no., amount, GST none / included / extra and rate (5-28%). Taxable value, GST and total are computed (`gstSplit`). "Record in ledger" copies them to the Chart of Accounts, which shows a GST input credit column and a total.

## Oct 8 (late afternoon) - configurable final approvers
- Maintenance -> **Final approvers** (President / Treasurer / Super Admin only): tick the roles that give the final approval after the EC. Default Treasurer + President. Eligible roles: EC roles, Facility Manager, MEP.
- Stored in the `approverSettings` collection (one row). The Approve button, the "waiting for your approval" banner and the server check (`isSecondApprover` in authz.js, refreshed by secureStorage before each ticket write) all follow it.

## Oct 8 (evening) - invoices, closing, assignee rules, Treasurer dashboard
- **Invoices** each carry their own approval (EC, then a final approver) on the task; the task-level approval card now covers the selected **quotation** only. Uploading a quotation or invoice moves Open / Assigned / Reopened tasks to **In Progress**.
- **Record in Chart of Accounts** appears on every fully approved invoice (ledger roles); the ledger row keeps `sourceId`, invoice no., taxable value and GST input credit. Billing -> Chart of accounts lists approved-but-unbooked invoices.
- When **every invoice is approved** (and any selected quotation is), the task **closes automatically** with a system comment. Only **EC members can reopen** (UI and server).
- **Assigned to** is mandatory for internal tasks and never lists vendors (vendors go on quotations / invoices). Redundant "Created" field removed from the task detail.
- **Non-financial tasks**: staff or the assignee set **Completed**; a reminder comment is posted to the raiser, who sees a banner and a Close option. The **assignee** can close a ticket too.
- **Treasurer dashboard** (Billing & Finance -> Dashboard; Treasurer, President, Super Admin, ledger managers): fund balances, cash flow, vendor spend, GST input credit, dues status and the approvals pipeline, each with a table view.

## Round: groups, category coverage, close rules, status trail

- **Roles & Permissions**: the UI says *Group* (EC / Staff / Resident); the stored field is still `category`.
- **Category coverage**: type a new category name to add it (it then appears when raising tasks and in filters); *Executive Committee* is a coordinator choice (`group:EC` = every EC role); contracted vendor is optional; Notes is rich text; EC sponsor removed.
- **Closing**: the assignee cannot close or cancel. Allowed: the ticket owner (Close once Completed, Cancel any time), EC members, admin; the final approver closes automatically after the last invoice approval; a non-financial task whose type requires EC approval is closed by the EC's *Approve & close*. Enforced in `authz.js` (TICKETS guard).
- **Status** dropdown offers Closed/Cancelled only to those roles. The breadcrumb is the real movement (`statusHistory`, stamped in `secureStorage`).
- Financial workflow: Payment status and Materials/vendor cost removed; the whole section is hidden on Resident-type tasks for every role.
- **Chart of Accounts** has a Category column/filter (filled from the task when recorded); the Treasurer dashboard has *Spend by category*.
- **Tickets tab**: summary cards filter the table on click; the ⟲ icon resets cards, dropdowns, search and dates.

## Notifications (simulated push)
- `lib/notifications.js`: on a ticket save, an **assignment** notifies the assignee and a **status change** notifies the ticket owner (never the person who made the change). Stored in the `notifications` collection.
- UI: 🔔 bell with unread badge, a phone-style push banner for live events, and (after "Enable browser alerts") a real OS notification.
- Every notification carries a **deep link** `#/ticket/TKT-1055`; tapping it, or opening that URL and signing in, opens that exact ticket.
- Going native: the same payload (`title`, `body`, `data.url`) is what the Spring Boot backend would send via FCM (Android) / APNs (iPhone); the app's `#/ticket/<no>` route is the in-app target. On the web today, closed-tab push needs a service worker + Web Push (iPhone: only for an installed home-screen web app, iOS 16.4+).

## DG & Water collections in the Chart of Accounts
- One summarised **Credit per utility per billed month** (e.g. "Water collections — Aug 2026 (18 of 212 villas paid)"), Category = DG or Water, re-totalled automatically whenever a villa's bill is paid or un-paid (`lib/utilityLedger.js`, called from `secureStorage.put` on dues). Per-villa detail stays in Billing → Dues; the ledger line's `sourceId` is `dues:<Utility>:<Month>`.
- Residents can't write the ledger, so this is a system posting, audited as "System · utility collections".
- They post to their own **DG fund** and **Water fund** (not the General fund), so collections and matching costs net off per utility.

## Accounts & Budget (from the Treasurer's workbook)
Billing → **Accounts & budget** (Treasurer / EC / MANAGE_LEDGER only) turns the "La Paloma A/c Entries" workbook into live screens:
- **Accounts & FDs** — the six real HDFC accounts (Maintenance, Electricity/Water/Tax, Sinking, Corpus, Cultural, Ganesh) with balance, sweep-in and other FDs; each balance is checked against the bank's own closing balance in the imported statements. **Money left for this year** reproduces the sheet's working with editable estimates and account tick-boxes.
- **Budget FY27** — income and expense lines, forecast vs the sheet's "already spent" vs what the statements show.
- **Fixed expenses** — monthly commitments × months to pay, against actual average payments.
- **Bank statements** — ~3,840 lines (sweep-in/out mechanics left out), each sorted into a budget head by readable rules in `lib/bank/analysis.js`.
- Funds in the Chart of Accounts are now the six real accounts; DG/Water collections post to Electricity/Water/Tax with the utility as Category.
- Workbook dates arrive with day/month swapped when the day ≤ 12 (Excel read dd/mm as mm/dd); the loader corrects this. Account numbers are kept as last-4 only.

## Accounts & budget, round 2 (Billing → Accounts & budget)

- **Accounts & FDs**: editable, **+ Add account**, no Check column. “Show” selector looks back at any previous month-end. Updating an account to a new “As of” date keeps the earlier figures as history (`history` on the account), so past months show saved balances + FDs; months with no saved summary fall back to the bank’s closing balance (FDs shown as “—”).
- **Budget** (any financial year via the FY selector; FY25 partial, FY26, FY27 from the statements): Spent (sheet) is gone. Each line shows Forecast, statements, **Others** (manual amount), still to come and the previous year’s actual. Only Line, Forecast, Others and rich-text Notes are editable on an existing line; new income/expense lines also choose the statement heads they track. “Copy the FY27 lines into FY26” seeds a past year.
- **Fixed expenses**: editable + add, “Forecast avg / month”, Vendor / government department (free text allowed). The **Can we cover it?** strip (cash + FDs on hand, income to come, reserve, still to pay, headroom, months of cover) replaces Money left; **Adjust estimates** edits the shared `financeSettings` row.
- **Bank statements**: Year + Month + Account filters; **Import Excel** (SheetJS, loaded on demand) with a preview, duplicate skipping, automatic head categorisation and one audit entry; **Import rules** (finance editors) map the bank’s Excel headers to portal fields, with an option to repair day/month swapped by Excel.
- **Billing dashboard** is now driven by the statements and budget for the chosen FY (cash flow, income/spend vs forecast, spend by head, headroom tile) and still carries GST, vendors, categories, dues and approvals. The Fund position tab is removed.
- New collections: `importProfiles`, `financeSettings`; `secureStorage.importMany` for bulk writes. Bump `DATA_VERSION` resets older demo data.

## Assets & utilities, cross-check, exports, tab permissions (Oct 9)

- **Assets & utilities** (new nav item; Treasurer/EC/FM/utility roles): **DG fuel log** (refills, meter readings, performance: L/hour, L/kWh, ₹/kWh, "High use" flag, compared with bank-statement diesel and DG billed to villas), **Electricity bills** (all key bill details in one record: service no., period, units, MD kVA, load, fixed/energy/other charges, status, payment, cost per unit; sum-of-charges validation), **Villa electricity** (monthly units/amount/MD per villa, Excel import), **Inventory** (stock with a Location field; the standalone Inventory page was removed from Operations) and the **Equipment & assets** register.
- **Payments cross-check** (was Chart of accounts). Vendor ledger and Fund position removed. **Financial tasks** shows only financial tasks in four buckets: To record, Recorded, Not recorded, In approval. Recording requires choosing an account; **Don't record** needs a reason and is kept in `ledgerSkips` (restorable).
- **Dashboard**: charts derived from ledger data (vendors, categories, GST) removed.
- **Budget / Fixed expenses**: notes span two columns; hover (or focus) the "Can we cover it?" figures for how each is derived.
- **Export icon** on tables (ServerTable toolbar exports all filtered rows; Accounts, Income/Expense, Fixed tables too) → .xlsx.
- **Required fields**: `*` and inline validation on schema forms (automatic from `required: true`) and hand-built forms.
- **Tickets**: each category can have managed **sub-categories** (Super Admin, Category map); required when raising a non-resident ticket.
- **Page tab permissions**: Roles → "Page tabs" checkboxes hide tabs per role (`hiddenTabs`; deny-list only, never grants access; Super Admin always sees all). Catalog in `lib/access/tabs.js`.
- All action buttons are light blue (`styles.css`). `DATA_VERSION` = `2026-10-09-c`; run `npm install` for `xlsx`.


## Round: assets, electricity, import rules, communications, e-voting, governance, documents (Oct 9, later)

- **Equipment & assets** (was STP/WTP equipment): one register for STP/WTP motors, clubhouse ACs, CCTV cameras + NVR, UPS/battery, street lights, lifts, network gear. Identical items share a row with a **Quantity** and an exact **location/zone** (e.g. "Lane C poles 1-12"); UPS rows also hold backup hours and battery-changed date. Stat cards total cameras and street lights.
- **DG fuel log** has an optional **Linked task** (lookup of maintenance tasks).
- **Electricity bills / Villa electricity** now carry **units exported**, **credit units** and **credit amount**; bill validation is charges − credit = total payable. Filters are **Year + Month** (dropdowns built from the data); the bill due-date filter is gone. Free-text filters (e.g. villa month) now list the values that exist in the data - that was the empty "All months" bug.
- **Import rules**: the villa-electricity Excel import uses `villaImportRules` (Super Admin maps each column to the file's exact heading, header row, sheet, "Villa " prefix). "Auto-detect" remains. Bank-statement import rules were already mapped; Super Admin is allowed to edit both.
- **DG / Water bill templates**: notice templates have a **Used for** field (Any / DG bill / Water bill / Announcement); publishing a bill offers the templates for that utility and pre-selects the one made for it. New merge fields: UNIT, PREVIOUS_READING, CURRENT_READING, UNITS_CONSUMED, RATE, FIXED_CHARGE, TAX.
- **Command Center** shows a **Maintenance summary** (open, past SLA, high/critical, not yet picked up, on hold, to close, by status/category, most overdue). **Workforce availability by trade** was removed from Maintenance.
- **Assignment in a category with several staff**: nothing is auto-assigned; the ticket stays Open and someone in the category assigns it explicitly (to themselves or a colleague). While it is Open or Assigned, another member can **Reassign to me**. A category with exactly one person still auto-assigns. Clocking out returns not-started tickets to the queue.
- **Communications** is tabbed: *Announcements & polls*, *E-voting*, *Notice templates*, *Forum*. Messages are **rich text**. Audiences: All residents, Owners, All villas, All apartments, **Selected villas / Selected apartments** (search + zone filter + select-shown + paste "12, 35, 135-150"), EC, Staff. Residents only receive announcements addressed to them (row scope in `authz.js`).
- **Polls** work like WhatsApp: 2-12 answers, optional multiple answers, optional close date, change your vote until it closes; residents see counts only, staff also see who voted.
- **E-voting** (owners only; `lib/evoting.js`, `modules/communications/EVoting.jsx`):
  1. *Electorate frozen*: when voting opens, the voter roll (one entry per unit with a registered owner) is stored on the ballot with a SHA-256 fingerprint; an open ballot cannot be edited.
  2. *One vote per unit*, only by the primary/secondary owner signed in for that unit; tenants, EC and Super Admin cannot vote.
  3. *Two factors*: signed-in owner + a 6-digit code to the registered mobile (5 min, 3 tries, 30 s resend, stored as a salted hash). The code becomes a single-use proof the write path demands. The demo has no SMS gateway, so the code is shown as a "Simulated SMS".
  4. *Secret but verifiable*: `voteRoll` records which unit voted; `ballotBox` records what, with no unit, name or time of day. Each box row has a receipt and a hash chain; **Verify** recomputes it, and the final fingerprint is stored on the ballot at close.
  5. *Immutable and sealed*: roll marks and box rows can never be edited or deleted (Super Admin included); nobody can read the box until the ballot is closed; closing is only possible on/after the closing date.
  6. Roll marks and open/close are audit-logged; box writes are deliberately not attributed.
  **Production hardening** (this runs in the browser, which is not a trust boundary): repeat every check in the Spring Boot service, send the OTP through an SMS/e-mail gateway, keep roll and box in separate tables with separate DB roles, shuffle/queue box writes to break timing links, and anchor the chain head with an external timestamp.
- **Governance**: Executive Committee and Sub-committees are derived from Roles & Users (no Add buttons); click a name or a sub-committee for member details (phone/e-mail/villa only for EC and management). *Open approvals* removed. Meetings have date + start/end time pickers, rich-text agenda, agenda files, rich-text minutes and signed-minutes files. Standard upload formats now include Word, Excel, PowerPoint, RTF, PDF, text and common images.
- **Documents**: *Access* became **Group** (Everyone, All owners, Executive Committee, EC + Finance, Staff, Villa owner / resident). For *Villa owner / resident* the **villa is mandatory** and only the owner/resident signed in for that villa (plus document managers) can open the document or its file. A new **Uploaded** date column was added.
- `DATA_VERSION` = `2026-10-09-e`.

## Opening on a phone (iPhone / Android)
Plain `http://<LAN-IP>` is not a secure browser context, so `crypto.randomUUID` and `crypto.subtle` are missing there. The app no longer depends on them (`src/lib/uuid.js`, pure-JS SHA-256 fallback in `src/lib/evoting.js`), and builds target Safari 13+.

To view on a phone (same Wi-Fi as the computer):
- Dev: `npm run dev -- --host` then open `http://<computer-IP>:5173`
- Build: `npm run build && npm run preview -- --host` then open `http://<computer-IP>:4173`
If it still won't load, check the computer's firewall allows the port. For HTTPS use a tunnel (e.g. `cloudflared tunnel --url http://localhost:5173`).

Mobile note: the page itself never scrolls sideways (html/body clipped, inputs 16px so iOS doesn't zoom-and-pan on focus); wide tables and tab bars scroll inside their own box.

## Round: financial workflow, SLA, infinite scroll (Oct 9, afternoon)
- Quotations: the selected quotation shows a green ✓ and carries its own EC + Final approval (same look/actions as invoices); "Record in Payments Cross-check" appears on it once both approve. Select/Unselect are small buttons.
- When a task has invoices, quotation selection is disabled. When it also has quotations, each invoice must be Selected before it goes for EC/final approval (unselected invoices are ignored for closing and for the Payments list).
- Invoice number removed everywhere.
- SLA due is required when raising (and when an EC member edits) a task; resident-raised tasks get an SLA from priority (Critical today, High +1d, Medium +3d, Low +7d). Tasks list has an SLA due column; the "Created" date-range filter is gone.
- Pagination footers are gone: `ServerTable` loads the next page as you scroll (IntersectionObserver), with a record count in the toolbar. Amenities bookings list does the same.

## Multi-community platform (Oct 9, evening)
One installation hosts many communities. Each has its **own web address, roles, users and data**; one person can belong to several, with a different role in each.

- **Web address → community** (`src/lib/community.js`): `palm-meadows.communityos.app` (sub-domain; `x.localhost` in dev) or `host/c/palm-meadows` (path; used by this demo and by IP/localhost installs). A plain host opens the default community (`VITE_DEFAULT_COMMUNITY`, `la-paloma`). `platform.<domain>` or `/platform` is the Platform Admin console.
- **Isolation**: every storage key is `communityos:<community>:<collection>`; the API adapter sends `X-Community-Id`. In Spring Boot/Postgres: a `community_id` column on every table, taken from the signed-in token (reject a mismatch with the header), plus row-level security as a second guard.
- **Platform console** (`/platform`): create a community (name, web address, unit types, first Super Admin by e-mail, optional demo data), suspend/activate it, add people to it, and see people across communities. A new community starts with the default roles/permissions, all field-access schemas, task types and approval workflow, categories, notice/bill templates and merge fields, amenity types, committee slots and import rules — but no people, villas or money.
- **One person, several communities**: identity = e-mail. Each community keeps its own user row (own role(s) and villa). The profile menu offers "Switch to <community>" for every other community that has the same e-mail; the hand-off signs them in there with that community's role (single sign-on in production).
- Demo limits: data is `sessionStorage`, so open communities from the console in the same tab (a new tab starts empty); the platform sign-in is a demo button.

## Maintenance redesign (Oct 10)
- Phone: ticket list is a stack of cards (priority edge, status, SLA chip that turns amber/red, assignee, approval chip) with a sort menu and a scrolling summary strip; desktop keeps the table with a priority edge. `ServerTable` takes `cardRender` / `cardSorts`.
- Ticket detail: header with status, priority, invoiced amount, SLA, owner and a "N approvals waiting for you → Review" shortcut; the money section comes first; EC → Final → Payments is a vertical timeline with large Approve / Reject buttons; an approved step keeps only a quiet Reject / Undo.

## Maintenance redesign (tabs, tiles, cards)
- **Ticket detail** is a tabbed sheet: Overview | Money (dot when something waits for you) | Chat (count) | History. Residents get Overview | Chat | History (no Money). A sticky bar offers "Approve as EC / final approver" + Reject for whatever waits on you, or Save/Discard when edits are pending.
- **Chat** splits Public / Internal (staff only) as a segmented switch with a composer; **History** is a timeline derived from the ticket, its quotations/invoices, approvals, ledger entries and system messages.
- **List**: status tiles (All/Open/Active/On hold/Closed), Mine/All, approval banner, cards with age, money strip, "Needs your approval" chip. **Raise sheet**: common-issue chips, category chips, priority switch, Choose photo / Camera, sticky Cancel/Submit.
- Reusable pieces live in `components/ui.jsx` (SegTabs, Segmented, StatTiles, ActionBar, Chips, MoneyTiles). Every `ServerTable` now shows cards on phones automatically (first column = title, next columns = label/value; sort dropdown built from sortable columns); pass `autoCards={false}` to opt out.

## Amenity booking, rates, GST, deposits & notifications

**Screens** (Amenities): Bookings · Payments · Rates & rules · Notifications · Reports (staff tabs hidden from residents).

- **Rates** (per amenity): per hour / per day / free, optional weekend rate, GST applicable + rate + Exclusive/Inclusive, refundable security deposit, minimum notice and booking window. The resident sees a live price breakdown (taxable value, CGST/SGST, fee, deposit, total). The server recomputes every amount; client-sent figures are ignored.
- **Cancellation rules**: editable tiers (hours before → % of fee refunded). Deposit is always returned in full. Staff can waive (full refund) or override.
- **Payments**: UPI/Card/Net banking (simulated gateway, paid at once), Cash/Cheque (booking stays "Pending payment" until staff record receipt; auto-released after *N* hours), or unit credit.
- **Credited**: paid fee → ledger Credit (taxable + GST recorded); deposit → separate Credit. Refund to unit credit → `unitCredits` Credit row; cash refunds → ledger Debit when paid out.
- **Notifications**: templates per event × channel (Email/SMS/WhatsApp) × audience (Owner/Admin) with `{{tokens}}`; admin and report recipients; in-app bell. Messages are queued in `notificationOutbox` (**demo: not delivered** — a Spring Boot gateway sends them).
- **Reports**: daily and weekly/monthly summary (taxable, GST, fees, deposits, refunds, net, pending, refunds due, deposits held) → WhatsApp group / e-mail / SMS recipients; preview and "Send now".
- **Scheduler** (`runAmenityScheduler`): releases unpaid bookings, completes past ones, day-before reminders, scheduled reports. Idempotent; runs on sign-in and every 5 min.
- **Permissions** (editable in Roles): `MANAGE_AMENITY_RATES`, `MANAGE_AMENITY_RULES`, `MANAGE_NOTIFICATIONS`, `MANAGE_AMENITIES`. Defaults: President/Amenities Committee all; Treasurer rates; Gen. Secretary rules + notifications; Facility Manager operations + rules. Existing communities must grant these to their roles.

## Groups, role-level control, utilities, command center (round 12)

- **Permission groups** (Roles & Permissions → Groups, Super Admin): a group = name + access level (EC / Staff / Resident) + default permissions. A role joins one group, inherits its permissions, and can **add** or **remove** individual ones (`addedPermissions` / `removedPermissions`; shown as `+ added` / `− removed`, with "Reset to group defaults"). Editing a group re-applies to every role in it; a group in use cannot be deleted. Roles that pre-date groups are migrated into the group of their access level with their permissions unchanged.
- **Role-level control of everything**: permissions (data), **pages** (left menu, per role), **tabs** (now incl. all Amenities tabs and ticket-detail Money/Chat/History), **fields** (Studio: view/edit per role, bulk by group, relabel, required, options, table column).
- **Custom attributes** added in the Studio now also appear on the hand-built screens: maintenance tasks (raise + detail), amenity bookings and meter readings (`components/CustomFields.jsx`), as well as every schema-driven form.
- **Utilities**: Utilities → Manage utilities (needs `MANAGE_UTILITY_TYPES`, Super Admin by default) adds a metered utility (gas, borewell, EV…). It gets readings, a rate card, bills and collections like Water/DG.
- **Payments cross-check ↔ Amenities**: every paid booking, cancellation and refund posts automatically (fee + GST, deposit, cash refunds; refunds/payments through unit credit as paired non-cash rows) and a summary panel sits on top of the tab.
- **Command Center**: tappable maintenance cards deep-link to the filtered Maintenance list.
- **E-voting**: ballot options are fully editable (✕ to remove, add any), owners see every option as a large card.
- **Rich text**: the formatting menu is collapsed behind an `Aa` glyph.

## Property registration, phone identity & portal access (round 13)

**Who is on a property** – *Occupied by* (Owner / Tenant / Vacant); the **primary owner (on the lease / title)** with a mandatory mobile; a **tenant** (name + mobile mandatory when "Tenant occupied"); and any number of **additional owners / tenants / contacts** (optional list; mobile mandatory for each row). Everyone listed receives communications. The old "secondary owner" columns are folded into the list automatically (`lib/people.js`, `propertyPreWrite`).

**Phone numbers** (`lib/phone.js`, libphonenumber-js) must start with a country code and are checked semantically: real country, valid length and pattern for that country, and not a placeholder (`+91 99999 99999`, `1234567890`…). They are stored in E.164 (`+919845671230`); the form validates as you type and again on save, and the server hook (`lib/propertyServer.js`) repeats every check. One number = one person: the same number cannot be registered to two different names.

**Portal access follows the register** – saving a property creates/updates the person's account (owners → *Owner*, tenants/others → *Resident*, status *Invited*) and queues a sign-in link `…/#/join/<token>` (valid 7 days) to their number by SMS + WhatsApp. If the number already belongs to someone in this community, the villa is simply added to their account; if they already use another community, the profile menu shows **Switch to …** (people are matched across communities by phone *or* e-mail).
Opening the link, or choosing the **Phone** tab on the sign-in page, asks for a one-time code to the registered number.

**Changing a number** – editing a phone (or removing a person) shows a warning and requires "I understand". On save: the old number's account for that villa is deactivated at once (it stays active only if the person still has another villa or a committee/staff role), open invites are revoked, a removal SMS is queued to the old number and a fresh invite goes to the new one. A signed-in person whose account is deactivated is signed out with an explanation. The property screen shows each person's portal state (Invite sent / Active / Deactivated).

**One vote per villa** – owner ballots: the roll has one entry per villa holding all owners (primary + additional owners; tenants excluded); any one of them may cast the villa's single vote with a code to their own phone, and the second attempt is refused ("already voted, by …"). Polls / announcements to all residents: one answer per villa; other household members see who voted for the villa.

**Demo limits** – SMS/WhatsApp are only *queued* in the Notification Outbox and OTP codes are shown on screen ("simulated SMS"). Production needs an SMS/WhatsApp gateway and real session issuing in the Spring Boot service; the rules in `propertyServer.js`/`portalAccess.js` map one-to-one to service methods. Set `VITE_LOGIN_DEFAULT=phone` to open the sign-in page on the Phone tab (the demo opens on *People*). Excel/bulk imports that write properties directly bypass `propertyPreWrite` and must call the same validation.

## Round 14: multi-quotation, stay on Billing, previews, Gas templates, meeting publishing

- **Several quotations per task** – on a task's Money tab, *Select* now works on more than one quotation (e.g. materials from one vendor, labour from another). The selected quotations are approved together as one chain (EC, then final) for their total; each can be recorded in the Payments cross-check. `selectedQuotationIds` holds the set; `selectedQuotationId` stays the first one for older screens. Invoices already supported multiple.
- **Stay on Billing & Finance** – opening a task from the Payments cross-check (task list or a ledger row's "Open task") shows the task on top of Billing; closing it returns to the same tab. (`TicketsModule` has an embedded mode.) Opening from the Command Center / bell still goes to Maintenance.
- **In-app file preview** – clicking an attachment opens a preview: images, PDF (browser viewer), Word .docx (mammoth), Excel/CSV (SheetJS table), text. Old .doc, PowerPoint and RTF cannot be rendered by browsers and offer Download. Download is a button inside the preview.
- **Utilities → templates** – every utility (Gas included) gets a "<Name> bill" notice template automatically (editable in Communications → Notice templates), and "Used for" lists it. Utilities you added earlier are healed on next sign-in. The Notice-template designer warns about unknown `{{TOKENS}}`.
- **Merge field library** – Communications → Notice templates → *Merge field library*: edit labels / default values, add custom fields (`GAS_METER_NO`…), delete custom ones. *Automatic* fields (amount, month, readings, rate, tax, unit, society name…) are filled by the app for every utility and cannot be deleted. Custom fields always use their default value.
- **Meetings: publish & notify** – each meeting is *Internal (committee only)* or *Published to residents* (older meetings count as published). Residents only see published meetings. Publishing sends an in-app notification to all owners/residents (and, from round 15, WhatsApp / SMS / e-mail only to people who opted in — see below); later date/time/place changes, cancellation and minutes notify again. Governance has a Publish / Unpublish button. (Messages are queued in the demo outbox, not delivered.)

## Round 15: uploads, shifts, previews, Super Admin delete, notification management, invoice OCR

- **Uploads no longer hang** – the cause was every file's bytes sharing one session-storage key (≈5 MB browser quota); a full quota threw inside the save and left the button on "Saving…". File bytes now live in IndexedDB (`lib/storage/fileBlobStore.js`, behind the same `StorageAdapter`; becomes object storage with the Spring Boot service), limit 10 MB per file, and any storage failure shows a message instead of freezing the form.
- **Staff Shifts** (Operations → Staff Shifts) – Day, Week and Month views. Each person has a usual shift (Field Staff → Shift); a planned shift (Morning 06–14, Afternoon 14–22, Night 22–06, General 09–18, Off) is stored per person per day in `shifts`. Change a single cell, or use *Assign shifts in bulk*: chosen staff × a day / the shown week / the shown month / a custom range × chosen weekdays. Re-planning replaces; one audit entry per bulk change; planned staff are notified. Needs "Manage field-staff duties"; others see the plan read-only; residents don't see the page.
- **Previews everywhere** – attachments on tasks, quotations, invoices, readings, bills, inventory and form file fields were already previewable; Documents (list and detail) and the legacy photo thumbnails on tasks now preview in the app too (images, PDF, .docx, .xlsx/.csv, text; .doc/.ppt/.rtf offer download).
- **Super Admin delete** – a *Delete* button (confirm first, audited) on tasks, quotations/invoices, properties, broadcast messages, forum topics/replies and every schema-driven form. Deleting a task also removes its chat, quotations and the files attached to it; deleting any record removes its attached files. **Never deletable, by anyone:** the audit trail, cast votes / voter roll, and ballots once opened.
- **Notification management** (Notifications page, 🔔 → *View all*) – the **App** (bell, banner, list) is always on. Each person chooses extra channels under *My channels*: WhatsApp, SMS, E-mail (to the phone / e-mail on their portal account). Management (EC / Manage-notifications) sees *Channel settings* – per kind of notification, which extra channels the community offers – and the *Delivery log* (everything queued per channel). All sending goes through `lib/notify.js`. Sources: task assigned / status / quotation-invoice decisions, bills published, announcements & polls, e-voting opened, meetings, shifts planned. Portal invitations and OTPs are transactional and are sent regardless of preferences.
- **Invoice → inventory (OCR)** – Assets & utilities → Inventory → *Add from invoice*: choose a PDF or photo; text PDFs are read from their text layer, photos/scans with Tesseract OCR running in the browser (engine and English data are bundled in `public/ocr`, ~11 MB, no internet needed). You get the document beside an editable table (supplier, invoice no., date, item, category, qty, unit, rate, amount), can drop/add lines, then *Confirm* saves to Inventory (items already in stock are topped up) with the invoice attached. The parsing is heuristic: always check the lines.

**Demo limits** – WhatsApp / SMS / e-mail are only queued in the Notification Outbox, never sent. Extra channels need the person to have a portal account (Users) with a phone / e-mail; the demo role logins have none. OCR accuracy depends on scan quality (handwriting and skewed photos are poor); GST-inclusive tax columns are not split out.

## Document repository folders

Documents → left panel shows a folder tree (nested to any depth) with counts, *All documents* and *Not in a folder*. Create folders / sub-folders (inside the folder you have open), rename, and delete — deleting a folder moves its documents and sub-folders up one level, nothing is deleted. Uploads default to the open folder; any document's detail has a *Folder* picker to move it. Folders are only an organising layer: each document keeps its own access group, so a resident sees a folder's count and list limited to what they may open. Managing folders needs "Manage documents" (same as uploading). Starter folders (Governance & minutes, Legal, Vendor contracts, Finance & audits, Villa documents) can be created with one click on an empty tree. Documents already uploaded appear under *Not in a folder*.

### Folder access by role, and where files are stored

- **Folder access** – open a folder → *Rename / access* → choose the roles that may open it (or *Executive Committee* for all EC roles). The limit covers the folder, every sub-folder and every document in it (and the file behind it); each document's own group still applies on top. Empty = no extra limit. Locked folders show 🔒. Only Super Admin always sees everything. Enforced in `authz.js` (`folderAllowed`, applied to folders, documents and their files), not just hidden in the screen.
- **Where the files live** – today (demo) in the browser's IndexedDB, per community, behind `StorageAdapter`; nothing goes to S3 or Azure Blob. For production, the metadata (name, size, mime, folder, owner) stays in PostgreSQL and the bytes move to object storage (S3 or Azure Blob, one container/prefix per community): the Spring Boot service checks the caller's role / folder / document group, then issues a short-lived pre-signed URL (S3) or SAS URL (Azure) for upload and download; the browser never gets storage credentials. The only client code to change is `fileBlobStore.js` / `persistPending` / `loadFileData` (replace the IndexedDB calls with upload-to-URL and fetch-from-URL). Virus scanning and the 10 MB limit then run server-side.

## Cultural module (events, programme, seva, donations, expenses)

Community → **Cultural**. Pick an event (Vinayaka Chavithi, Diwali evening, …) and use its tabs:
- **Overview** – dates, venue, description and four live figures: collected (and households contributing, pledges outstanding), target (progress bar), spent (vs budget) and balance. Everyone sees these community totals; residents never see other households' donations.
- **Programme** – the schedule. Items with "participants wanted > 0" let residents sign up (kids' fancy dress, rangoli…); a bar shows how full each is.
- **Seva (volunteers)** – volunteer duties with a number needed ("Mushika Seva"); residents sign up / withdraw themselves; the committee can add, edit and remove people.
- **Donations** – residents *Donate / pledge* (amount, towards what, UPI reference, optional "keep my name off lists"); the committee records cash/cheque/UPI received, **marks pledges Received, which issues a numbered receipt** (e.g. `DCE26-0002`, printable / save as PDF) and notifies the household. Donations, sponsorships and in-kind gifts are tracked separately; CSV export for the committee.
- **Expenses** (committee and accounting only) – item, category, paid to, amount, date, status (Pending approval → Approved → Paid) with bills attached; only Approved/Paid count as spent.

**Access** – new permission *Manage cultural events, donations & expenses* (President, General Secretary, Cultural Committee; Super Admin can grant it to any role). Money can also be handled by anyone with *Manage accounting / ledger*. Events are **Internal** until set to **Published**; publishing notifies owners/residents (App by default; WhatsApp/SMS/e-mail only for people who opted in, notification kind "Cultural events, donation receipts & volunteer calls"). Residents may only: see published events, sign themselves up/withdraw, and create / change / withdraw **their own villa's pledge** until it is confirmed — enforced in `authz.js`, not just the screen. Event totals are kept on the event row (`lib/culturalServer.js`) so residents can see them without reading other people's donations.

**Seva offerings (modelled on the Vinayaka Chavithi "Seva Offerings" portal)** – tab *Seva offerings*: live tiles (Total pledged, Devotee families, Open slots "3 + pool"), then *1 · Select an available offering* (community pools open for any amount, and fixed-value slots such as "Decoration – Day 1 · ₹30,000"), *View N already reserved offerings* (who holds each), *2 · Devotee & family details* (devotee name, villa, WhatsApp/mobile with country-code validation, family/group members, sankalpam) and a *Review your seva details* card with *Confirm & pledge reservation*. A fixed slot is taken by one family only (checked again at confirm time, and enforced in `authz.js`: nobody can take, release or re-price another villa's slot); a pool accepts any number of pledges. Each reservation creates a Pledged sponsorship in Donations (UPI instructions shown), the committee is notified and later marks it received to issue the receipt (the sankalpam is printed on it). Families can release their own unpaid reservation; committee adds / edits offerings per event and can release any unpaid one.

**Not done (ideas for later)** – online payment gateway / QR on the receipt, food-coupon or pass issuing, idol/pandal vendor comparison, year-on-year comparison of festivals, and importing the old Google-Apps-Script portal's data. The portal link you gave only exposes its title ("Mushika Seva Portal") to this tool, so its exact fields were not copied.

## Event payments, UPI QR, publishable programme (round 16)
Works for **any** cultural event (and is written so other modules can reuse it).
- **Pay by UPI QR** – `lib/payments.js` builds a standard `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…&tr=…` link; `qrcode` draws the QR offline. `components/PayPanel.jsx` shows the QR (scan with GPay/PhonePe/Paytm), an **Open UPI app** button for phones, **Copy UPI id**, and a UTR box with **I've paid**. The pledge stays *Pledged* with the UTR and `paymentClaimedAt`; the committee sees "Paid — verify UTR …", checks the bank statement and presses *Mark received* (receipt issued). Residents can never mark their own pledge Received (authz).
- **Gateway adapter** – each event has *Online payment gateway* (`None (UPI QR only)` or `Demo gateway (simulated)`). The demo gateway confirms in the browser. **It is a simulation – no money moves.** A live gateway (Razorpay/PayU/Cashfree) needs a Spring Boot endpoint that creates the order and a signed webhook that does what `payOnline()` does (set Received, issue receipt number, notify). Keys must never be in the front end.
- **Devotee details from the profile** – residents see "Pledging as <name> · <villa> · <phone>"; only a missing phone is asked. Committee members can still pledge on behalf of anyone.
- **Editable sections** – per event: offerings title/introduction, and Show/Hide of the Programme, Offerings, Volunteer seva and Donations tabs for residents (Edit event & sections).
- **Programme publishing** – programme is Draft until *Publish programme*; residents then get a notification. Draft hides items from residents (enforced in authz, not just the UI). *Share / print agenda* gives a WhatsApp-ready text.
- **Duplicate for next time** – copies the event with its offerings, programme and seva slots (a year later, Internal/Planning/Draft, no sign-ups or money).

### Event expenses now need Treasurer approval
- The cultural committee raises an expense (always *Pending approval*); the Treasurer or President (the configurable Maintenance → Final approvers, plus Super Admin) **Approves / Rejects**, then **Marks paid**. Only Approved/Paid amounts count as spent. A rejected expense can be resubmitted; a decided expense's amount, vendor and fund are locked for the committee. Enforced in authz, not just the UI.
- Each expense has **Paid from fund**. It defaults to the event's *Fund* (Cultural; the Vinayaka event uses Ganesh) and can be changed on the form while pending.
- Notifications: Treasurer/President are told of a new expense; the committee is told of the decision.
- Not yet: approved expenses do not post automatically into the Billing ledger or reduce the Fund Position balance.

## Workforce & Attendance, GPS clock-in, Community Calendar, global search (round 17)
- **Clock in / out** – staff roles (category *Staff*: Facility Manager, Helpdesk, handymen) get a clock card on the Command Center and Workforce page, plus a **⏱ Clock in / out** button in the header on every page (handymen have no Command Center). Tapping it reads the phone's GPS **once** (latitude, longitude, accuracy) – nothing is tracked in the background – and stores it on the punch. Each punch is flagged *Inside site / Outside site / Location unavailable* against the site location. Lateness is worked out from the person's planned (or usual) shift plus a grace period.
- **Workforce & Attendance** (was *Staff Shifts*) – tabs: **Attendance** (staff: own punches; supervisors/committee: *On duty now*, per-person totals, filters by period/person/late/outside/no-location, CSV of punches and of the summary, manual entry/correction with a mandatory reason, audited), **Shift planner** (unchanged), **Site & GPS rules** (site latitude/longitude/radius, *Use my current location*, and the rule: record only / require location / require location inside the site; late grace minutes).
- **Community Calendar** (new page, everyone) – **Trash pickup** and **Workers allowed** calendars: weekly, one-date or date-range rules with times, areas and notes. A one-off or range rule (festival, Diwali) overrides the weekly pattern. "Today" banner, month grid, day detail. The facility/security team (Manage field-staff duties / Manage security) edits; residents only view.
- **Global search** – 🔍 in the header, or press **/** or **Ctrl/⌘+K**: pages (by name or keyword, e.g. "trash", "clock in"), sections inside pages (*Attendance report*, *Shift planner*, *Site & GPS rules*, calendars) and records (tasks, properties, vendors, documents, events, announcements, meetings, stock, staff, users) – only what the role may open and read; a resident's own villa row-scope still applies.
- Honest limits: GPS comes from the browser, so a person can spoof it with developer tools or a mock-location app; treat it as evidence, not proof. Accuracy indoors can be 20–100 m. The demo site coordinates are placeholders – set the real ones under Site & GPS rules. No photo/face verification, no break tracking, and punches are not yet linked to payroll.

## Round 18: one approval list, consistent headers, holidays & publishing, back arrow, print
- **One approval process** – *Approvals* page (EC / Super Admin) and a "Waiting for approval" card on the Command Center list task quotations, vendor invoices and cultural-event expenses together, with who they wait on (EC step or final approvers from *Maintenance → Final approvers*, the same setting the Cultural expenses use). Cultural expenses are approved/rejected right in the list; tasks and invoices open the task (their approval has side effects – ledger entry, closing – so it stays where the task lives). Cultural expenses are a single *final approval* step (Treasurer/President); they do not go through the EC step.
- **Same look everywhere** – Cultural, Workforce and Calendar use the underlined tab rows of Billing & Finance (event → section as header / sub-header).
- **Community Calendar** – the month grid is gone: a *Coming up* list (7–60 days) per calendar, rule tables, and a **Holidays** tab. A holiday can cancel or move trash pickup and block or limit workers; **Add a list** pastes many holidays at once (`2026-12-25, Christmas` or `25/12/2026 - Christmas`). **Publish…** sends the schedule/holidays to Residents / Staff / Committee through the central notifier (in-app always; WhatsApp/SMS/E-mail only for people who opted in and where *Community calendar* allows them – queued, not delivered, in this demo).
- **One page title** – the header bar carries the page name; the title inside the page is gone (and the description is hidden on phones). A **←** back arrow appears in the header after you move between pages (menu, search, a card, a link) and returns to the previous page.
- **Print** – 🖨 in the header prints the current page (print stylesheet hides the menu and buttons); every data grid also gets its own **🖨 Print** button that prints just that list with a title and date (action columns are left out).
- **Command Center** – kept to the highly used summaries: the four tiles, the Maintenance summary and Waiting for approval (the collection chart, fund donut, workforce and bookings widgets were removed).

## Round 19 - grouped navigation
- The menu is five categories instead of ~19 pages: Home (Command Center, Approvals, Calendar), Facility & Maintenance (Maintenance, Workforce, Assets, Utilities, Vendors, Security), Residents & Money (Properties, Billing, Amenities), Community (Cultural, Communications, Governance, Documents), Administration. Notifications is reached from the bell.
- Desktop: collapsible groups, only the one holding the current page is open. Phone: the bottom bar has one button per category (max 5); tapping opens a sheet of its pages. A category with one visible page goes straight to it. Role visibility rules are unchanged, so FM/MEP/committee simply see fewer categories.
- Automated browsers see all groups expanded (navigator.webdriver) unless sessionStorage `communityos:navCollapsed` is set.

## Round 20
- Sidebar: flat labelled sections again (Overview / Operations / Community / Administration). Properties & Residents is now **Unit Directory** (Community); Community Calendar moved to Community; "Assets & utilities" is **Infrastructure**. The Approvals page and the dashboard approvals card are gone - approvals live in Maintenance (task → Money) and Cultural (event → Expenses). Header search and print buttons, and the auto "Print" button on tables, were removed (components/GlobalSearch.jsx, TablePrint.jsx remain in the code for re-use).
- Command Center: the six maintenance-summary cards sit in one compact row.
- Cultural: events are grouped by year (year chips). Expenses: EC approves first, then the Treasurer / President unless the amount is within the event's "Treasurer approval needed for expenses over" limit. The raiser cannot approve their own expense at the EC step.
- Notifications: new "Approval needed from me" event. Task quotations and vendor invoices now tell the EC, then the final approvers, exactly when it is their turn; decisions notify the people doing the work. Ticket Overview shows a "Next step" banner.
- Maintenance chat: pictures / PDFs / Word files can be attached (files from Internal notes are hidden from residents).
- Utilities: new "Bill templates" tab (utility bill templates + merge-field library). Communications keeps "Announcement templates".
- Amenities: Book an amenity is first; calendar cells fit phones; Unit is a searchable combobox; staff can book for an **association** and waive the fee/GST/deposit with a reason (free booking, nothing posted to the ledger, waived value reported). Reports now subtract deposits handed back and show waived value.


## Round 21 - refunds & deposits, Calendar services, community requests, Studio on phones

- **Cancelling an amenity booking shows the refund process.** The cancel panel now has a *Where should the refund go?* choice (**Unit account credit** - instant - or **Original payment mode** - the office pays it out; the community setting is only the default) and a 3-step preview. A cancelled booking shows a **refund tracker** (cancelled -> refund approved -> credited / paid, with date, mode and reference). If it was paid (even partly) from unit credit the refund always goes back to the unit account. Staff pay a "Refund due" out with *Paid by* (Cash / Cheque / UPI / Bank transfer) + a reference (required for cheque / UPI / bank), or convert it to unit credit; it is posted to Payments Cross-check as a debit with mode + reference and the villa is notified.
- **Unit credit at the next booking, in full or in part.** A banner on the booking page tells residents about their credit; ticking *Use unit credit* shows "Paid from unit credit - X / Still to pay (UPI) Y". The credit is taken (reserved) when the booking is made; if an unpaid cash / cheque reservation is released automatically, the credit is given back. Ledger: full fee + deposit income plus a non-cash offset for the credit part.
- **Settling the security deposit has a payment process.** Inspection **photos** (camera / gallery; stored as files owned by the booking, visible to the villa), a **rich-text reason** (RichTextEditor / RichText), the deduction, and *Return the balance by* (Unit credit - at once - or Cash / Cheque / UPI / Bank transfer -> "Due", then *Mark deposit refund paid* with reference). A deduction needs a reason **and** at least one photo. The booking shows a deposit tracker.
- **Renames:** *Community Calendar* -> **Calendar**, *Workforce & Attendance* -> **Workforce**.
- **Calendar services.** New `siteServices` collection. Trash pickup, Workers allowed and a demo *Water tanker* are services; the facility / security team (and Super Admin) add more under *Calendar -> Services* (name, icon, behaviour **Collection** = happens on days / **Access** = allowed window, usual timings, usual days, area, notes, shown/hidden). Each service gets a tab, a "today" card, its own entries and is part of *Publish*. **A holiday now stores an effect per service** (`effects`: As usual / No service / Rescheduled for Collection, As usual / Not available / Limited hours for Access), so Diwali can cancel trash pickup but let the water tanker run. The old `trash` / `workers` fields are still written for trash and workers. The service name is fixed once created.
- **No-code Studio on a phone:** the page / tab strip is now a dropdown (69 sections), and field / role tables stack as cards under 720 px - no sideways scrolling.
- **Community-level requests.** Residents get **+ Community request** next to *Raise Maintenance Request*: category, *where in the community* (required), description, photos. The ticket has `scope: Community`, `location`, `affectedUnits`. Every resident sees community requests (filter: All / My villa / Community) and can press **Me too** (adds / removes only their own villa; the guard rejects any other change). The team sees "N villas affected"; Facility Manager, MEP and Helpdesk are notified on creation and when more villas are added. The raiser's villa stays on the ticket as `unit`.

## Round 22 - phone pass over every screen
- Global phone layout (<= 700 px): tighter page padding, compact title/buttons (two per row), smaller card/field gaps, 36-40 px tap targets, section tabs wrap instead of scrolling, Mine/All + Financial on one row, Calendar "today" as one line per service, Shift planner opens on Day.
- **Every table becomes compact cards on a phone** (first column = title, other columns two per row, empty cells hidden). `useResponsiveTables()` in App.jsx copies each table's header text into `data-label` on its cells, so existing and future tables need no per-table work. Opt out with `data-keep` (the weekly shift planner grid).
- Audited all pages for President, Treasurer, Facility Manager, Owner and Super Admin at 390 px: no page-level horizontal overflow.

## Round 23 - clock-in gate, rich text, refunds, recurring events

- **Clock-in gate (staff, Facility Manager, MEP, helpdesk, handymen):** the portal opens only after clocking in (`components/DutyGate.jsx`). Switch off under Workforce → Site & rules ("Staff must clock in"). While on duty a slim bar shows the time on duty with a one-tap **Clock out**; switching account while clocked in asks first.
- **Forgotten clock-out:** after the shift end (or 8 h with no fixed shift) the bar turns amber and an in-app reminder is sent every 30 minutes; after `maxShiftHours` (default 12, editable) the session is closed automatically, flagged **Auto** with a note for the supervisor (`lib/attendance.js` → `runDutyWatch`, run every minute from the shell). With the Spring Boot backend this becomes a scheduled job + FCM push.
- **Phone navigation:** bottom bar = Home + the three pages the person opens most (role defaults until there is history, stored per role in localStorage) + **More** (all pages grouped). Frequent pages are one tap.
- **Rich text:** pasted URLs and copied links stay clickable; images can be added inline (🖼 button, paste or drop; shrunk to 900 px). The separate 📎 beside Post is gone.
- **Quotations / invoices:** every quotation has Select/Unselect and several can be selected; unselecting restarts approval. An invoice can be unselected at any time (its approval restarts) unless it is already in the Payments Cross-check.
- **Refunds:** **Initiate refund to the original payment mode** (UPI / card / net banking) from the booking, for booking refunds and deposit refunds; the simulated gateway returns a `GW…` reference and the ledger debit is posted. Cash/cheque stay manual. Settle deposit now shows the refund method as chips and a step preview.
- **Amenity Payments → worklists + History:** refunds to pay out, deposit refunds to pay, deposits to settle, and a permanent **History** of every refund, returned deposit and deduction (kept for audit).
- **Cultural:** events can repeat (weekly / every 2 weeks / monthly) with start and end time; the event shows "🔁 Every Saturday at 07:00" and the next dates. Expense category is a combo box that learns new categories as they are used (`lookup.distinct` + `defaults`).
- **Utilities:** each utility can define extra reading inputs (Utilities → Manage → Inputs, e.g. Hours run, Diesel filled); stored in `reading.extras`.
- **Look and feel:** text, select, date and time inputs share one style; date fields no longer push the page sideways; a tiny record-count line sits above every list; page descriptions show on phones; the six Maintenance summary cards are 3 × 2 with labels of at most two lines; Studio's page/tab picker is a combo box; the screen scrolls to the top after a booking.

## Round 24 - Unified payment engine, audits, service directory

**Payments & bank (Billing tab)** - one engine (`lib/paymentEngine.js`) for every payment.
- *Pay*: ready-to-pay items (approved cultural expenses etc.) plus "New payment". Each payment is linked to an area (Maintenance, Cultural, Utilities, Amenities, ...) and a source record, and is drawn from the bank account set in *Routing* (editable per area; Cultural uses the event's fund when a bank account of that name exists). Bank transfer, UPI and Cheque require a UTR/cheque number. Payments are idempotent per source record.
- *Reconcile with bank*: per account, shows app entries not on the statement and statement lines not in the app. "Find matches" suggests by UTR in the narration first, then same amount within 5 days; confirm one by one or all, and undo is possible.
- *Analysis*: spend by area/account/month.
- Maintenance tickets, utility bills and amenity bookings now stamp `module`, `sourceType`, `reconStatus` on their ledger rows. Older rows are classified on the fly by `areaOf()`.

**Audits** (Operations) - STP, WTP, swimming pool, fire etc. Per audit: date, auditor, result, score, measured parameters with min/max (out-of-range in red), findings, actions, report files, next-due from frequency, Internal or Published visibility. History per area with score chart and parameter trends.

**Service directory** (Community) - residents add technicians, drivers, cooks, etc.; star rating + comment (one review per resident, editable), "would use again" %, call/WhatsApp links, duplicate-phone check; moderators (EC / forum moderators) can hide or delete.

Caveats: only cultural expenses are flipped to Paid by the engine; maintenance/amenity flows are stamped but keep their own status flow. Gateway payments are simulated. Statement-only list shows the newest 60 lines.

## Round 25 - One Payments tab, GST check, directory list, audits and notices

- **Billing -> Payments** is now the single place for money movement (the separate "Payments cross-check" and "Payments & bank" tabs are gone). Sub-tabs: *Payments* (waiting-to-pay lists + the full list of entries), *Bank matching*, *Analysis*, *Account routing*.
- **Linked record on every entry**: opening a payment shows the task and invoice (with approval state), cultural expense and event, DG refill or booking it paid, and a button to open the task. Entries not linked to anything say so. Maintenance invoices that are approved and unpaid can be picked in the Pay dialog.
- **GST check** (`gstCheck` in `lib/paymentEngine.js`, used in the Pay dialog, the invoice upload form and the payment detail): splits taxable value and GST for "included" or "on top", and comments on whether the rate makes sense: current slabs 0/5/18/40 (12% and 28% were removed on 22 Sep 2025, only valid on older invoices), no GST expected on diesel, electricity, taxes, salaries, refunds; services normally 18%; vendor GSTIN missing or malformed; invoice GST not matching its rate. The rules are a guide, not tax advice. Vendors have a new optional GSTIN field.
- **Invoice approval decided at the quotation step**: on a task with an approved quotation, "Invoice approval" can be set to *Not needed when the invoice is within the approved quotation*. Such an invoice is stored pre-approved (and cannot be changed afterwards); anything above the approved amount still goes through EC and final approval.
- **Service directory**: table instead of cards (stacked rows on phones, showing what they do, where, about, charges, rating), compact edit form, rich-text reviews with photos, search also looks inside reviews.
- **Audits**: the auditor is a Vendor in the new category "Audit / inspection agency"; typing a new name creates the vendor, and the audit keeps the link.
- **Announcements**: new type *Scheduled maintenance* with date, from/until time and what is affected; an *Upcoming maintenance* card sits above recent broadcasts for everyone; the committee can reschedule (residents are notified of the change). No automatic re-broadcast: the upcoming card stays visible until the day passes, and the existing reminder setting covers nudges.

## Round 26 - Cultural budget vs actual

- **Data from the 2025 and 2026 spreadsheets** (`lib/seed/culturalHistory.js`): 24 events with their estimate (budget) and actual spend, as Internal events (residents do not see them). Where an event sheet total and the summary disagreed, the sheet total was used. Events dated after today carry only the estimate: the 2026 summary repeated last year's expense for Bathukamma, Dussara, Diwali, Children's Day and Christmas, so those were not taken as actuals.
- **Cultural -> Budget vs actual** (finance users): year chips, tiles (estimate, actual, under/over, unused), a summary by year, estimate-vs-actual bars per event, a year-on-year chart for events held in both years, and the event table. Actual = the old-record figure (`historicalActual`) when present, otherwise the approved/paid expenses.
- **Credit the unused estimate**: for a completed event whose actual is below its estimate, the Treasurer / final approvers get "Credit ₹X to fund" (also on the event overview). It stores amount, who, when and a note on the event, can be done in part, and cannot exceed what was unused. No bank entry is created because the money never left the account.
- Expenses have a new optional **Estimate** field next to the actual amount, and events have **Size** and **Same event each year** fields.

## Round 27 — Plant Logs (was "Infrastructure")
- The **Infrastructure** page is now **Plant Logs** (name lives in `App.jsx` and `lib/access/tabs.js`; one-line change if you prefer another).
- New tab **Water & sewage plants**: one `plantLogs` record per day with Bhagiratha, WTP and STP meter readings (KL worked out; Bhagiratha dial ×10), salt and chlorine stock/use. Opening readings are pre-filled from the previous closing; closing < opening and use > stock are refused. Month chips, totals, daily line chart, salt/chlorine days-left (red at 7 days or less), restock detection from stock jumps, flags for outlier days, reading gaps and missing days.
- **Import Excel** reads sheets named bhagiratha / wtp / stp / salt (new dates are added in one batch, existing dates merged). The September 2026 workbook is seeded.
- New tab **Monthly summary**: per month, plant KL, STP % of WTP, salt, chlorine, diesel litres/₹ (DG fuel log), DG billed to villas (Billing & Finance, category DG), electricity units/₹ (EB bills); click a month for the bills and refills behind it.
- DG fuel log (any date) and EB bills (monthly) stay as tabs and feed the summary.
- Files: `lib/plantLogs.js`, `modules/assets/PlantLogs.jsx`, `lib/seed/plantLogs.json`; test `t69`.

## Round 28 — mobile-first pickers and ten years of data
- **Cultural:** year and event are now two dropdowns on one right-aligned row (no sideways-scrolling event strip). Test ids: `year-select`, `event-select`.
- **Budget vs actual:** sections are tabs — *Events* (table with credit buttons), *Charts*, *By year* — under the always-visible tiles; the year is a dropdown.
- **Plant Logs:** Year + Month dropdowns with prev/next arrows (year dropdown appears when there is more than one year). Phones get one card per day (three KL boxes + salt/chlorine line) instead of a wide table; the monthly summary shows one year at a time with year-total tiles and month cards on phones. The checks scan data in one pass, tested with 10 years (3,500+ daily rows).
- **All date-range filters** (`ServerTable`, e.g. DG fuel log, payments, meetings): when the data spans several years the From/To boxes are replaced by Year and Month dropdowns, with "Custom dates…" kept as an option.
- Tests: `t70` (10-year data, phone layouts); old tests use `shim.mjs` to drive the new dropdowns.

## Round 29 — approvals decided by the EC, payments queue by section
- **EC multi-action button** (`components/ActionMenu.jsx`) on every quotation, invoice and cultural expense: *Approve & send to final approver* · *Approve — this is the last step* · *Reject*. The choice is stored as `finalRequired` (true/false) on the ticket, invoice or expense; `false` means no Treasurer step and the item is fully approved (`ticketEngine.invoiceApproval` / `approvalState`, cultural expense guard). Final approvers keep simple Approve / Reject.
- **Bottom approval bar removed** from the task dialog; approval happens on each document. The "Record in Payments Cross-check" buttons were removed from tasks (`LedgerLink` is now read only).
- **Payments → sections:** Cultural (To pay · In approval · Paid · Budget credits), Maintenance (financial tasks and invoices: To pay · Paid · Skipped · In approval, with Pay… / Skip), Amenities, All payments. Fully approved items show up there for the Treasurer, like cultural expenses always did.
- **Prior-payment warning** in the Pay dialog: lists payments already recorded for the same record (or other payments on the same task) and, for a repeat payment, needs the "Record another payment anyway" tick (`recordPayment({ allowDuplicate })`).
- **Budget credits** now leave an internal ledger record (`sourceType: culturalCredit`, `internal: true`, `reconStatus: Not applicable`), visible in Payments and excluded from bank matching and spend analysis. A CUSTOM ledger guard lets final approvers write that one record type.
- **Cultural expenses table:** search (item / category / paid to), sortable headers plus a sort dropdown for phones, a 📎 indicator instead of the bills list, one short status chip (details on hover), and a one-button EC decision.
- Tests: `t71`; older tests updated for the new buttons.

## Round 30

- **Payments → Cultural** lists approved cultural expenses like maintenance tasks (To pay / In approval / Paid / **Skipped** / Budget credits) with Pay and Skip (reason kept, can be restored).
- **Make a payment** has an optional **Sub-category** (from Category Coverage) and **Attachments** (stored against the ledger entry).
- **Payments → Utilities** section: DG diesel refills and electricity bills to pay or skip; **Collections** shows what residents paid for Water / DG month by month, opening to every villa's bill with its own bill number (`DUE-xxxx`). Utility collections stay one summarised ledger line per utility and month (212 villas would otherwise add ~5,000 lines a year); every bill has a unique id and the ledger line links to the month.
- **Utility billing** moved from Billing & Finance to **Utilities** with the same access (accounting roles, EC, Facility Manager) and the same per-role tab switch (`billing.utility`). The Utilities page now opens for those roles.
- **Bookings** are a table (Amenity, date, slot, villa, status, amount, payment) split **Financial / Free / All**, with Year + Month + Amenity dropdowns, search, sortable columns and lazy paging. Financial bookings post to Payments automatically, linked by `amenity:<id>` and the booking number; the payment detail has an "Open booking" button.
- **Audits → Timeline**: ten years at a glance (rows = areas, columns = years, or months of a chosen year, coloured by the worst result). The area history has a year filter, a score line chart that handles hundreds of audits, and paging; All audits has Year / Month / Result filters.
- **Clock in / out** is one button in the top bar (shows the duty state). The cards on the dashboard and Workforce page and the duty-bar button were removed.
- **Plant Logs** has three groups (Water & sewage, Power, Stores & assets) with sub-tabs, so no tab strip scrolls sideways. A Super Admin (or `MANAGE_UTILITY_TYPES`) can add **Other logs**: name, how often, and fields (number / text / yes-no / choice / date); each gets its own page with entries, year/month filters and photos.
- **Invoice approval** setting moved next to the Invoices panel and reworded ("When an invoice matches the approved quotation").
- **Audit trail** now also records sign-in / sign-out, notification settings, online payments, auto clock-outs, portal activations, community status and cascaded deletes, and has a **Coverage** tab listing every section with its entry count.
- **Cultural**: events and every record under them (programme, seva, offerings, donations, expenses) show their unique id; year + event pickers sit left and **Contribute by UPI** sits right on the same row.
- **Page tabs** that a Super Admin can switch off per role now also cover Payments (tabs and sections), Utilities, Audits, Cultural, Workforce and the Audit Trail.
- **Water / DG meter photo** is required to save a reading (publishing already required it).

## Round 31
- **On duty now** chips show the role: `Name (Role) · since 09:12`.
- **Switching a page off hides all its tabs** (`tabOpen` checks `role.hiddenPages` via `tabPage(id)`); the role editor greys out and disables the tabs of a switched-off page.
- **Every paid bill is its own Payments transaction** (water, DG, any utility, maintenance, other): `syncDuePayment` (lib/utilityLedger.js) upserts a ledger credit `sourceId = due:<id>` with `billNo`; marking the bill unpaid removes it.
- **Payments → Collections** (new, replaces the Amenities section): Year (default latest) and Month filters, totals by head (Utilities / Amenities / Maintenance) and item, searchable transactions with bill / booking numbers.
- **Bill details flip to Paid at once** (SectionPage re-reads the live record); **Paid = green, Unpaid / Overdue = red** everywhere via `StatusTag` / `statusify`.
- **Maintenance fee**: Billing & Finance → Dues → *Publish maintenance fee* (month / quarter / year, flat fee with optional Villa / Apartment overrides, due date). One bill per unit (skips units already billed for the period). Wording is the **Maintenance fee** notice template (editable in the dialog and in Communications → Notice templates).
- **Payment reminders for all dues**: Dues → *Payment reminders* — on/off, repeat every N days, start N days before due, stop after N reminders, *Send now*. Stored in Finance settings; wording is the **Payment reminder** template; the 5-minute scheduler (`runDueReminders`) and Utility billing's reminder button use the same engine. Channel opt-ins follow the new `payment_reminder` event in notification settings.

## Round 32
- **DG and Maintenance bills like the Water bill:** every bill opens with the same layout — payment block, then a breakdown (DG / water: meter readings × rate + fixed + tax; maintenance: period, plan, instalment, yearly fee) and the notice sent to the owner. Seed DG / water bills carry meter details.
- **One control size and look** (styles.css "Round 32" block): `--ctl-h` 34 px (40 px on phones) for buttons, inputs, dropdowns, date fields and tabs; filter dropdowns are capped at 170 px and sit side by side on phones (three per row) instead of stretching full width.
- **New payment** names the link by area — *Linked maintenance task* / *Linked cultural expense* — and shows a summary card of what is linked (number, vendor, unit, approved amount, status).
- **Payments → Utility bills tab removed.** DG diesel and electricity bills that still need paying now sit under Payments → Maintenance (below the task invoices). Resident payments of water / DG / maintenance bills are in Collections.
- **Quarterly maintenance:** *Publish maintenance fee* now defaults to a yearly fee (`FY 2026-27`). Units whose *Maintenance fee paid* setting (Properties) is **Quarterly** get four instalments (`… · Q1`–`Q4`, three months apart, last one carries the rounding); others get one yearly bill. An unpaid yearly bill can be switched with **Pay quarterly instead** in the bill details (`splitIntoInstalments`; the first instalment keeps the original bill number).
- **Warranty:** *Warranty until*, *Warranty by* and *Warranty terms* on Inventory and on Equipment & Assets; the stock-from-invoice flow takes warranty months per line and sets *Warranty until* from the invoice date and the supplier.
- **Inventory → Add stock from invoice:** document zoom (− / + / Fit, full-screen view, pinch / scroll), item and category as large labelled fields on item cards, a Document | Items switch on phones, 16 px inputs, no sideways scrolling.
- **Amenities notification / report templates:** labelled Subject and Message fields; e-mail messages use the rich-text editor (the outbox keeps the plain text and the formatted version); WhatsApp / SMS stay plain text; cards fill the available width.
- **Call = phone icon** (`.call-btn`, with an accessible "Call <name>" label) in the service directory, unit directory and task lists.
- **Audits → By area** has filters like the timeline: search, year, month, result and due state (period filters show each area's latest audit inside the period).
- **Global search** is now in the header (it existed but was not mounted): press `/` or Ctrl+K, or tap 🔍. It finds pages, ~30 sections / tabs (e.g. "quarterly" → Publish maintenance fee, "collected" → Payments → Collections, "warranty", "template") and records (bills, equipment, bookings, tasks, units…) and opens the right tab (`lib/openHint.js`).
- Tests: `t75`; `t73`, `t52`, `t71`… updated for the new layout.

## Round 33 — Association utilities in Payments
- **Payments → Association utilities** (new tab, `pay.s.assoc`, switchable per role): the bills the association itself pays — electricity for common area / clubhouse / STP / WTP / street lights (from Plant Logs → Electricity bills), water (municipal, tanker, borewell), DG diesel, and anything else (gas, internet, waste) added with **+ Add bill** (new `assocBills` collection, ids `ABL-0001`…, same access as the electricity register, plus anyone with MANAGE_LEDGER).
- To pay · Paid · Skipped, filters by utility and by location, a summary strip per utility (due / paid), due-date and overdue tags. **Pay** opens the payment dialog already linked to the bill; the ledger debit carries `sourceId assoc:<id>` / `elec:<id>` / `dgfuel:<id>` and area *Utilities*. A bill can also be marked paid outside the portal with *Paid on*.
- Residents' own water / DG / maintenance bills stay under **Collections** (income); association bills are outgo and never appear there.
- Global search finds the tab ("street lights", "water", "electricity bill").
- Test: `t76`.

## Round 34 — Association bills moved to Utilities
- **Utilities → Association bills** (new tab, `util.assoc` switch): add/edit bills (water, gas, internet, waste, DG fuel, electricity from readings) with search, utility, location, year, month and status filters, plus "Pay these in Payments →".
- **Payments → Utilities (Association)**: a pay queue like Maintenance/Cultural (To pay / Paid / Skipped); "Manage bills in Utilities →" links back. No add button here any more.
- **New Payment** with Paid for = Utilities shows "Linked association bill" (bill no. + summary); the debit is stored as `assoc:<id>`.
- Electricity bills (clubhouse, common area, STP, WTP, street lights) are added/edited from Utilities → Association bills too (⚡ Add electricity bill); other types use + Add other bill.
- Association bills list defaults to Last 12 months (Year filter: Last 12 months / All years / each year; month narrows further). Electricity bills are selectable in New Payment (Utilities) with their bill no.
- Payments → Cultural / Maintenance / Utilities (Association): Paid and Skipped lists show the last 6 months with a Show all link. Utilities (Association): tabs aligned right like the other sections; rows show details per tab (due for To pay; how/when/ref for Paid; reason/date/by for Skipped).

## Round 36 — profile security, compact dashboard, phone polish
- **My profile**: name, phone, role, villa and e-mail are read-only for everyone except the Super Admin (they sign the polls, votes and audit trail). `updateProfile` ignores anything but name/phone and refuses non-admins; the data layer already limits user, property-owner, role, ledger and schema writes to admin/staff.
- **Billing dashboard**: one row of compact tiles (fund balance spans two), cash flow + bank accounts side by side, three forecast/spend cards across, dues + approvals below; page is roughly half the height. On phones the lists show the top 5 rows with "Show all n".
- **Phones**: tab bars are one swipeable row (no wrapping), tighter page/card/list padding. Audited every page and tab at 390 px as Super Admin and as an owner: nothing clipped or sideways-scrolling except the Payments section switcher, which is a swipeable tab row.

## Round 37 — inventory Excel import, profile details, dues filter
- **Maintenance**: "+ Community request" and its "Community" filter removed (residents keep "Maintenance Request").
- **Dues**: the due-date filter is now Year + Month dropdowns (custom dates still available); the same control is shared by every list with a date filter.
- **My profile**: name, phone, e-mail, role and villa are locked (🔒, Super Admin managed); everyone edits their own alternate phone, emergency contact, vehicle numbers and preferred language (`userProfiles`, UPR-xxxx; own record only).
- **Inventory → Import from Excel** (EC, Facility Manager, MEP): choose .xlsx/.xls/.csv → columns are matched by header (synonyms; header row guessed; match remembered per header set) → each line is tagged with a category by the **mapping rules** (words in the description, or the file's own category column; higher priority wins, then the longer keyword) → review/edit/untick, bulk-set unmatched, choose what to do with items already in stock (set / add / leave) → import. Units are normalised (pcs/no./each → Nos, ltr → Litres …). Corrected categories can be remembered as new rules. "Download template" gives a sample file.
- **Inventory → Mapping rules** (`inventoryRules`, IRL-xxxx): add/edit/switch off rules, priority, default unit / store, "Try it" box that shows which rule a description would match. Ten standard rules are seeded; "Restore standard rules" re-adds any missing.

## Round 38 — configurable for any community, built for township scale
- **Community setup** (new page, Administration): **Blocks & units** (add blocks/towers/phases, add a numbered range of units in bulk, **Import units from Excel** — headings recognised, problems listed per row, existing units updated, missing blocks created), **Facilities & locations** (Clubhouse A/B, Pool 1/2, STP, gates …) and **Money & financial year** (currency symbol, number grouping, large-amount unit, financial-year start month, property types). Only the Super Admin sees the money tab.
- Property **type** and **block** are now pick-or-type lists (not fixed Villa/Apartment, not free text). Announcements gain **Selected blocks**; villa/apartment/block audiences are expanded to exact units when sent.
- **Facilities are used everywhere a place is chosen**: electricity bill supply, association bill location, inventory "kept at", equipment "where". Amenities have **Located at**; the booking page shows a **Where** filter when there are several places.
- **Block-limited staff**: Users → a non-resident user → "Limited to blocks". They see and change only units of those blocks (read scope + write guard).
- **Financial year** and **currency/number format** follow the community (April–March is just the default).
- **Scale**: batch writes (`putMany`, `createMany`, `updateMany`, `notifyMany`) for bill runs, reminders, announcements and imports; the page-blocking reminder sweep fixed (26 s → 1.6 s at 2,000 units); big collections spill to memory/IndexedDB when the 5 MB browser store is full; unit pickers draw a screenful at a time.
- **Platform console → New community → Load large test data**: 5 blocks × 400 units, a year of dues, tickets, bookings, several clubhouses and pools.
- `docs/SCALE-AND-CONFIGURATION.md`: what is configuration, what is still La Paloma-specific, measured timings, and the API/index contract for Spring Boot + PostgreSQL.
- Tests: `t86`/`t90` (township scale), `t92` (setup, facilities, money/FY), `t93` (Excel unit import).

## Round 39 — Billing & finance completeness
- **Per-unit charge rules**: maintenance and levies can be *flat*, *per sq ft* or *per bedroom*, with a different rate per property type or per block.
- **Late fees** (fixed or % per month, grace days, stop-after, optional automatic), **special levies** (purpose, fund, collection tracking), **credit notes** (different amount per villa; adjust against the next bill or refund), **advances/overpayments**, and **payment plans** on any unpaid bill.
- **Defaulters** tab: ageing buckets, reminder / demand / final notices (kept as records, printable), waive late fees, and an optional **stop amenity booking for defaulters** rule.
- **Funds** have a kind (Operating / Sinking / Corpus / Restricted); payments, income and levies can be tagged to a fund.
- **TDS** on payments + TDS report and deposit; **period lock** (close the books); **second approver** above a limit; **recurring bills**; **other income** (parking, hall, tower…); **cash book** with cash counts; **tenant billing** (Bills go to Owner/Tenant).
- **Reports** tab: income & expenditure, fund statement, levy collection, unit statement, TDS, cash book — print and CSV.
- Details, backend contract and limits (no gateway yet, cash-basis not double-entry): `docs/FINANCE.md`. Tests: `t95`, `t96`.

## Round 40 — Approval rules, staged releases & advances
* **Approval rules** (Maintenance → Final approvers): each community writes rules — kind of approval, amount range, category, task type, situation — that give ordered steps. **Every matching rule applies**; identical approver sets are merged. A **Test it** box shows the chain for any amount. Settings: different people must approve, EC may change one task, invoice tolerance %.
* **Per-task override** with a mandatory reason, kept on the record.
* **Releases & advances** on a task: an advance before the invoice only when the EC has pre-approved it (ceiling + reason); stage payments against an approved quotation; each release has its own approvals; paid releases are credited to the invoice that follows; the task will not auto-close while advances are not covered.
* Maintenance quotations, invoices, releases and cultural expenses all run through the engine; the Approvals page shows custom approvers' work too.
* See `docs/APPROVALS.md` (design, backend contract, limits).


## Round 41 — One release action
* **Ask for a release** is now the only money-out action on a task: the requester or EC asks at any stage (no quotation or invoice needed, no advance pre-approval, no Advance/Stage choice). Amount is prefilled from the approved invoice, else the approved quotation, and capped by it once approved. Approvers and Payments work as before; paid releases are still credited against invoices. The 'Allow an advance' button and its ceiling are gone (old values are ignored).

### Round 41b — Release form, permissions, reconciliation
* **Release form:** *Pay to* searches vendors and people (or accepts a typed name); *Note* spans the full width. *Amount to approve* is removed from the task.
* **Super Admin only** sees *Change the approvals for this task* (setting: Maintenance → Final approvers → Settings).
* **Financial checkbox:** new permission `SET_FINANCIAL_FLAG` (default: Executive Committee group + Super Admin; assignable per role in Roles & Permissions). Locked once a payment exists on the task.
* **Treasurer who is also an EC member:** setting *finalCanDecideEC* (default on). Off = final approvers cannot give the EC decision, only the final one.
* **Requester cannot close while money is owed** (`lib/approval/position.js`): approved invoice (else quotation, else releases) minus payments in the ledger. A role that cannot see the ledger is blocked as well and is told to ask the Treasurer / EC. EC and Super Admin can still close.
* **Payments → Reconciliation:** one screen: paid above approved, closed with money owed, released money not covered by an invoice, approved releases not paid, payments linked to no task, payments with no bank line.
* Phone: the EC decision menu opens inline, left aligned, full width.
* Limits: the close rule, the financial-checkbox permission and the Treasurer-as-EC rule are enforced in the browser layer (the last two also in `authz.js`); the close-while-owed check needs the ledger, so the Spring Boot backend must repeat it.

### Round 41c — Releases on cultural expenses
* Every cultural expense row has **Release…** (Releases (n) once there are some): the same single *Ask for a release* as maintenance, prefilled with what is left of the expense and capped by the expense amount. Asked by the EC or cultural managers.
* Approval: new rule subject **Cultural release** (seeded: EC only; edit under Maintenance → Final approvers → Approval rules).
* Payments → Cultural: approved releases wait in *To pay* (**Pay** records the ledger row `culrel:<id>`, area Cultural). The expense itself shows only its **balance**; when paid releases cover the whole amount the expense becomes Paid and the event totals refresh (`markReleasePaid` in `lib/finance/rules.js`). Releases also appear in the approvals inbox and in Reconciliation.
* Limits: releases are not yet offered on other expense kinds (utility bills, amenity refunds). A cultural expense is marked Paid by its releases even if its own approval step is still pending (each release has been approved by the EC).

## Round 42

- **Bell / profile menu** close on an outside click (or Esc). Notifications are marked read once you have seen them (closing the panel, or leaving the Inbox).
- **Chips and option pickers** (ballot options, filters, year chips): selected = light blue, and the ✕ is always visible. One global rule in `styles.css`.
- **Mobile tabs** (Billing top tabs, Reports sub-tabs, any `.tabs` / SegTabs) scroll sideways with an edge fade instead of being cut off.
- **Needs attention** (was "Waiting for you"): only open tasks *you created* that need you (finished and waiting to be closed, rejected, overdue, on hold, unassigned). Approvals and payments live in Approvals / Payments.
- **Plant Logs → Plant & Assets** (water & sewage plants, DG fuel, electricity, equipment).
- **Documents** are now a card grid (file-type tile, category, version, lock/group, expiry, View button); folders are a clean list on desktop and a scrolling strip on phones. `ServerTable` got a `cardsAlways` prop.
- **Notifications** (`src/lib/notifyExtra.js`, called from `secureStorage` after each write): new forum topic, new poll, reply to my post/topic, ballot closed (result ready), ballot closing within 2 days (only villas that have not voted), new message in a task chat, new resident request (to Facility Manager / Helpdesk), release approval needed (maintenance and cultural), release approved/rejected/ready to pay/paid. Each has an EVENT so it is configurable per channel in Notifications → Channel settings and per person (WhatsApp / SMS / e-mail).
- **Deep links**: `#/forum/<id>`, `#/ballot/<id>`, `#/ticket/<no>/chat`, plus the existing ticket/section links. Tapping a notification (or the phone push banner) opens that topic, the E-voting tab, or the task's Chat tab. Opening a pasted link after sign-in works too.

## Round 43

- **Utilities and Plant & Assets are now one page, "Utilities & Assets"** (`src/modules/utilities/UtilitiesPlant.jsx`), with four sections: 💧 Meter readings & billing, 🧾 Association bills, ⚙ Plant & operations (water & sewage plants, monthly summary, DG fuel, electricity bills, villa electricity, other logs), 🧰 Inventory & Assets (inventory, equipment register). On phones the sections are a 2×2 grid.
- Access is unchanged: each section uses the same visibility, page-hiding and per-tab switches as the old page it came from (roles editor labels: "Utilities & Assets: meters & bills" and "… plant & inventory"). A role sees only the sections it may open.
- Old links keep working (`assets` page ids, inventory links, search hints map to the right section).

## Round 44

- **Nothing closes a task by itself any more.** Removed the auto-close when all invoices are approved and the "Approve & close" on EC-only tasks (now just "Approve"). The requester closes (EC / Treasurer / Super Admin can too).
- **"Mark work done" button removed** from the Money tab.
- **Make payment**: the "other payments exist for this task / record" warning now sits directly above the buttons; its checkbox must be ticked before "Record payment" is enabled.
- **Payments → task** (task list, ledger detail, reconciliation) opens the task on its **Money** tab.
- **Image attachments show as thumbnails** (shared `Attachments` component: stored files and files picked before saving), click to enlarge.
- **Association bills → Utility** is a pick-or-type field: type "Pest control" once and it is in the list from then on. No code change, no settings page.

## Round 45

- **Payments with no task can now be fixed.** Payments → Reconciliation → "Payments not linked to any task": each row has **Link to task…** (lists tasks marked financial) and **No task needed…** (Contract / AMC, Payroll, Statutory, Bank charge, Office / admin, Other). Either action removes the row from the list; the reason is kept on the ledger row (`noTask`). Needs MANAGE_LEDGER.

## Round 46

* **Delete rules** — in an expense or task, *Save · Cancel · Delete this entry* sit in one row. Delete is hidden once any payment is attached, with a note saying why and what to do instead. Tasks: Super Admin only.
* **Actual amount is optional** until the expense goes for approval (an estimate is enough to save; approval needs the amount).
* **Payments** — Cultural and association-bill rows open a detail like a maintenance task (record id, steps, payments, files).
* **Menus** — Reports and Amenities menus wrap fluidly on mobile.
* **Unit page** — Dues tab starts with Total dues · Overdue · Penalty · Advance · Security deposit; **Settle dues** clears several bills in one payment (oldest first, advance used first). Rows open the owning module's detail (tickets, bookings, bills, documents) and show their record ids.
* **Bill terms everywhere** — tax breakdown, highlighted due date and how the late fee applies: bill detail, pay dialogs, booking detail, reminders, bill notifications, levy notices, booking messages.
* **Payment gateway adapter** — simulated provider with signed webhook, failure/pending/retry; wired to bills, unit settlement, bookings, donations. See `docs/ARCHITECTURE.md`.
* **Country profiles** — Community setup → Country (IN, AE, GB, US, SG, AU) drives tax names, currency, number style, FY month and providers.

## Round 47

* **Professional receipts and statements** — one A4 letterhead (name, address, registration, tax number, footer are set in Community setup). Receipts for bills (single and combined after "Settle dues"), amenity bookings (tax split by country, deposit shown), event donations; "Print bill" for unpaid bills; unit **Statement of account** with opening balance, running balance and closing balance for any period. Print / Save as PDF or download. Code: `lib/documents/*`, `components/DocumentPreview.jsx`.
* **Time trail on every record** — the write path now stamps `timeline` (each status-type change: what, from → to, who, when) and `dateStamps` (the moment each date field was set). Shown in the record footer ("Key moments") and read-only dates show the time. Clients cannot forge either field.
* **Amenity bookings** — booked-on, last-updated, paid-on (with time) and a booking history in the summary; receipt / invoice button.
* **Command center** — *Workforce on duty*: who is clocked in, role, since when, minutes late, tap-to-call phone icon; also who is expected today but not yet in. Hidden from residents.
* **Cultural photos** — Photos tab per event: tile gallery, pictures upload the moment they are picked (drag-and-drop too), lightbox with timestamps, caption edit, download, remove, and **Save to Documents** (folder *Cultural events / <event>*, same bytes). Role- and permission-based: tab access (Event: Photos), per-event "Show to residents" and "Who can add photos", uploaders manage only their own, MANAGE_CULTURAL manages all. Storage goes through `ObjectStore` (browser demo now; S3 or Azure Blob through signed URLs against Spring Boot — see the endpoints in `lib/files/objectStore.js`).
* **What is still hard-coded** — `docs/CONFIGURABILITY.md`.

## Round 48

* **Notices** — Command center and Communications → *Notices* show the latest 10 notices with a month / year filter (tap one to read it; residents only see what was sent to them). "By status" and "Busiest categories" are gone from the Maintenance summary.
* **Configurable lists** — Community setup → *Lists*: shift types (name, time, colour), amenity time slots, ticket categories and extra document groups (choose which roles can open them). Defaults stay until edited. Stored as one JSON on the community config row.
* **Payment modes by country** — each country profile lists its online rails (India UPI / Card / Net banking, US Card / ACH, UK Card / Direct debit, UAE Card / Apple Pay, Singapore Card / PayNow, Australia Card / PayID); Cash, Cheque and Bank transfer everywhere. The UPI QR and "Open UPI app" appear only in India; elsewhere the pay panel asks for a payment reference.
* **Late-fee rules per bill type** — Billing → Dues → Late fees: a default rule plus one rule each for Water, DG, Maintenance, Special levy, Amenity booking and Other (percent or fixed per month, grace days, stop after N months). Existing single rules keep working as the default.
* **Final amount due** — a bill with accrued late fees shows *Bill + Late fee = Final amount due* in bill detail, the pay dialog and the printed bill; paying adds the fees to dues and clears bill and fees in one payment.

## Round 49

* **Photos filed by year and event** — cultural photos are stored at `communities/<community>/cultural/<year>/<event>-<id>/…` and, when filed into Documents, appear under **Cultural → <year> → <event>** (older "Cultural events" folders are moved over).
* **Accounts & budget for any community or country**
  * **Full amounts** — nothing is stored "in lakh" any more; the display unit (lakh/crore, thousand/million, full) follows the country or the community's own choice.
  * **Deposits & investments** — a proper list (type, rate, start, maturity, status) replaces the two FD columns. Account totals, "Can we cover it?" and the Billing dashboard add up the active ones; deposits maturing within 60 days are flagged.
  * **Heads and statement rules are the community's own** — Community setup → Lists → *Accounts & budget heads*: income / expense / neutral heads, starting sets (general HOA / condo with starter rules, or the original La Paloma set), your own "contains … → head" rules (tried first), and deposit types.
  * **Revised budget** on any budget line (replaces the original in totals and charts and shows "revised from …").
  * **Funds** gain a target balance (reserve goal) and the account they are kept in.
  * **Bank import** — CSV and Excel; month-first dates (US/Canada) are an option on the import rule.

## Round 50

* **Wishlist** (Maintenance → *Wishlist* tab, visible to residents too) — ideas raised by residents or the EC (a bench, a gym machine, a speed bump).
  * New collection `wishes`; statuses Submitted → Under review → Planned → Done, or Declined (reason required) / Withdrawn by the raiser.
  * **One vote per villa** (▲ button, tap again to remove). Filters: All / Open for voting / Planned / Done / Declined / My ideas; sort *Most wanted* or *Newest*. Each card shows a 3-line preview.
  * **EC / managers**: change status, add a note and rough cost, see which villas voted, and **Convert to task** — pick any configured task type, category, priority, SLA and (for EC/Staff types) the assignee. The task is created for the whole community and the idea keeps a link (`→ TKT-…`).
  * Rules enforced server-side (`authz.js`): a raiser edits their own idea only while Submitted; any villa may change only its own vote; only the EC changes status/decision; vendors cannot raise ideas.
* **Task types are fully configurable** (Maintenance → *Task Types*) — the same complete form is used to add and to edit a type (who can create, assignment, quotation / EC approval / treasurer / invoice / payment stages, resident visibility). The type used for residents' own requests is now a setting (*Used for residents' own requests*) instead of the hard-coded "Resident Maintenance". A type that tasks use cannot be deleted or renamed; duplicate names are refused. The task schema no longer lists type names in code.
* **Notices show a 3-line preview** in the Notices list; tap a notice to read it in full.
* Test: `t123` (notice clamp, wishlist raise/vote/decline/convert, task-type add/dropdown/delete guard).

## Round 51 — closing the money loopholes (quotation → release → invoice → payment)

**What was wrong** (found by tracing the flow): a release could be asked for after the invoice had been paid straight from Payments, because the cap only counted other releases; the limits lived only in the screens; one payment marked an invoice "Paid" even for a part amount; recorded payments could be edited or deleted; approvals could be undone and tasks cancelled after money had moved; and there was no way to correct an approved release or invoice.

**One rule, enforced on the server** — `lib/approval/moneyGuard.js` (used by the screens *and* by `secureStorage` on every write, Super Admin included):
* *Cap* = approved invoices, else the approved quotation. *Committed* = live releases + payments made straight against the task or an invoice (TDS counted). *Remaining* = cap − committed.
* **Release**: refused when the task is closed or cancelled, when nothing is left, or when it is more than what is left; re-checked when it is approved. It can be marked Paid only when its payment exists.
* **Payment**: an invoice must be fully approved and cannot be overpaid; a release must be Approved, unpaid and not more than itself; a payment tagged to a task needs an approved amount and cannot pass it; a release cannot be paid once the task was already paid directly.
* **History is never edited**: a recorded payment's amount, account and links are locked and it cannot be deleted. An approved invoice cannot be edited or deleted. Approvals cannot be undone, the approved amount cannot drop below what is committed, and the task cannot be cancelled once money is committed; it cannot be closed while a release is still unpaid.

**Screens follow the rule** — "Ask for a release" is disabled with the reason; the Payments dialog shows *Still payable* and refuses more (the old "tick to confirm" no longer lets an overpayment through); a part-paid invoice stays in *To pay* with its balance; a release that can no longer be paid shows why and offers *Cancel release*.

**Correction process**
* **Reverse a payment** (Billing → Payments → Paid → *Reverse*, with a reason): the payment stays; a matching credit cancels it, both leave bank matching, a release goes back to *Approved*. Not possible once the payment is matched to a bank statement line.
* **Cancel a release** (Waiting or Approved, with a reason; frees the amount).
* **Send an approved invoice back for correction** (EC; reason + optional new amount; approvals return to Pending; only while nothing is paid on it).
* Tests: `t126` (38 checks of the rules), `t127` (server wall, disabled button, reversal, part payment).

## Round 52 — Infrastructure map (assets on the site plan, linked to maintenance)

A new **Infrastructure** page (Operations) shows every light, feeder, camera, pipeline and plant on the community's own site plan, coloured by working condition, with a health board by area and a one-tap link to a maintenance task. It is built for any community: each uploads its own plan and adds its own kinds of asset.

* **Map** (MapLibre GL JS 4.x, lazy-loaded so other pages do not pay for it). No tiles, no map service, no API key: the plan image is the only base layer. Positions are stored in **plan pixels**, so the drawing does not need to be to scale. Pins, lines (roads, pipes, cables), outlines (plants, clubhouse), street lights drawn as one dot per light along a road with the faulty ones coral, camera view wedges, an overdue-check ring, layer chips with counts, condition filters, find-an-asset search, a scale bar once the plan is calibrated.
* **Placing things**: *＋ Add on plan* (choose the kind; it draws a pin, a line or an outline), *Place* next to anything not yet on the plan, *Redraw*, *Set scale* (tap two points, say how far apart they are: pipe and cable lengths then show in metres), *Split* a group of lights into individual poles, CSV import for a long register (optional x/y as % of the plan).
* **Plans & layers** (EC / Facility Manager / MEP): upload a plan as **PDF or image**, trim off the tables and notes, fade it to a grey underlay (so the colours stand out), several plans per community; hide the kinds of asset the community does not have or add its own (name, pin / line / area, icon).
* **Health board**: one row per area with the worst condition, items, open tasks, next service and cover ending in 60 days; tap a row to see it on the map. A group is amber with any fault and coral from 30% faulty (`GROUP_OUT_SHARE`).
* **Condition** is the existing Equipment `status` (now also *Out of service*) plus `faulty` for groups; **Under repair is automatic while a linked task is open** (the stored condition is never rewritten by that). Every recorded condition is a row in the new **condition log** (inspection, task opened, task completed / closed).
* **Linked to maintenance**: *Raise task* on any asset opens a prefilled task (type, category from the kind of asset, location, photos; warns when a task is already open on the asset). The task keeps `assetId` / `assetName`; its detail shows the linked asset; when it is marked **Completed or Closed the person is asked "Is it working again?"** (Working / still needs attention / out of service, how many still faulty) and the answer is logged against the task. Nothing changes the condition silently.
* Data: assets are the existing **Equipment** records (new fields `shape`, `planId`, `faulty`, `lastInspected`; `type` is now a lookup so a community can add kinds), plus new collections `infraPlans`, `infraLayers` (code defaults + a community's own rows) and `infraLog`. Permissions follow Plant & Assets: staff read, EC / Facility Manager / MEP write; residents do not see the page yet (open question: resident view).
* Demo: La Paloma's approved layout (cropped and lightened from the scan; sheet scale 1:800 gives about 0.15 m per pixel) with illustrative street lights, feeders, cameras, water / sewer lines, plant areas. **Positions are illustrative: redraw them to the real poles, pipes and cameras.**
* Not built yet: GPS "you are here" (needs 3–4 plan points matched to real GPS positions), satellite tiles behind the plan, resident view, auto-condition from plant-log readings, criticality weighting in the roll-up, scheduled expiry / AMC tasks, QR labels.
* Test: `t130` (map draws, tap a pin, layers / filters, record condition, raise task, duplicate warning, draw pin and line, calibrate, split a group, board, kinds, CSV, PDF upload with trim, task completion prompt, resident has no menu, mobile).

## Round 53 — Community boundary and satellite view (Infrastructure)
* **Community boundary** (EC / Facility Manager / MEP): *⬡ Draw boundary* (or *Redraw boundary*) on the Map tab; tap the corners, Finish. It is saved on the plan (`infraPlans.boundary`, plan pixels). The map shows a dashed edge and dims everything outside. *Remove boundary* turns the limit off.
* **Placement is limited to the boundary**: with a boundary set, taps outside it are refused as you draw (pins, line corners, outline corners, *Place*, *Redraw*), a shape that still crosses outside is refused on Finish, and CSV rows whose x / y fall outside are imported unplaced. Saving a smaller boundary first says how many existing assets fall outside; they stay on the plan, are flagged in their panel, cannot be split, and are fixed by redrawing them inside. No boundary = no limit. The check is in the screens only; the Spring Boot API should repeat it.
* **Map / Satellite switch** (everyone): *Satellite* works once a plan is aligned and has a tile address.
* **Align satellite** (editors): enter the tile address (`https://…/{z}/{x}/{y}.jpg`) and a credit line, enter latitude, longitude, drag the plan over the imagery, turn and resize it with the sliders, Save. Stored as `infraPlans.geoRef` `{lat, lng, rot, mpp}` (plan centre, degrees clockwise, metres per pixel) plus `satelliteUrl` / `satelliteCredit`. An aligned plan switches to real coordinates; assets never store map coordinates, so aligning or re-aligning moves nothing in the data. Unaligned plans keep the flat, no-network mode.
* **Imagery licence**: no tile provider is built in. Google Maps / Earth imagery cannot be used; use the community's own drone map or a provider's plan that allows it (the credit line is shown on the map).
* Demo: the La Paloma plan ships with a boundary traced from the layout. No alignment is seeded (the real location is not known to the demo).
* Not built: dragging individual boundary corners (redraw replaces it), three-point GPS alignment, "you are here".
* Test: `t131` (boundary shown, blocked outside, line corner refused, shrink warning, flag + redraw, remove, satellite message, align panel, tile requests, drag / turn / size, save, real coordinates, tap on satellite, switch back, reload, mobile). `t130` now draws inside the boundary.

## Round 54 — Audit details collapsed, pages load on demand
* **Audit details** (the Id / last updated / created / timeline block at the bottom of a record) is now collapsed to one line ("▸ Audit details · id · updated date"). Tap it to open the details; **Audit history** (the per-field change list) inside it is still fetched only when asked for, so nothing is read until someone looks.
* **Pages load on demand.** `App.jsx` now loads each page (Billing, Maintenance, Audits, Infrastructure, ...) as its own chunk the first time it is opened, with a "Loading…" line meanwhile. The demo-data seeder (about 600 KB) is only downloaded when a community has to be seeded. The start-up script went from about 2.4 MB (650 KB gzipped) to about 0.68 MB (196 KB gzipped). The Utilities / Plant visibility rules moved to `lib/access/visibility.js` so the menu can decide without loading those pages.
* Already in place: the map (MapLibre, 800 KB), PDF reading, Word and Excel readers are separate chunks loaded when used; large lists (maintenance, audit trail, unit directory, documents, users, bank statements) are paged through the storage `query` call (ServerTable), the others page on screen (25 to 60 rows at a time).
* Still true: small collections are read whole (`useCollection`) and held in memory; that is fine for hundreds of rows. Before a community has tens of thousands of rows in one of those (Equipment with logs, Audits, Infrastructure log), move it to `ServerTable` / the paged `query` when the Spring Boot API replaces browser storage.
* Test: `t132`.

## Round 55 — Event work and Reports
**Event work** lives under the specific event: a *Work* tab inside a cultural event and a *Work for this booking* section in a booking (no separate menu page). Each item has: what to do, *when* (before / during / after the event), the day and time, kind of staff and **people requested / confirmed**, status, and an owner — **Facility Manager** or **MEP**. The owner's role is notified when work is given or changed (event `event_work`). Work is grouped Before / During / After with a to-do count and total people requested. The *Event work* report (Reports) gives the cross-event view.

**Reports** (menu: Reports; EC, Facility Manager, or anyone with Manage notifications). A report is `src/lib/reports/catalog.js` entry (bookings, dues, payments received, water & plant, maintenance tasks, audits due, infrastructure health, event work) — add one entry to add a report. A *scheduled report* chooses: the report and period, **format** (Summary / Detailed / Excel / CSV), **how often** (daily / weekly / monthly + time), **delivery** (In-app, Email, WhatsApp, SMS) and **to whom** (roles, named people, all villas, selected villas, plus extra e-mails/phones). Bookings and dues are personalised per villa. Every send is kept under *Sent*, where the full table downloads as Excel or CSV. A "Daily bookings" schedule is seeded.
`runReportSchedules()` runs in the 5-minute scheduler (idempotent per day); until the Spring Boot cron exists it only runs while someone has the app open. E-mail/WhatsApp/SMS are queued in the outbox (demo, no gateway).

Each scheduled report also chooses **what to show**: which columns, whether tax (GST) columns appear (for reports that carry tax: bookings, dues), a totals row, the key numbers, and an opening and closing line. Choices are stored on the schedule and apply to the in-app copy, the message text and the downloadable table.

**Custom reports (no code).** In Reports → *New report* choose *Custom · build your own*: pick a list (attendance, shifts, tasks, dues, bookings, visitors, incidents, plant logs, DG fuel, equipment, audits, vendors, event work, workforce), the columns, conditions (is / is not / contains / empty / not empty / more than / less than; `@today` for today's date), sorting, and optional grouping with count, total or average. "Covers" filters on a date field of that list. It is then scheduled, delivered and downloaded like any other report. Two examples are seeded (switched off): *Staff on duty now* and *Attendance by staff this month*. Lists are limited to an operational allow-list in `CUSTOM_SOURCES` (`lib/reports/catalog.js`); people, bank, vote and audit-trail data are deliberately not offered.

## Round 56 — Pipe breaks, and how a kind is drawn
- **Mark a break:** select a line (pipe, sewer, cable) → *✕ Mark a break* → tap the pipe. The tap snaps to the nearest point on the line (refused if more than ~120 plan pixels away). A coral ✕ dot is drawn, the asset becomes *Needs attention*, and the break is listed in the panel with a note box and a *Fixed* button that removes it. Stored on the asset (`breaks`, plan pixels), so it moves with the plan and survives re-alignment.
- **Street lights as pins:** Plans & layers → Kinds of asset now has a *Drawn as* menu (Pin / Line / Area) on every kind, not only your own. Changing it affects assets added from then on; existing lines keep their shape (the asset panel can already split a line of lights into one pin each).

## Round 57 — Asset on the task, assets needing attention, history only on click
- **Asset on a task.** The *New task* form has an **Asset** combo box over the asset register (Infrastructure). Typing a name that is not in the register is flagged ("not in the asset register"): pick an existing asset, clear it, or — if you may edit assets — *add it to the register* with the same record form Infrastructure uses, so kinds and places come from the same lists and nothing is re-typed. Picking an asset suggests the category (existing `categoryFor`) if none is chosen. The task keeps the asset id: the asset shows *Under repair* while the task is open, and closing it asks whether it works again (unchanged).
- **Conditional.** Category coverage has a new **Asset on tasks of this category** setting (Optional / Required / Hidden). Default Optional; Housekeeping is seeded Hidden. Resident requests never show the field.
- **Assets needing attention** — a collapsed strip above the task list (staff only): out of service / under repair / need attention, each with its open task or a one-tap *Raise task*. No map needed.
- **Audit details** shows ids and dates only. One **Show history** button reveals the history: people who may read the audit log see the full change list (who, when, before → after); (Round 58: the short timeline for everyone else was removed; see below.)

## Round 58 — Event brochure, community details, audit visibility, compact category
- **Event brochure.** Cultural event → *Brochure* tab. *Start with a ready layout* creates Cover, About, Programme, Offerings and Contact pages; add Text-and-picture or Photo-grid pages, reorder with ↑ ↓, edit words, add a picture per page (shrunk to 1600 px, stored in the object store like photos, so S3/Azure work unchanged). Programme, Offerings and Photos pages fill themselves from the event, so they never go stale. The brochure shows as A4 pages; *Open / print / save as PDF* gives a self-contained file. **Publish** makes it visible to residents (and notifies them); until then only the committee sees it. *Duplicate for next time* copies the pages (pictures are shared, not copied). Code: `modules/cultural/Brochure.jsx`, `lib/documents/brochure.js`, `lib/brochureImages.js`; collection `culturalBrochure`; pictures use `ownerType: 'culturalBrochure'` so a resident can read them only when the brochure is published (`authz.js filesScope`).
- **Timeline removed.** History is the audit history only. A booking no longer has a separate "Booking history" block.
- **Audit details are not for everyone.** Shown only to the Executive Committee (any EC-category role), Super Admin and roles with *View audit log*. The *Show history* button needs *View audit log* itself (the audit log refuses anyone else). Everyone else sees nothing at the foot of a record.
- **Community details** (Community setup → *Community details*): name, address, registration, PAN, phone, e-mail, website, **GST registered / not registered** (the tax number box disappears and no tax number prints anywhere when not registered), wording (signature line, thanks line, footer, *How to pay*, statement note) and a **live preview** of a receipt and a statement. This is the one place for the tax number: the old GSTIN box in Amenities rates is now read-only and points here (`communityTaxId()` in `lib/locale.js`). A new community starts with its own name and blank details, not La Paloma's.
- **Receipts and statements** are not edited as files: the wording above plus the community details are the template (`lib/documents/templates.js` is the one stylesheet and layout). Changing the layout itself is a code change; say if you want a layout editor.
- **Category on a new task** is a compact tile grid (2–3 per row on a phone) that folds to one line (*🔧 Plumbing · Change*) once chosen. `components/CategoryPicker.jsx` can be reused for any pick-one list.
- Test: `t139` (details + preview + validation + not-registered, audit visibility by role, brochure build / picture / reorder / publish / resident view, category tiles on desktop and phone).

## Round 59
- **Maintenance request**: common issues are a one-line toggle that opens a wrapped tile grid (no scroll bar); "Assigned to" help is an ⓘ icon with a hover/tap tip.
- **Outage prevention**: staff post a *service notice* (power cut, water, lift, internet, gas) for the whole community or chosen blocks. Residents see a banner; raising a matching request ("no power in my villa") asks them to confirm or, in "Do not accept" mode, blocks it. Staff are nudged to post a notice when 3+ villas report the same thing within 3 hours. Posting notifies via the `service_notice` event.
- **Asset specs**: specs follow the asset type (built-in defaults, per-kind override in Infrastructure → Plans & layers, fuzzy type matching, generic fallback, free extra specs). Condition is colour coded.
- **People per villa**: events have a default expected count; programme items can override. Sign-up records people and capacity counts people.
- **Brochure**: Publish / Republish dialog with configured-channel notification (`brochure` event), optional note, versioning, silent republish. Programme-level publish removed.

## Site map (Leaflet) - replaces the Infrastructure page
The old MapLibre **Infrastructure** page, `PlanMap.jsx` and the `maplibre-gl` package are removed. **Site map** is now the only map page (older Round 50-58 notes above that mention the Infrastructure page or MapLibre describe the removed version).
- Tabs: **Map**, **Health board**, **All assets**, **Plans & layers** (access keys `sitemap.map|board|list|setup`).
- Leaflet in `L.CRS.Simple` (the plan image is the base layer, plan pixels are the map units, no tiles or network), drawn on one **Canvas** renderer. Assets, plans, kinds, condition colours, tickets and the asset panel are unchanged.
- Detail-zoom icon pins, condition and kind filters, search with fly-to, tooltips, scale bar, cursor position in px and metres, fit, full screen, plan-strength slider.
- Add a pin, line or outline with **snapping**; Undo/Finish; camera direction; mark a pipe break; **Measure**; **Set scale**; **community boundary** (draw, redraw, remove; placement is limited to it).
- **Speed test**: +1,000 or +5,000 sample pins in memory only.
- Removed with the old page: satellite alignment and the Map/Satellite switch (plan fields `geoRef`, `satelliteUrl`, `satelliteCredit` are gone from the schema; old saved values are ignored).
- Files: `modules/infra/SiteMap.jsx` (page + tabs), `LeafletMap.jsx` (map), `InfraPanels.jsx` (asset panel, overview, add and scale dialogs), `leafletModel.js`. Tests: `t141`, `t142` (the old `t130/t131/t132/t137` were retired with the page).

## Round 60
- **Payments:** every online credit (cultural Contribute/pledges, offerings, dues, amenities) goes through the community payment gateway; the per-event gateway switch and UPI-id gating are retired. Contribute asks for an amount, records a pledge and opens the gateway checkout.
- **Maintenance:** the ticket "Unit" is now **Location** (a labelled item in the details, not in the title). Tasks raised from the Site map show a "Raised from the Site map" chip with a link back to the asset.
- **One asset record:** the Site map and the asset page use the same equipment form. Asset name is fixed once saved (only admins/EC can rename; enforced in the UI and authz). New **Kind of repair** field drives the task category.
- **Site map:** Raise task is disabled while a task is open on the asset; new **Tasks** tab lists task operations with their TKT ids.

## Round 61 — Security & Visitors (GateGuard)
Replaces the old gate log. Design: see the GateGuard design doc. Code: `src/modules/gate/`, engine and rules in `src/lib/gate/`.
- **Gate console** (guard): pass/OTP, registered person (maid, driver, crew), delivery, visitor-without-pass, emergency override. Everyone not pre-allowed goes to the villa as a photo approval. Every entry is a record; "Inside now" is the live list.
- **My Gate** (residents): approve or deny with the visitor's photo (also from the notification bell), guest passes (one-time / recurring / event, 6-digit code), delivery rules and away mode per villa, household staff, activity. Residents only ever read their own villa's rows.
- **Registry and vetting**: maids, drivers, riders, daily workers. Status moves Invited → Documents pending → Under review → Active; only Active people can enter. Police certificate and licence expiry are tracked and expired people are stopped at the gate.
- **Crews and work orders**: a vendor's daily roster against a work order; headcount in versus out.
- **Ghost-entry flags**: Unrecorded entry (with a grace window), Tailgate, Override entry, Overstay, Wrong destination, Blocked person attempt. Each is closed with a resolution and a reason.
- **Rules and alerts**: waiting time, fallback, quiet hours, approved delivery companies, and a notification matrix (who is told, with or without photo).
- **Gate simulator**: stands in for the face terminal, FASTag reader, barrier sensor and camera so the flags can be demonstrated. Real devices would post the same events to `lib/gate/engine.js`.
- Collections: `gatePeople gateLinks gatePasses gateVisits gateApprovals gateFlags gateVehicles gateWorkOrders gateVillaRules gateSettings` (the old `visitors` collection is gone). Page tabs are switchable per role (`gate.*`).
- Not in this round: real face recognition, real device drivers, SMS/WhatsApp/push delivery (in-app only), photo storage outside the browser.

## Round 62
- **Important numbers** (Command Center, everyone): emergency SOS buttons, community office, on-call technicians, utilities, medical. Staff add/edit rows in the card; residents see who is on duty. Collection `importantNumbers`. **The phone numbers shipped are placeholders** and must be replaced.
- **Maintenance task:** picking an asset fills Location (area / place) automatically and locks the asset name as a prefix on the title ("Borewell 3: …"). Description is never prefilled. The assets offered follow the chosen category (a toggle shows all). The linked-asset block under the description is gone. The Money tab is now **Costs & approvals**. The same prefix rule applies to tasks raised from the Site map.
- **Reference data** (`lib/seed/refData.js`): new categories Civil & Painting, Water & Sewage, Fire safety plus sub-categories under existing ones; facilities (clubhouse rooms, courts, HT yard, WTP, STP, rainwater harvesting, borewells); ~66 assets (transformers 2×500 + 160 kVA, DG1/DG2 500 kVA, DG3 125 kVA, stabiliser, panels, APFC, CCTV, NVR, UPS, street lights, pumps, treatment plants…); ~48 inventory items. 212 villas were already seeded. Borewell count (4) and all quantities are assumptions to correct.
- **Amenities:** each amenity has a reservation mode (**Reservation required** or **Walk-in (no reservation)**), advance-booking window, override roles (committee roles that may book outside the rules), per-day / per-month / upcoming limits, blackout dates and allowed unit types. Courts, children's park, cricket box etc. are walk-in. Staff can **correct a booking's fee** (unpaid bookings only; paid ones are cancelled with the right refund and booked again).
- **Data health** (Reports → Data health, and a chip on the Command Center): tasks pointing at a missing asset, assets with a missing category, bills for units that do not exist, stale readings, duplicate numbers and similar. Code: `lib/dataHealth.js`.
- **Billing corrections:** from any bill, "Something wrong with this bill?" opens one dialog: **replace with a corrected bill** (new unit / amount / date, old one cancelled and linked), **cancel** (late fees cancelled with it) or **reverse a payment** recorded by mistake (ledger line removed; refused if matched to a bank line). Cancelled bills keep their original amount, reason, who and when, and count as nothing owed everywhere. Code: `lib/finance/correct.js`, `components/CorrectBill.jsx`.
- **Site map:** every asset that is not in "Working condition" pulses with an expanding ring in its condition colour.
- **Guard silence (real):** the gate console records activity (any tap, or the "I'm at my post" button). A guard who is clocked in, with security in their role name, and has had no activity for the set time (Rules → "Guard silence alert after", default 45 min, 0 = off) raises a *Guard silence* flag, once per quiet spell. It is raised by the sweep that runs while any gate screen is open, so it needs a console open somewhere.
- **Residents and security:** My Gate → **Community security** shows counts (entries, deliveries, turned away, open alerts), guards on duty with last-active time, how many registered workers are vetted, and recent incidents. No other villa's visitors, names or photos. Own-villa visit and approval history was already in **Activity**.
- **Registry ↔ Service directory (opt-in):** a resident can "Recommend to neighbours" a maid, cook or driver of their own household, with a phone and rate they enter. The directory shows a **Vetted at gate** tag only while the person is Active in the registry. Nobody is listed automatically.
- **Registry freshness:** the registry has an "Is the registry up to date?" card: expired police verification or licence, vetting older than a year, not seen at the gate for 60 days, no villa confirmation in 6 months. One button suspends everyone with expired papers. Residents confirm "still works for us" in My household.
- **ID checks:** staff type the number; Aadhaar is checked for length, first digit and the Verhoeff check digit, other IDs by format; duplicates across the registry are caught by a salted hash. Only the last four digits and the hash are stored. This is **not** verification: it cannot tell that a document is genuine. See "ID automation" in docs/CONFIGURABILITY.md.
- Gate rules can now be saved by the Facility Manager as well as the committee (the screen and the server rule disagreed before).

## Round 63 — goods vehicles, shareable passes, patrols, staff badge
- **Goods pass** (My Gate → Guest passes → "+ Goods vehicle"): vehicle number, driver, what for (move in/out, goods delivery, contractor, waste/tanker), **people allowed in the vehicle**, material, and an optional **out-pass** (items leaving). At the gate the guard counts the people and checks the plate. More people than the pass, or a different plate, holds the vehicle until the guard picks a reason (supervisors get a flag), or lets it in and flags, by a Rules setting. On the way out the people are counted again; a different number from the one who came in is a *Headcount mismatch* flag, and a vehicle carrying items out needs the out-pass items ticked.
- **Regular goods vehicles** (tanker, milk van): mark a Vendor plate as "regular goods vehicle" with its usual people; the plate read opens it. If a camera counts more people than usual it is held.
- **Unscheduled goods vehicle:** "Visitor without a pass" → Goods vehicle (plate, people, material, group photo); the villa approves live as before.
- **Kiosk and manual open:** with "A face kiosk opens the gate" switched on (Rules), approved visitors go to the kiosk; the guard's button becomes "Open by hand…" with a required reason and a *Manual open* flag. The Gate simulator has a Face kiosk card (matches / no match). Real kiosk hardware is not included.
- **Passes with QR and PIN:** every pass has a 6-digit PIN and a QR (`GGP|pin`). A pass opens to show both with **WhatsApp, SMS, Share… and Copy** buttons (WhatsApp/SMS open to the guest's number with the message filled). The wording is a community template in Rules (fields {guest} {host} {unit} {community} {pin} {date} {time} {vehicle}). The guard can type the PIN, use a hand scanner, or scan with the phone camera where the browser supports it.
- **Pass templates:** a villa saves any pass as a template ("Cook, every morning", "Birthday, 30 guests") and starts a new pass from it; community-wide templates (moving truck in/out, contractor with materials) are offered to everyone. Dates are always set from today.
- **Patrol:** Security → Patrol. Checkpoints (QR on a post, printable sheet, "New QR" retires a printed one), rounds on a schedule (start time, minutes allowed, checkpoints, days), scans by guards, today's progress per round, last-7-days compliance. A round not fully walked inside its window, while a guard was clocked in, raises a *Missed patrol* flag once. Scans closer together than a set number of seconds are refused (a photographed code cannot be used to tick every post from one spot). Checkpoint and round setup is for the committee and Facility Manager.
- **Staff badge:** Security → My badge shows a QR that changes every 30 seconds. The guard's "Staff badge" mode checks it (right person, current code, active user) and records them in or out as a Crew visit. A screenshot stops working in under a minute. In this demo the badge secret lives in the community's gate settings; a real backend must hold it and verify server-side.
- **Mobile:** the Security tabs are one scrolling row, KPIs are a compact strip, explainer text is hidden on phones, Visits and Registry are compact rows, My Gate shows only the villa line. The Rules page is still long on a phone.
- New collections: `gatePassTemplates gateCheckpoints gateRounds gateScans`. New flag types: Headcount mismatch, Manual open, Missed patrol.

## Round 64 — roles and notifications audit
Checked every left-menu page, tab, permission key, schema field and notification event against what the Super Admin can manage.
- Pages: all 25 menu pages are in the page list, except Roles & Permissions and the No-code Studio, which are Super Admin only by design.
- Tabs: Community setup (5 tabs) and Notifications (4 tabs) can now be switched per role. Every other tab was already listed.
- Permissions: every permission key used in code is in the role editor.
- Fields: all 1,313 schema fields carry view/edit role lists and are editable in the Studio.
- Notifications: the 11 gate events were in-app only and missing from Channel settings. They now have WhatsApp / SMS / e-mail switches like every other event.
- New "Also tell (roles)" column in Notifications → Channel settings: the admin can add roles to any event's audience.
- Not configurable in the UI (by design): which permission opens which collection is fixed in code; portal invitations and OTP are always sent.

### Round 64b — committees managed in the UI
Governance → Executive Committee / Sub-committees → **Manage** (needs Manage roles). Create, rename and delete a committee or seat, add or remove members, with no naming rules to remember. Behind it a committee is still a role (`committee_…` for sub-committees, category EC for seats), so permissions are set in Roles & Permissions. Amenities' association list now reads from the same sub-committee roles, replacing the separate sub-committees list.

## Round 65 — tax split (GST limit test)
Billing → **Tax split** (needs ledger access; the Super Admin can switch the tab per role).
- **GST limit:** registered or not, yearly turnover, registration threshold, and the exempt limit per unit per month (default ₹7,500).
- **Categories:** every bill category (now including Sinking fund and Corpus fund) is set to *Counts toward limit*, *Excluded (pass-through)*, *Taxed separately* or *Exempt*, with a GST rate, a destination account and a written reason.
- **Test by month:** per unit, the counted amount against the limit; units over or close to it; the GST that would apply (only if registered); amounts collected per account; CSV of every unit. Edits preview live before you save.
- Planning aid only. It measures and previews; it does not add GST to bills or split a bill across entities. Defaults are placeholders to confirm with a CA.
- Files: lib/finance/tax.js, modules/billing/TaxSplit.jsx; collections taxSettings and taxComponents (seeded; data version 2026-10-20-a).

## Round 66
- Audit: create and delete now store a snapshot (up to 14 filled fields); updates keep storing only the changed fields in one record.
- Inline field errors: banner messages are moved under the matching input and the field is highlighted (`lib/inlineErrors.js`, heuristic by label words).
- Important numbers: compact, collapsible, sections managed by Super Admin (NUMBER_SECTIONS). Workforce on Duty cards removed.
- Links look like buttons across the portal; info tooltips clamp to the viewport.
- Assets: multi-category (`alsoCategories`), filter by category, "file here" fix; Data health gains Mismatch findings and a Review record button.
- Renames: "Utilities & Plant", "Inventory & Assets". Walk-in note removed from Amenities; Service notices above ticket summary.
- Vendor workers: per-vendor service lines (VENDOR_SERVICES) with workers signed for versus workers registered at the gate.
- GST input credit: Billing → Input credit. On demand ("Check all now") plus an optional daily background run. Uses GSTIN check-digit, invoice-number check and a pluggable GST-portal lookup (`lib/finance/gstGateway.js`, simulated in the demo).
- Credit notes: reason length, no repeats, no duplicate units, amount capped by what was billed, refund needs a bank account and UTR.

### Round 66b
- Amenity add-on items (`AMENITY_ITEMS`, Amenities → Rates): any item with stock, price, optional amenity, per-booking limit. The booking form shows quantity boxes with what is left; the server re-prices and checks stock for the same date and slot. GST follows the amenity's GST setting.
- Late fees: the "All other bills" rule can now be removed ("No late fee on other bills") and added back.
- Reports → GST report: by financial year, monthly collected / paid to vendors / claimable / at risk / net, with CSVs (summary, GSTR-1-style sales, purchases and credit).
- GST connection (Billing → Input credit): Simulated or Live (your server), statement GSTR-2B or GSTR-2A, Test connection, Verify vendor GSTIN. See docs/GST_API.md.

### Round 66c: real map behind the site plan
- Site map → Plan | Street (OpenStreetMap) | Satellite (Esri) | Own tiles. `modules/infra/LiveMap.jsx`, `lib/infra/geo.js`.
- Align once: tap two recognisable spots on the plan, then the same two on the real map. That fixes position, scale and rotation (`plan.geoRef`) and sets the plan's metres-per-pixel if it was not set. The boundary, lines, zones and pins then appear at real positions. Drawing and editing stay on the plan.
- Own tile address (Mapbox, MapTiler, Google or your own server) is saved on the plan; the free OSM and Esri tiles suit trials, not heavy daily use.

### Round 66d: site map batch
- Pins group into count badges when zoomed out (`lib/infra/cluster.js`, grid based). Tap a badge to zoom in. Off while drawing.
- "Fit site" button and a small overview box (own implementation, not Leaflet's minimap plugin; can be hidden).
- Press and hold (phone) or right-click: Report an issue here. Pre-fills the ticket with the spot, lat/lng when aligned, and the nearest asset.
- Share links: `#/map?asset=…&base=…&cond=…&hide=…&plan=…`. "Share" on the asset panel copies one.
- Legend and "Plan fade" slider. Speed-test footer shows to admins only.
- Who is affected by a break: assets get `serves` (blocks/zones) and `closeValve`. The panel lists the units, "Show on map" highlights the pipe, matching zones and the valve to close. Raised tasks carry the units and a "Close first" line. This comes from the team-set fields, not hydraulic inference; villas have no plan position.
- Version history: `MAP_VERSIONS` store keeps up to 40 versions per asset shape/break and per plan boundary/alignment. Undo button after a move/redraw, and Plan history / asset History with Restore. Restores are recorded too.
- Phone: map fills the screen, Filters and Tools collapse into buttons, selected asset opens as a bottom sheet. Desktop keeps inline chips.

### Round 67: Spring Boot + PostgreSQL back end, flip-able data source, MyGate import
- **Data source chip** (bottom-left, always in `npm run dev`; in production builds only with `VITE_SHOW_DATA_SOURCE=true` or once on the back end): Browser demo ↔ Back end, Test connection, copy a community either way. `src/lib/storage/{dataSource,ApiStorageAdapter,index,migrate}.js`, `components/DataSourcePanel.jsx`.
- **`backend/`**: Spring Boot 3 service (ports and adapters; PostgreSQL JSONB documents; Flyway; S3/local files; SMTP/HTTP channels + outbox dispatcher; payments and GST ports; none/api-key/JWT security; Docker). A Node stand-in on the same schema lets you develop against real PostgreSQL without Java. **The Spring project is uncompiled, see docs/BACKEND.md §7.**
- Every external integration is documented with set-up and switch steps in **docs/INTEGRATIONS.md**.
- **Security → Import from MyGate** (Super Admin / security managers / committee): daily help (with villa links), vehicles, visitor history; column matching, review before writing, re-runnable. Plan: **docs/MYGATE_MIGRATION.md**.
- Opening the app on a database never wipes it; the demo reset only works if the server allows it.

### Round 67b: validated every flow against the back end
- All 63 UI test files re-run with the app on the back end (real PostgreSQL via the Node stand-in) and on the browser store: all pass in both modes.
- Fixed from that run: ids with spaces or "·" (e.g. gate guard pulses) were rejected by the server; seeding an empty back end from two tabs at once cross-linked ids (seed ids are now deterministic and seeding is single-flight); toggles and checkboxes now update at once instead of waiting for the server; file uploads in back-end mode go to the server's file storage; payment, GST and signed-URL calls send the same address, access key and community header as the rest of the app.
- Honest limits are in **docs/BACKEND.md section 7**: the Spring project has not been compiled (no access to Maven Central here); sign-in/OTP, role-based authorisation and payment settlement are still browser-side.

### Round 68: fewer API calls
- 25-page walkthrough 755 -> 271 requests; login screen 111 -> 8. Identical in-flight reads are shared; a 3-second keep for settings/reference lists only (never for dues, tickets, payments...); seeding checks one collection; gate sweep and background jobs no longer overlap. Details in docs/BACKEND.md section 8.

### Round 69: real sign-in, server-side authorisation and payments (Node reference)
- Sign-in by one-time code or an OIDC provider (Keycloak-ready, community claim is a list); sessions with rotating refresh tokens, rate limits, lockouts; demo roster off in production. Server-enforced roles, own-unit rows, block scope, hidden fields; audit written only by the server; optimistic locking with 409; payments priced, settled atomically (bill + ledger + receipt) from a signed webhook with a reconcile job and a "we're checking your payment" screen; request timeouts, safe GET retries, buttons disabled while paying; 8 background jobs moved to the server. 51 API tests (`cd backend/contract-server && npm test`). Details: docs/BACKEND.md §4-7, docs/INTEGRATIONS.md §8. **The Spring project has not received these yet and is still uncompiled.**

### Round 70: concurrency, security and payment hardening (Node reference)
- Idempotency keys on every write (replay, mismatch 422, in-flight 409); `REPEATABLE READ` + automatic retry for settlement and an atomic payment claim for bookings; API rate limits (429 + Retry-After); card-data guard (PCI); AES-256-GCM field encryption with key rotation; IP + request id in audit lines and secrets hidden in them; HTTPS enforcement + security headers; DB pool/statement timeouts; circuit breaker for the payment provider; transactional outbox for follow-up work. 69 API tests. Point-by-point status incl. what Spring still lacks: docs/PRODUCTION_CHECKLIST.md.

### Round 71: typed tables, scope in SQL, Spring routing/logging/Swagger
- Hot collections (units, users, dues, bookings, tickets, ledger, audit) now live in real tables with generated typed columns, foreign keys (dues/bookings -> units) and indexes; the record is still one JSON document, so community-defined fields need no migration. Forum, notices, settings and custom fields stay JSONB. Audit is append-only and partitioned by month. One router decides where a collection lives; the UI and rule book are unchanged.
- Row scope (own unit, own block) is pushed into the SQL WHERE for the collections where it is exactly equivalent; the in-memory path remains the fallback. Tests compare both paths for every role.
- Audit screen pages on the server. Spring: `RoutingDocumentRepository`, `TypedDocumentRepository`, `ScopeSql`, `QueryCompiler`, request-id logging filter, Swagger UI (`/swagger-ui.html`). **Spring is still uncompiled by Maven**; see docs/BACKEND.md section 9 for exactly what was checked.

### Round 72: Spring parity (authorization, row scope, locking, settlement, idempotency, outbox)
- The Java rule book (`com.communityos.security`) replaces the old tenant-only check: roles, own-unit rows, block scope, hidden fields, approvals, closed books, all proven equal to `authz.js` by replaying about 72 700 decisions generated from the real JavaScript. `SecureRecordService` adds row locks, `recVersion` 409, server stamps and the audit trail.
- Payments: server-priced orders, signed webhook, settlement of bill + credit + ledger line + receipt in one REPEATABLE READ transaction with retry, reconcile job, circuit breaker, booking claim. Idempotency-Key filter and a transactional outbox (`payment.settled`). Bills marked paid by finance now mirror into the ledger.
- Writes that need Node-only checks (money caps, e-voting, amenity pricing) are refused by default (`app.security.unported-hooks`). Details and the differences from Node: docs/BACKEND.md section 10.
- **Honest status: written and exercised only with stubs (40 plain-Java tests + the conformance replay). Maven has never run; nothing has run on PostgreSQL. Run `mvn test` on a machine with Maven access.**

### Round 77: role-scoped data and tamper-proof writes, v2 redesign (one table per object, typed API), Java 25 + PostgreSQL 18
- **Each role sees only its own data, on every API and every save.** An owner gets only their unit's records; a changed or forged payload (another unit, another person's record, a hidden field, a different role) is refused on Node and Spring (`authz.js`, `guards.mjs`, `R77Rules`, `WritePrep`).
- **Created / updated date and by are set by the server.** Whatever the payload says is ignored.
- **Spring start-up fix:** `JobRunner` failed with "No default constructor found".
- **New v2 back end (`backend/api`, docs/REDESIGN.md):** a PostgreSQL schema with a table for every object (156 tables, one schema per area, row-level security per community, stamping triggers, double-entry ledger, monthly partitions). Built for 100 communities x 1 000 units; the main queries run in 0.1-6 ms at that size.
- **A Spring Boot service on that schema**, with sign-in (one-time code, ES256 bearer token, rotating refresh token), units, members, bills and payments (server pricing, signed webhooks, retries, circuit breaker, outbox, audit). Other modules have their tables but no endpoints yet.
- **The app can use it:** Data source -> "Back end v2" (units, members, bills, payments, sign-in).
- **Java 25 and PostgreSQL 18:** both Spring services move to Java 25 and Spring Boot 3.5.16; docker-compose uses `postgres:18` (volume now mounted at `/var/lib/postgresql`).
- **Honest status:** checked on PostgreSQL 18.4 and OpenJDK 25: schema 15/15; v2 Java 40/40 including an end-to-end flow on PostgreSQL; 103/103 SQL statements run as their database role; Node 118/118; legacy Spring 54/54 of the tests that compile with stubs; web adapter 6/6; `vite build` builds. **Maven has never run; neither Spring service has started for real.** Run `mvn verify` in `backend/api` and `backend/spring` first.

### Round 76: saves no longer clash with themselves, no caches, data loaded when shown, property / meeting hooks on Spring, several units, new communities
- **"Another user changed this record" on your own edits: fixed.** Saving the same record two or more times in a row works; an edit someone else made in between is still caught.
- **No caching.** The reference-list, late-fee, search and server meta caches are removed (BACKEND.md section 8).
- **Only what is shown is loaded.** Users are no longer read on the home page, in tickets, on properties (press "Show portal access") or by table filters; the data-health scan runs on its own page. Home page: 32 calls -> 14.
- **Spring: property and meeting hooks and meeting notifications.** Phone numbers checked exactly as in the browser (a Java port of the phone library on the same metadata), portal invites, re-links and deactivations, the "Portal access" audit line, meeting publish time and resident messages. 0 differences from the JavaScript on 24 071 numbers and 2 500 random communities.
- **A payer with several units** can pay the bills of each of them on Spring (Node already could).
- **Creating a new community when a back end is in charge**, on Node and Spring: the platform console signs its calls with `PLATFORM_ADMIN_KEY`; the new community gets its roles and defaults and a first Super Admin who signs in with a code to their phone.
- Fixed on Node: invite links were broken (`undefined//undefined`); set `PUBLIC_APP_URL`. Reactivated users kept their "deactivated" date.
- **Honest status: Spring is still exercised only with stubs (101 plain-Java tests + 7 conformance replays, all passing); Maven has never run it. Node: 92 API tests pass on PostgreSQL. The Node server remains the tested reference.**

### Round 75: Spring ports notifications, late fees, the background jobs, field encryption and phone sign-in
- **Notifications.** Spring now sends the messages a save sets off: a task assigned or moved on, a quotation or invoice waiting for its approver (or decided), forum topics, polls and replies, task chat, new resident requests, release approvals and payments, closed ballots. They are written in the same transaction as the save, with each person's WhatsApp / SMS / e-mail choice and the community's channel settings.
- **Late fees and payments.** Late fees are added by a job (when switched on) and **at pay time**: the server adds what has built up before pricing the order. After a bill is paid online the unit gets "Payment received".
- **All eight background jobs** run on Spring: utility types, amenity scheduler, recurring bills, late fees, payment reminders (with the bill's tax, due date and late-fee terms), e-voting "last chance" reminders, the GST input-credit check and the scheduled reports (eight built-in reports and custom ones). Each community's job is one transaction under a PostgreSQL advisory lock, so several servers never repeat work. `POST /api/admin/jobs/run` runs them by hand.
- **Proof:** 15 346 operations generated from the real JavaScript (`npm run gen:jobs`) give the same rows, audit lines and answers in Java: 0 mismatches. 11 of 12 deliberate faults were caught.
- **Field encryption** (`DATA_ENCRYPTION_KEY`) on Spring, in the Node format: values written by either server open in the other.
- **Phone sign-in on Spring** (`SECURITY_MODE=local`): one-time codes, limits, lock-out, sessions with rotating refresh cookie, role switch, invites, all at the same endpoints as the Node server; tokens work across both servers with the same `JWT_SECRET`.
- **Honest status: written and exercised only with stubs (95 plain-Java tests + 6 conformance replays, all passing). Maven has never run; the controllers, the security filter and the JDBC stores have not run through Spring. The sign-in SQL ran on PostgreSQL 16 by hand. The Node server remains the tested reference.**

### Round 74: Spring ports e-voting, amenity messages and the amenity scheduler
- **E-voting.** The one-time code is now checked by the server (`POST /api/evoting/otp/request` and `/verify`, state in table `evoting_state`, migration `V6`), so a vote needs a code the server itself sent. Spring (`com.communityos.evoting`) and the Node reference both do it, and the voting screen calls them when a back end is in charge. Eligibility, the roll fingerprint, one vote per unit, single-use proofs and the sealed hash-chained ballot box are ported; 6 500 generated voting sessions (57 422 steps) give the same answers as the JavaScript (`npm run gen:evoting`). Set `EVOTING_DELIVERY=sms` before a real vote (`log` is the default, `echo` shows the code in the browser and is refused in production).
- **Amenity messages.** A booking now queues its e-mail / SMS / WhatsApp rows and rings the bell on the server, in the same transaction; daily and summary reports are built the same way. 12 000 generated operations (`npm run gen:amenity-notify`, India time zone) match the JavaScript.
- **Amenity scheduler.** Unpaid bookings are released, finished ones completed, day-before reminders and the daily / weekly / monthly reports go out, every `JOBS_INTERVAL_SECONDS` (300; `0` = off). Set the server's `TZ`.
- The comparison found one bug in the earlier booking port (a booking with no GST amount got GST columns on its ledger line); fixed. Writes are no longer fenced by `unported-hooks`: nothing is left to fence. Still not ported: late fees at pay time, payment receipt messages, field encryption, the other background jobs, OTP sign-in, ticket and approval notifications. Details and differences from Node: docs/BACKEND.md section 10.8.
- **Honest status: written and exercised only with stubs (71 plain-Java tests + 5 conformance replays). Maven has never run; nothing has run on PostgreSQL. The Node server remains the tested reference.**

### Round 73: Spring ports the money guard, poll votes and amenities
- `MoneyGuard`, `PollRules` and the amenity engine/rules/postings are now Java, proven equal to the JavaScript by replaying 144 000 money-guard cases and 18 000 amenity decisions (+2 632 postings) generated from the real code (`npm run gen:moneyguard`, `npm run gen:amenity`). Only writes to e-voting collections are still refused by default; its one-time-code proofs live in memory and need a message gateway, so it needs its own port.
- Not ported: amenity notifications and scheduler. Spring should run with the community's time zone set. Details and differences from Node: docs/BACKEND.md section 10.7.
- **Honest status: written and exercised only with stubs (58 plain-Java tests + 3 conformance replays). Maven has never run; nothing has run on PostgreSQL.**

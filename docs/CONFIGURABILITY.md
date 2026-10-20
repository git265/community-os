# What is still hard-coded (and would help other communities if it were configurable)

Found by reading the code (grep counts are from this build). Ordered by how often another community would hit it.
"Hook" = the extension point that already exists or is the natural place to add one.

| # | Hard-coded today | Why another community needs it | Hook / suggested fix | Effort |
|---|---|---|---|---|
| 1 | **₹ in 212 places across 56 files**; non-₹ communities see a symbol swap at render time, not real formatting | Any other country | Replace literals with `money()` (`lib/locale.js`); region already carries the currency | M |
| 2 | **"GST" / "GSTIN" wording** in amenity settings, billing screens, ticket/quotation tax fields (12 files) | UAE/UK = VAT, others differ | `region().tax.name` / `idLabel` (already used by bill text and receipts) | M |
| 3 | **Date format** `en-GB` in 48 places; browser time zone; Monday/Sunday week start | US, Gulf, other time zones | Add `dateFormat`, `timeZone`, `weekStart` to the region profile; one `fmtDate()` | M |
| 4 | **Language**: English only, strings inline in components | Non-English communities | i18n catalogue (react-i18next) + `locale` in region | L |
| 5 | ✅ **Done in Round 48.** Community setup → Lists → Shift types — was: **Shift definitions** (`SHIFT_TYPES`: Morning 06-14, Afternoon 14-22 ...) | Different shift patterns (12-hour, split) | Move to a `shiftTypes` setting row, same shape | S |
| 6 | ✅ **Done in Round 48.** Community setup → Lists → Amenity time slots (one list for all amenities; per-amenity slots not yet) — was: **Amenity time slots** (`SLOTS`: eight 1-hour slots) in the booking screen | Courts with 45/90-minute slots, different hours | Per-amenity slot template on the amenity row | S |
| 7 | ✅ **Done in Round 48.** Ticket categories editable in Lists (status flow and priorities are still fixed) — was: **Ticket categories / trades / priorities / status flow** (`TICKET_CATEGORIES`, fixed status names) | Different trades, different workflow | Lookup collection like utility types; status flow as data | M |
| 8 | ✅ **Done in Round 48.** Custom document groups with chosen roles in Lists (built-in six stay) — was: **Document groups** (`DOC_GROUPS`) and the Resident / EC / Staff / Vendor **role categories** | Different committee structures | Groups as data; categories stay, role list is already editable | M |
| 9 | **Committee structure** (President, General Secretary, Treasurer ... as default approvers) | Chair / Secretary / Board models | Approver settings exist; make the role names a template | S |
| 10 | ✅ **Done in Round 48.** Payment modes come from the country profile (`lib/region/paymentModes.js`); UPI QR only where `payments.upiQr` is set (India) — was: **Payment modes** (UPI, Card, Net banking, Cheque, Cash) and the UPI QR flow | UPI is India-only; others use ACH, SEPA, Interac | `region().paymentModes`; hide the UPI QR outside IN | S |
| 11 | **Phone validation** (Indian 10-digit) | Any other country | Use `region().phone` (dial code + digits) in `lib/phone.js` | S |
| 12 | **TDS / PAN / statutory tags** on contracts and ledger | Other withholding regimes | Make "withholding" a regional field group | M |
| 13 | ✅ **Done in Round 48.** Late-fee rules per bill type (Maintenance, Water, DG, Special levy, Amenity booking, Other, plus a default); tiered/compounding still not supported — was: **Late fee**: one rule for all bills (percent or fixed per month) | Per-category, tiered, compounding, grace by category | `lateFeeSettings()` → list of rules by category | M |
| 14 | **ID / receipt formats** (`DUE-`, `TKT-`, `RCT-`, `LED-` prefixes; receipt no. derived from bill no.) | Own numbering, per-FY series | `shortPrefix()` table + a receipt-number sequence setting | S |
| 15 | **Units of measure**: sq ft, kL, kW | Metric countries | Unit system in region profile | S |
| 16 | **Notification channels** (In-app, Email, SMS, WhatsApp) and providers | Other providers/channels | Channel registry like `registerGateway()` | M |
| 17 | **Ledger accounts and funds** (Sinking, Maintenance, Cultural ...) are seeded and editable, but several screens assume those names | Different chart of accounts | Look up by account *type* not name | M |
| 18 | **Module on/off per community**: hiding is by role/tab permission only; there is no community-level "we don't use Cultural" switch | Small communities | `enabledModules` on the community config, read by the nav | S |
| 19 | **Maintenance fee bases**: flat / per sq ft / per bedroom | Per-resident, tiered, by plot | Add bases to `BASES` + `chargeFor()` | S |
| 20 | **Receipt/statement layout**: one template (letterhead fields are configurable, layout is not) | Branding, logo | Logo upload + colour in Community setup | S |
| 21 | ✅ **Done in Round 49.** Accounts & budget: full amounts, deposits list, editable heads and statement rules, revised budget, fund targets | was: ₹-lakh fields, two FD columns, La Paloma head names and bank rules in code | — | — |
| 22 | ✅ **Done in Round 50.** Task types: full add/edit form, resident-request type is a setting, delete/rename guarded; schema no longer hard-codes names | was: add form had half the fields, `'Resident Maintenance'` hard-coded | — | — |
| 23 | ✅ **Done in Round 51.** Money rules (caps, locked payments, corrections) are enforced in one server-side module | — | Maker-checker on reversals; tolerance % per community | S |
| 24 | ✅ **Done in Round 52.** Infrastructure map: each community uploads its own plan (PDF/image, trimmed), adds or hides its own kinds of asset (pin / line / area), and positions are plan pixels so no scale is needed | was: equipment list with no position or health picture; asset types fixed in a select | GPS match of a plan, satellite tiles, criticality weighting, group-fault thresholds per community (30% / any fault are constants) | M |
| 25 | ✅ **Done in Round 53.** Infrastructure: each community draws its own boundary on its plan (placement is limited to it) and can align the plan on satellite imagery from a tile address it chooses (`infraPlans.boundary / geoRef / satelliteUrl / satelliteCredit`). No provider is built in. | was: nothing stopped a pin landing anywhere; the plan was never tied to a real map | Pending: repeat the boundary check in the API; three-point GPS alignment, "you are here" | S |
| 26 | ✅ **Done in Round 55.** Reports and event work: a community schedules any report (bookings, dues, payments, water, tasks, audits, infrastructure, event work) with its own format, frequency, delivery channels and audience (roles, people, villas); event work has owners (Facility Manager / MEP), staff kinds and phases. | Was: only the Amenities daily report existed, and event preparation lived in WhatsApp. | Pending: Spring Boot cron for unattended runs and a real e-mail / WhatsApp / SMS gateway; report definitions are code (`lib/reports/catalog.js`). | S |
| 27 | ✅ **Done in Round 58.** Event brochures (pages with pictures, published to residents), community details and receipt / statement wording with live preview, GST registered or not (one tax number everywhere), audit details limited to EC and audit-log roles. | Data (new `culturalBrochure` collection; fields on `communityConfig`) | No code change to publish a brochure or change what receipts say. |

## Already configurable (so nobody rebuilds it)
Country profile · currency symbol and number grouping · FY start month · property types · letterhead, registration and tax numbers ·
receipt footer · file storage provider · payment gateway per region · late-fee rule · reminder cadence · notice templates and merge fields ·
roles and permissions · tab visibility per role · approval plans and thresholds · utility types · maintenance fee rules · amenity rates, deposits, tax and cancellation tiers ·
notification events per channel · site holidays and services · event sections per event (Offerings, Donations, Photos ...).
| 28 | Service notices, outage guard mode, asset spec lists, people per villa, brochure publish channels | Notification settings (service_notice, brochure), Infrastructure kinds, Event/Programme fields |
| 29 | Site map (Leaflet) page replaces the Infrastructure page | Page access: Site map (tabs Map / Health board / All assets / Plans & layers); plans, kinds, conditions as before; satellite alignment removed |
| 30 | Asset "Kind of repair", fixed asset name, Site map task links, gateway-only online credits | Schema field + authz |

## Security & Visitors (Round 61)
Configurable in the Rules & alerts tab (one `gateSettings` row): approval wait, fallback, quiet hours, ghost grace window, overstay grace, expected durations per visit kind, approved delivery companies, notification matrix. Per villa: delivery mode, away mode, fallback. Still hard-coded: gate names, person classes, vetting checklist items, flag types and the expected-duration defaults in `lib/gate/constants.js`.

## Round 62 additions
Important numbers (`importantNumbers`, edited in place by staff) · amenity reservation mode, advance window, override roles, limits, blackout dates, unit types (Amenity rates → Booking rules) · categories, sub-categories, assets, facilities and inventory are all ordinary rows the community edits · gate: guard silence minutes (Rules) · registry freshness thresholds (60 days unseen, 365 days re-vet, 180 days villa confirmation) are constants in `lib/gate/idcheck.js`.

### ID automation: what is and is not possible
- Offline, built in: format and checksum (Aadhaar Verhoeff), duplicate numbers, expiry dates, last-4 masking.
- Needs an external service: confirming an Aadhaar or licence is real and matches the face or name. Routes: UIDAI through an authorised KUA/AUA, DigiLocker (the person shares documents with consent), or a background-check vendor's API (police verification, address). The swap point is `lib/gate/idcheck.js`; the registry only needs a "verified by" result.
- Do not store full Aadhaar numbers. The system keeps only the last four digits and a salted hash.

## Round 63 additions
Gate Rules: kiosk on/off, what to do about extra people on a goods pass, least seconds between patrol scans, the pass message wording. Patrol checkpoints and rounds are ordinary rows edited in Security → Patrol. Pass templates are rows: a villa keeps its own, staff keep the community ones. Regular goods vehicles are Vendor plates with "regular goods vehicle" and usual people on the Gate vehicles list.

## Round 64 additions
Tab switches for Community setup and Notifications; gate events in Channel settings; "Also tell (roles)" per notification event (stored as notificationSettings.events[event].alsoRoles). Collection-to-permission mapping stays in code. Saving notification settings is guarded in the UI only, not by the storage layer.

## Round 65 additions
Tax split: GST limit settings and per-category treatment, rate and account are data (taxSettings, taxComponents) editable by Super Admin, Treasurer and President; tab id billing.taxsplit.

## Round 66
Super Admin manages: Important-number sections, committee roles, tax split, vendor service lines, and the daily input-credit check (Billing → Input credit, or Tax split). Plug a real GST service provider in with `registerGstGateway()`.

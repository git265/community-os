# CommunityOS API v2 — redesign

`backend/api` is a new Spring Boot service (Spring Boot 3.5.16, Java 25) with a new PostgreSQL 18 schema. Every object has its own table. The web app talks only to this service, through typed `/api/v1` endpoints.

It sits beside the r76 services (`backend/contract-server`, `backend/spring`) and does not change them. The app reaches it through a third data-source mode, **Back end v2**.

Status:

- **Built and checked:** the schema, plus one slice of the service, end to end. The slice covers:
  - sign-in;
  - units;
  - members (users);
  - bills;
  - payments, with the ledger, audit, outbox and webhooks.
- **Not built yet:** every other module. It has its tables (V6), but no endpoints yet (§11).

---

## 1. Sizing target and what was measured

The target is 100 communities with 1,000 units each. The synthetic load (`src/test/sql/load_data.sql`) holds:

| Object | Rows |
|---|---|
| Units | 100,000 |
| Bills (12 months) | 1.2 M |
| Tickets | 100,000 |
| Notifications | 2 M |
| Gate entries | 1 M |

The load takes about 9.5 minutes.

Timings, measured as the API role with row-level security on, inside one community:

| Query | Time |
|---|---|
| A resident's bills, using the adapter's own SQL and access rule | 0.6 ms |
| The treasurer's open bills, page 1 of 2,000, with the total count | 9 ms |
| Units, page 1 of 1,000 | 1.4 ms |
| The hot queries in `query_bench.sql` (bell, queues, gate today, month collection) | 0.04–0.9 ms |

## 2. Database

### Layout

The database has one schema per bounded context:

- `platform` — communities, settings and counters
- `identity` — people, memberships, roles and sign-in
- `property` — blocks, units and occupants
- `billing` — bills, orders, payments, allocations and unit credit
- `finance` — chart of accounts, funds, journal and period lock
- `audit` — the append-only audit trail
- `integration` — outbox, inbound dedupe, idempotency, API clients and webhooks
- module schemas: `maintenance`, `amenity`, `gate`, `comms`, `governance`, `cultural`, `workforce`, `assets`, `docs`, `vendor`, `reports`, `config`

In total there are 156 tables. 150 of them are tenant tables.

### Migrations

| File | What it creates |
|---|---|
| V1 | Roles, schemas, request context, stamping triggers, short numbers |
| V2 | Identity |
| V3 | Property |
| V4 | Billing and the double-entry ledger |
| V5 | Audit and integration |
| V6 | 113 module tables, generated from the r76 field schemas by `tools/gen-module-tables.mjs` |
| V7 | Notifications, field definitions |
| V8 | Monthly partitions and retention |
| V9 | Security for every tenant table (`platform.apply_security()`) |
| V10 | Permissions and per-community provisioning, generated from `roles.js` |
| V11 | Maintenance in its typed shape: tickets point at their task type, unit, raiser and assignee by id; status, priority, scope, rating and cancel reason are checked; comments have a visibility; field staff are members. Default task types, quick phrases, category coverage and final approvers for every community. |
| V14 | Gate: every state checked (visit, approval, pass, person, flag, link, work order, vehicle, incident); text times became timestamps and settings JSON; a pass code is unique among live passes; one gate rule per unit, one settings row (`provision_gate`, with a secret for staff badges); invited-by and answered / resolved / scanned by are ids. |
| V15 | Notices, notifications, forum: the inbox row carries its kind and what it is about; the channel queue has its addressee, words, attempts and a checked status (Queued / Sent / Failed / Skipped); a notice's type, audience, status and reminder are checked and a sent one has its time; a receipt per person (delivered, viewed, signed) replaces the signed-by text; one poll vote per unit (or per person without a unit, or per person on a forum poll); forum titles and posts checked, a hidden post keeps a reason; one channel choice row per member and one settings row per community (`provision_comms`, with the emergency numbers and merge fields). |
| V16 | Documents and files: a file is uploaded (owned by its uploader, attached to nothing) and then attached to exactly one ticket, comment, quotation, booking or document (checked kinds); its uploader is an id; folders have a name, are never their own parent and are unique by name in a parent; `docs.folder_open()` applies role limits up the folder chain; a document has a title, a reader group, its unit when it is a villa document, a version label and one file. |
| V17 | Cultural events and donations: event, programme, seva, offering, brochure, photo and expense states checked; sign-up lists are JSON arrays the server writes; a fixed offering is held by one pledge; a donation is Received exactly when it has a receipt number (unique in the community) and a time, and points to its payment; an approved or paid expense has its amount, a paid one its time; the budget credit only on a completed event; accounts 4400 Donations and 5100 Event expenses (`provision_cultural`); files may belong to a photo or a brochure page. |
| V18 | Finance beyond bills: cash book entries are money in or out above zero with taxes checked, matched only with a bank line, reversed once and with a reason; journal source `cashbook`; a release is on a task or an event expense, paid exactly when it has its time; a pay request's status checked and never decided by its requester; bank lines go one way and are imported once (a content hash); funds, budgets, deposits, cash counts and fixed expenses checked; accounts 1300 Input GST, 2150 TDS payable, 4900 Other income and three starter funds (`provision_ledger`). |
| V19 | Governance: a meeting's status, visibility and times checked, a published meeting has its publishing time, a cancelled one no minutes; its papers are attached files (`governance.agenda`, `governance.minutes`). E-voting: a ballot is Draft → Open → Closed and nothing about an open one's question, options, dates or roll can change (trigger); the frozen roll (`ballot_elector`), the marks (`vote_roll`, one per unit) and the box (`ballot_box`: no unit, person, time or stamp; a hash chain whose head and count are kept on the ballot) are never changed or deleted; the box is written only while open and read only once closed (a restrictive row policy, for the API role too); the second factor's codes (`vote_challenge`: an HMAC, 3 tries, a hashed single-use proof). |
| V20 | Vendors: one vendor per name, category and contract from the lists, a GSTIN and e-mail that look right, papers as attached files (`vendor.vendor`); a service line names its vendor by id; a discussion comment is on a vendor and never empty; the directory: a hidden contact records who hid it, from which unit a contact was added; a review is 1-5 stars, one per person and one per household. |
| V21 | Assets: one asset per name with a condition from the list (no more faulty than there are); stock never below zero, changed only by movements (`inventory_movement`: received / issued / counted with the balance after, kept for good); one plant log a day with meters that do not run backwards; a DG refill buys litres; a bill per service and period, paid with a date; one row per unit and month of villa electricity; an audit's result, score and visibility checked; the condition log (who is the server's) and the map history are kept as written; papers are attached files (`assets.*`). |
| V13 | Amenities: unique, checked amenity types (rates, GST, limits, JSON cancellation tiers, own slots); items and bookings point at their amenity by id; a booking carries its whole money life (price, deposit, the policy it was booked under, payment, refund, deposit settlement), each state checked. Payments open to bookings and donations: allocations have a target, a prepayment is claimed once, unit credit has new kinds; accounts 2200 Security deposits held and 2400 Refunds payable (`provision_amenities`). |
| V12 | Money on tasks: quotations / invoices always belong to a ticket, with checked kinds, GST modes, amounts and approval slots; the ticket's money summary is checked; releases have a checked status (and a reason when cancelled); approval rules have unique names and valid ranges; finance settings and approver lists are one row per community (`provision_finance`); wishes, service notices and event work have checked statuses. |

### Tenancy

Every tenant row carries `community_id`. The primary key is `(community_id, id)`, and so is every foreign key, so a row can never point into another community.

**Row-level security** is forced on every tenant table. The policy is `community_id = app.community_id`. `TenantDataSource` sets `app.community_id` and `app.user_id` on every connection from the caller, and clears them when the connection goes back to the pool. If no caller is set, no row is visible (fail closed).

### Roles

| Role | Used for | Row-level security |
|---|---|---|
| `cos_app` | The API's requests | Applies |
| `cos_platform` | Sign-in, provider webhooks, the outbox and webhook workers | Bypassed (`BYPASSRLS`) |
| `cos_readonly` | Reporting | Read only |

The sign-in tables are not visible to `cos_app` at all. Neither runtime role can change the schema.

### Values the client cannot set

These values are set by the database, whatever a request sends:

- `created_*`, `updated_*` and `version`, stamped by a trigger;
- `id` and `community_id`, which never change;
- short numbers (`DUE-0007`), which are given once and never change.

The audit trail is insert-only. Payments and journal lines cannot be deleted by the API role.

### Money

Money is stored as `numeric(14,2)`, with CHECK constraints:

- a paid amount is never more than the total;
- a bill marked Paid is fully settled;
- a cancelled bill has a reason.

The journal is double-entry:

- a deferred trigger refuses an unbalanced entry at commit;
- a posted entry is immutable;
- the period lock refuses back-dating.

### Extensibility

Each object has typed columns plus a `custom jsonb`. The keys allowed in `custom` are defined per community in `config.field_definition` (type, options, required, edit roles). The API checks each value against its definition (`CustomFields`). An unknown key is refused, not silently dropped.

### Time-series tables

Audit, notifications, gate visits and scans, and the outbox are partitioned by month (V8 `ensure_partitions` / `drop_partitions_before`).

## 3. Service layout (hexagonal)

The source is under `com.communityos.api`:

```
shared     kernel: Money, typed ids, Caller, Spec, GuardChain, resilience, events/outbox, audit, idempotency, custom fields,
           JSON, problem+json errors, tenancy, HTTP transport, crypto
identity   domain (Phone, OtpChallenge, RefreshToken, MemberView) · application (AuthService, MemberService, MemberPolicy, ports) ·
           adapter (JDBC stores, CallerLoader, JWT issuer, OTP senders) · web (AuthController, MemberController, DirectoryController)
property   Unit aggregate · UnitPolicy, UnitService · JdbcUnitRepository · UnitController
billing    Due, PaymentOrder (state machines), Journal, events · DuePolicy, DueService, PaymentService, Settlement (+ Gateway / Counter),
           LedgerPoster, PaymentGateway + registry · JDBC repositories, Razorpay + simulated gateways · controllers
maintenance  Ticket, TicketStatus, Quotation · TicketPolicy, TicketRules, TicketService, QuotationService, FieldStaffService, WishVotes ·
           JDBC (tickets, quotations + the task's money position, directory) · TicketController, QuotationController · MaintenanceResources
amenity    AmenityType, Pricing (price, GST, window, limits, cancellation tiers, add-ons), Booking (its money actions) · BookingPolicy, BookingService,
           AmenityLedger · JDBC (bookings, catalog) · BookingController · AmenityResources
gate       Gate (windows, quiet hours, passes, the visit's states, settings, people, links, crews) · GatePolicy, GateService (passes, the desk,
           approvals, the registry at the gate, deliveries, goods, flags, patrols, the minute sweep) · JDBC (store, directory) · GateController · GateResources
comms      Comms (messages and their audience, notices, polls, topics, posts) · CommsPolicy, Recipes (what to tell whom per event), Notifier (an
           observer of every domain event), InboxService, BroadcastService (drafts, sending, receipts, polls, the schedule), ForumService · JDBC
           (inbox + facts, store) · CommsController · CommsResources
docs       FileRules (types from the bytes, signatures, active content, EICAR), StoredFile, Document · DocsPolicy, FileService (upload, attach, read by the
           owner's rule, delete), DocumentService, ports FileStorage / VirusScanner · LocalDiskStorage, JDBC (files, documents) · DocumentController ·
           DocsResources (folders); config/FileKinds says what files attach to and asks each module's own read rule
cultural   Cultural (events' receipt code, limits and unused budget, donations, expenses mirroring their plan, sign-ups) · CulturalPolicy, DonationService
           (pledge, record, receive, paid online, withdraw, offerings), ExpenseService (approval plan, pay, budget credit), SignupService · JdbcCulturalStore ·
           CulturalController · CulturalResources (events with computed totals, programme, seva, offerings, brochure, photos)
finance    Books (cash book entry with GST / TDS and its journal lines and reversal, release, pay request, bank line) · FinancePolicy, CashBookService
           (record, the approval limit, closed books, reversal, corrections), ReleaseService (within the task's / expense's open amount, approval plan, pay,
           cancel), PayRequestService (second approver), BankService (import once, match, unmatch) · JdbcFinanceStore · FinanceController ·
           FinanceResources (approval rules, settings, funds, bank accounts, budgets, fixed expenses, deposits, cash counts, import layouts, skips, own bills, chart)
governance Governance (meeting, ballot, elector, the roll fingerprint, the box chain, the count) · GovernancePolicy, MeetingService (publish, move, cancel,
           minutes after the meeting, residents told), BallotService (draft, open = freeze the roll, close = check the box, roll, box), VoteService (the code to the
           owner's mobile, the proof, the cast) · JdbcGovernanceStore · GovernanceController
vendor     Directory (contact, review) · VendorPolicy, DirectoryService (own entries, moderators hide with a reason, one review per household, ratings worked out)
           · JdbcDirectoryStore · DirectoryController · VendorResources (the vendor register with its service lines and workers, service lines, the discussion)
assets     AssetPolicy, AssetService (movements: never below zero, the low-stock notice; the condition log moves the asset's condition) · JdbcAssetStore · AssetController ·
           AssetResources (equipment with a fixed name, stock, import rules, plant / DG logs and bills with their worked-out values, villa electricity, audits with the next
           due date, custom log types and entries, site plans, map layers, the map history, the condition log to read)
billing    (also) BillingDesk - the facade other modules use: unit credit, prepayments, office receipts, the ledger; TargetSettlement
approval   Plan (steps, decisions, the two slots), Policy (rules -> plan) · Approvers (who may decide), ApprovalSettings port · JdbcApprovalSettings
shared.resource  the resource kit: ResourceTable (record -> SQL), ResourceRules (strategy per resource), JdbcResourceRepository,
           ResourceService, ResourceRegistry, ResourceController (/api/v1/{module}/{resource}), Checks
config     DataConfig (two pools), SecurityConfig, AuthConfig, ModulesConfig, ResourcesConfig, CoreConfig, Jobs, CosProperties
```

**Two kinds of module code.** A *workflow* (tickets, quotations and their approvals, bills, payments, and in later modules bookings, gate visits,
e-voting ...) has its own aggregate, rules, service, repository and controller. A *register* (task types, categories, wishes, approval rules,
settings, and most of the 150 tables) is a **resource**: a Java record that lists exactly the fields a caller may send, a `ResourceRules`
(who reads - as a `Spec` -, who writes, which rows a caller may change, how a record is checked and normalised, whether it may be deleted), and a
`ResourceTable` that names the table. Columns only the server writes (who created it, a status a workflow moves, a vote list) are *server
columns*: returned read-only, set on insert from SQL (`platform.current_actor()`), never read from the body. The kit gives every resource the same
list / get / create / replace / delete with versions, audit and an outbox event, and the SQL check runs every statement it can send.

The domain and application layers have no Spring imports. They depend on ports, and `Tx` is one of those ports. Use cases are therefore tested with in-memory adapters, and the same classes run against PostgreSQL in the flow test.

Persistence uses explicit SQL on `NamedParameterJdbcTemplate`, with no ORM. Every statement is a constant, or is composed by a public `listSql` / `getSql` method, so it can be checked against the database (§10).

### Design patterns

| Pattern | Where |
|---|---|
| Specification | `Spec` — one access rule, as both a SQL predicate and an in-memory predicate (deterministic parameter names) |
| Strategy | `AccessPolicy` (`UnitPolicy`, `DuePolicy`, `MemberPolicy`), `PaymentGateway`, `OtpSender`, `EventPublisher` |
| Chain of Responsibility | `Guard` / `GuardChain` |
| State | `DueStatus`, `OrderStatus`: each state lists where it may go; final states are final |
| Template Method | `Settlement.settle()`: verify → idempotency → lock → record and allocate → hook → events and audit; `JdbcResourceRepository` (the same JDBC steps for every resource) |
| Strategy (2) | `ResourceRules` per register; approval `Policy` rules joined into one `Plan` |
| Observer | `DomainEvents` → in-process handlers (`LedgerPoster`), in the same transaction, then the outbox |
| Factory / Registry | `GatewayRegistry`, `Due.raise`, `PaymentOrder.price` |
| Decorator | `Resilient` (timeout + circuit breaker + retry around a call); `TenantDataSource` around the pool |
| Adapter | JDBC repositories, `RazorpayGateway`, `JdkHttpTransport`, `CallerJwtDecoder` |
| Aggregate root / value object | `Due`, `PaymentOrder`, `Unit`; `Money`, typed ids |

## 4. Sign-in and the bearer token

The flow has four steps:

1. **`POST /api/v1/auth/otp {phone}`** — the code is sent to the phone. Only an HMAC of the code (with a server pepper) is stored. An unknown number gets exactly the same answer, and nothing is sent. Rate limits apply per IP and per phone, in a table, so they hold across instances.
2. **`POST /api/v1/auth/token {challengeId, code, communityId}`** — returns an **ES256 JWT** valid for 10 minutes, and a **refresh token** valid for 30 days.
   - The code allows 5 tries. Every guess is committed before the comparison.
   - Of two simultaneous correct submissions, only one wins.
   - A person in several communities without a `communityId` gets the list of communities.
3. **`POST /api/v1/auth/refresh`** — rotating. A spent token used again revokes the whole family, which signs out both the device and whoever copied the token.
4. **`POST /api/v1/auth/logout`** — revokes the family.

**Where the refresh token lives.** Web clients get it only as an `HttpOnly; Secure; SameSite=Strict` cookie on `/api/v1/auth`. Mobile clients (`"client":"mobile"`) get it in the body and keep it in the OS keystore.

**Token claims.** The token carries `sub` (person), `cid` (community), `mid` (membership), `iat`, `nbf`, `exp` and `jti`. It does not carry roles.

On every request, `CallerJwtConverter` loads the member's current roles, permissions, units and blocks in one query (`JdbcCallerLoader`, cached for 30 s). A deactivation or role change therefore takes effect within seconds, not when the token expires.

**Verification** refuses:

- any algorithm except ES256 (so no `none` and no HS256 key confusion);
- an unknown `kid`, or a `jku` / `jwk` / `x5u` / `crit` header;
- a wrong issuer or audience;
- an expired token (30 s skew).

**Key rotation.** Several public keys can be accepted at once (`cos.auth.previous-keys`), so the signing key can be rotated without signing anyone out.

## 5. Authorization and tamper safety

These checks are in layers, and each one holds on its own:

1. **Request bodies are DTO records with exactly the fields a client may send.** Jackson fails on any unknown property, so `createdBy`, `status`, `paidAmount`, `total`, or an `amount` on a payment order, gives a 400. Money is a decimal string with at most 2 decimals.
2. **The caller is built by the server** from the verified token and the database (`Caller`). Nothing in the body or headers names the community, role or unit.
3. **Access policies** are applied in the repository's `WHERE` clause for reads, and checked on the loaded row for writes:
   - a resident sees and pays only their own units' bills;
   - utility clerks see utility bills only;
   - block-limited staff see their blocks only;
   - another unit's record answers 404, not 403.
4. **Row-level security** is the floor beneath the access policies: a bug in a policy still cannot cross communities. The flow test checks this by reading another community's bill directly by id.
5. **Optimistic versions.** A GET returns `ETag: "<version>"`, and a change must send `If-Match`. Saves use `WHERE version = :v`, so a stale edit gives 409 instead of a lost update.
6. **No privilege escalation.** A member manager can give or take only roles whose permissions they hold. Only the Super Admin touches the Super Admin role. Nobody changes their own roles.
7. **Server pricing.** A payment order is priced from what is owed on the bills now. The amount recorded is the provider's own record of the payment, fetched server to server. The payment must belong to that order, and the checkout signature is checked.
8. **Signed inbound calls.** A webhook's signature is checked on the raw body before anything is read. A forged one gives 401, and nothing changes.

Errors are RFC 9457 problem+json with a stable `code`. A 500 carries only an error id; SQL and stack traces stay in the log.

## 6. Data integrity

- **One transaction for a change and everything that follows from it:** for example the bill, its ledger entry, its outbox event and its audit line. If any of them fails, nothing is written.
- **Settlement:**
  - bills are locked `FOR UPDATE` in id order, so there are no deadlocks;
  - the oldest bill is paid first;
  - the rest goes to unit credit, so it is never lost and never refused.
- **The same provider payment is recorded once** (unique key). If the app's confirm and the webhook race, the second one returns the first one's receipt.
- **Idempotency-Key** on `POST /dues`, `/members` and `/payments`:
  - the same key with the same body replays the stored answer;
  - the same key with a different body gives 422;
  - while the first request is still running, a second gives 409.
- **Bills are never edited.** A bill is cancelled (only if nothing has been paid) or waived, always with a reason. A correction is a new bill.

## 7. Network latency, retries and resilience

| Concern | What the service does |
|---|---|
| Slow provider | Every outbound call goes through `Resilient`: SMS 3 s × 2 attempts, Razorpay 8 s × 3 attempts. After 5 consecutive failures the circuit breaker opens for 30 s and calls fail fast with 503 `provider-unavailable`. |
| Retry storms | Exponential backoff with **full jitter**, and only for transient failures (timeouts, IO, 5xx, 429). A 4xx or a business refusal is never retried. |
| Held connections | Provider calls run **outside** database transactions; `createOrder` commits, calls Razorpay, then commits again. Pools have about 20 connections and a 3 s connection timeout. Statements time out at 15 s, and idle-in-transaction at 30 s. |
| Threads | Java 25 virtual threads (`spring.threads.virtual.enabled`). |
| Round trips | The caller loads in one query; lists return their total via `count(*) OVER ()`; pages are capped at 200. |
| Payload | gzip for JSON over 2 KB, HTTP/2, ETag. |
| Missed webhooks | The `reconcile` job asks the provider about orders that are still open, then settles them or expires them. |
| Client side | `net/request.js` (unchanged) retries reads twice, and repeats a keyed write once after a network drop. It renews the token once on 401. |

Every job can run on several instances at once:

- rows are claimed with `FOR UPDATE SKIP LOCKED` and leased;
- settlement is idempotent.

So no leader election is needed.

## 8. Future integrations

- **Transactional outbox.** Events are written in the business transaction. `OutboxRelay` delivers them at least once, with backoff, and marks one Dead after 10 tries. Consumers de-duplicate on `event_id`.
- **Outgoing webhooks.** `WebhookFanout` creates one delivery row per subscription, so a slow receiver delays only itself. `WebhookDeliveryWorker` sends:
  - `X-CommunityOS-Event-Id`;
  - `X-CommunityOS-Timestamp`, which receivers should refuse when older than 5 minutes;
  - `X-CommunityOS-Signature: v1=HMAC_SHA256(secret, timestamp + "." + body)`.

  It retries 5xx, 429 and timeouts up to 12 times, and gives up on any other 4xx. Secrets are referenced by name (`SecretResolver`) and never stored.
- **A message broker** (Kafka, SQS, Service Bus) is another `EventPublisher`. Modules do not change.
- **A new payment provider** is a `PaymentGateway` (create order, fetch payment, payments of an order, verify checkout, read webhook) registered in `ModulesConfig`.
- **Inbound events** are de-duplicated in `integration.inbound_event`. An event is marked processed only after its work commits, so a failure is retried on the provider's next delivery.
- **Partner access.** `integration.api_client` (scopes, IP allow-list, hashed secret) is in the schema, ready for machine-to-machine access.

## 9. API (slice)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/public/health` | Public |
| GET | `/api/v1/public/communities/{slug}` | Public: id, name and status for the sign-in page |
| POST | `/api/v1/auth/otp` · `/auth/token` · `/auth/refresh` · `/auth/logout` | Public, rate-limited |
| GET | `/api/v1/me` | The caller as the server sees them |
| GET | `/api/v1/roles` | Shapes the menus only; the server decides every call |
| GET / PATCH | `/api/v1/units`, `/units/{id}` | Filters: `q`, `block`, `occupancy`, `archived`, `limit`, `offset`. PATCH needs `If-Match`. |
| GET / POST | `/api/v1/members`, `/members/{id}` | POST takes `Idempotency-Key` |
| PUT | `/api/v1/members/{id}/roles` | Needs `If-Match` |
| POST | `/api/v1/members/{id}/deactivate` | Needs `If-Match` |
| GET / POST | `/api/v1/dues`, `/dues/{id}` | Filters: `unit`, `status`, `open`, `from`, `to`, `category`. POST takes `Idempotency-Key`. |
| POST | `/api/v1/dues/{id}/cancel` · `/waive` | `{reason}` + `If-Match` |
| POST | `/api/v1/payment-orders` | `{dueIds}`; `Idempotency-Key` is required |
| GET | `/api/v1/payment-orders/{id}` | |
| POST | `/api/v1/payment-orders/{id}/confirm` | `{providerPaymentRef, signature}` |
| POST | `/api/v1/payments` | Office receipt (cash, cheque or bank transfer); `Idempotency-Key` |
| POST | `/api/v1/webhooks/{provider}` | Signature-checked; always 200 once handled |
| POST | `/api/v1/dev/simulated-checkout/{ref}` | Only when `cos.payments.simulated.enabled=true`; refused in prod |
| GET / POST | `/api/v1/tickets`, `/tickets/{id}` | Filters: `status`, `active`, `category`, `unit`, `mine`, `assignedToMe`, `q`. POST takes `Idempotency-Key`. |
| PATCH | `/api/v1/tickets/{id}` | Field changes, checked field by field for the caller's role; `If-Match` |
| POST | `/api/v1/tickets/{id}/assign` · `/status` | `{assigneeId}` / `{status, reason}`; `If-Match` |
| POST / DELETE | `/api/v1/tickets/{id}/me-too` | A resident adds or removes their unit on a community request |
| POST | `/api/v1/tickets/{id}/rating` | 1–5, by the resident, once the work is done |
| GET | `/api/v1/tickets/{id}/assignees` | Who this ticket may be given to |
| GET / POST | `/api/v1/tickets/{id}/comments`, GET `/api/v1/ticket-comments` | Internal comments are never sent to residents |
| GET | `/api/v1/task-types` | The task types the caller may raise |
| GET / POST | `/api/v1/tickets/{id}/quotations`, GET `/api/v1/quotations`, `/quotations/{id}` | A quotation or invoice as written on it (`kind, vendor, amount, gstMode, gstRate, quoteDate, note`); the server computes GST and totals, builds the approval plan from the community's rules, and flags an invoice over its approved quotation. Not for residents. |
| POST | `/api/v1/quotations/{id}/select` · `/decision` · `/send-back`, DELETE `/quotations/{id}` | `If-Match`. A decision is `{value: Approved \| Rejected \| Pending (undo), comment, finish}`, checked against the waiting step, the approver, once per person, and (if the community keeps them separate) never one's own request. An approved invoice is sent back only while nothing is paid on it; it is never deleted. |
| GET | `/api/v1/tickets/{id}/money` | The task's money position: basis (invoice / quotation), cap, released, paid directly, committed, remaining, open releases. A financial task closes only when no release is open, and is cancelled only when nothing is committed. |
| POST | `/api/v1/payment-orders` | (also) `{purpose: booking \| donation, unitId, amount}`: a prepayment. Once paid, its money is the unit's credit until one booking claims it (`prepaymentId`); the order then reports its `paymentId`. |
| GET / POST | `/api/v1/amenities/bookings`, `/amenities/bookings/{id}` | A booking is `{amenityTypeId, unitId, date, slot, paymentMode, prepaymentId, useCredit, bookedFor, association, freeOfCharge, waiveReason, extras {itemId: qty}}`; the server locks the amenity, checks capacity, the window, per-unit limits and overdue dues, prices it, and takes the payment (credit, prepayment, office) in the same transaction. Residents see their own. |
| GET | `/api/v1/amenities/availability?amenityTypeId&from&to` | How full each date / slot is and the add-on items held there - no names or units |
| POST | `/api/v1/amenities/bookings/{id}/cancel` · `/payment` · `/refund-paid` · `/refund-to-credit` · `/complete` · `/deposit` · `/deposit-paid` · `/fee` | Each with `If-Match` and its own request type. Refunds follow the tiers the booking was made under; the deposit always comes back on cancelling; every step posts the ledger (receivable, amenity income, GST, deposits held, unit credit, refunds payable, bank). |
| GET / POST | `/api/v1/gate/passes`, POST `/gate/passes/{id}/cancel` | A unit's own passes; the server makes the 6-digit code; dates, days, hours and the guest cap decide whether it opens |
| GET / POST | `/api/v1/gate/passes/search?q`, `/gate/passes/{id}/admit`, `/admit-goods` | The desk (security team): look up by code or name with why it would not open; goods are admitted with a head count (extra people held, or let in with a reason and flagged) |
| POST | `/api/v1/gate/visits/ask` · `/delivery` · `/override`, `/gate/visits/{id}/admit` · `/ask-again` · `/refuse` · `/exit` · `/exit-goods`, `/gate/people/{id}/admit` · `/exit` | The desk's commands. Asking waits for the unit (the FM for the common area) with the unit's or the quiet hours' fallback; a hand-opened gate or an override is always a flag; the vetted registry decides people (blocked, documents expired, household window, crew roster, delivery rule) |
| GET / POST | `/api/v1/gate/approvals`, `/gate/approvals/{id}/answer` | `{decision, always}` by the unit; the first answer wins; "always" leaves a standing pass or allows the delivery company |
| GET / POST | `/api/v1/gate/flags`, `/gate/flags/{id}/resolve`; GET / POST `/api/v1/gate/scans`; POST `/gate/beat` | Flags and patrols for the security team and the committee; a scan needs the checkpoint's current code and a gap since the last one. A job every 30 s applies unanswered approvals' fallbacks, raises overstays and closes forgotten pass visits. |
| POST | `/api/v1/maintenance/wishes/{id}/vote` | `{vote}`: one vote per member while the wish is open |
| GET / POST / PUT / DELETE | `/api/v1/{module}/{resource}[/{id}]` | The registers of every module (resource kit). POST takes `Idempotency-Key`; PUT (the whole record) and DELETE need `If-Match`. List filters where a resource has them (`?eventId=`). `GET /api/v1/meta/resources` lists each resource with the fields its request type carries. |
| | cultural: `events` (with collected / pledged / households / spent worked out from the rows), `programme`, `seva`, `offerings`, `brochure`, `photos`; documents: `folders` (may be limited to roles; the limit holds below); comms: `important-numbers`, `number-sections`, `merge-fields`, `notice-templates`, `notification-templates`, `notification-prefs` (a member's own), `notification-settings` (one row: per kind of notification the channels offered and the roles also told), `outbox` (read-only); gate: `people` (residents only invite for their unit; vetting is the security team's), `household-links`, `unit-rules`, `pass-templates`, `vehicles`, `work-orders`, `checkpoints` (the server makes the code), `rounds`, `incidents`, `settings`; amenities: `types`, `items`, `settings`; maintenance: `task-types`, `categories`, `quick-phrases`, `approver-settings`, `wishes`, `service-notices`, `event-work`, `trade-availability`; finance: `approval-policies`, `settings`, `funds`, `bank-accounts`, `budget-lines`, `fixed-expenses`, `deposits`, `cash-counts` (the difference is worked out), `import-profiles`, `ledger-skips`, `association-bills`, `accounts` (the accounts the server posts to keep their code and kind) | |
| GET / POST | `/api/v1/notifications[?unread]`, `/notifications/unread-count`, `/notifications/{id}/read`, `/notifications/read-all` | The caller's own inbox. Rows are written by the server in the transaction of what happened (a recipe per event: tickets, quotations, bills, payments, bookings, the gate); never to the person who did it; plus a queued WhatsApp / SMS / e-mail message for each channel the person chose and the community offers for that kind (`Skipped` without an address). |
| GET / POST / PUT / DELETE | `/api/v1/comms/broadcasts[/{id}]`, `/reach`, `/{id}/send` · `/schedule` · `/reschedule` | Notices by the committee: a draft is created, edited (`If-Match`), sent now or at a time (a job every minute sends the due ones); the server works out who it reaches (a receipt per person) and fills their inboxes. A sent notice is not edited or removed; a maintenance window can move, and everyone it reached is told. |
| POST / GET | `/api/v1/comms/broadcasts/{id}/view` · `/sign` · `/vote` · `/results` · `/voters` | A reader opens, signs (when asked) and answers the poll - one answer per unit, changeable until it closes; the counts are for all, who voted what only for the committee. |
| GET / POST / PATCH / DELETE | `/api/v1/comms/forum/topics[/{id}]`, `/topics/{id}/posts` · `/vote` · `/results`, `/comms/forum/posts/{id}` · `/hide` · `/react` | Members start topics and reply as themselves; the author edits their own words (a title only before any reply); moderators pin, close, hide with a reason and remove; the reply count is the server's; the topic's author (and the replied-to) are told. |
| POST / GET / DELETE | `/api/v1/files?name=` (the bytes as the body), `/files?ownerType&ownerId`, `/files/{id}`, `/files/{id}/content`, `/files/{id}/attach` | Upload: the type is worked out from the bytes (signature, no scripts or macros, no test virus; a scanner port for ClamAV); the key is the server's. Then attach to one thing (only by its uploader, to something they may change). Opening follows the thing's own rule; the download is `nosniff`, sandboxed, as an attachment. |
| GET / POST / PUT / DELETE | `/api/v1/documents[/{id}]` | The repository: a manager (`MANAGE_DOCUMENTS`) files an uploaded file with a title, reader group (Everyone, All owners, Executive Committee, EC + Finance, Staff, one villa's owner / resident), expiry and folder; readers see what their group and the folders' role limits allow. |
| GET / POST / PUT / DELETE | `/api/v1/cultural/donations[/{id}]`, `/{id}/receive`, `/{id}/paid-online` | A resident pledges for their unit (and may hold a fixed offering slot); the committee records donations. Received exactly once - at the office (`receive`) or online (a donation prepayment claimed by `paid-online`) - with the event's next receipt number, and in the books (Dr receivable / Cr 4400, then the payment; a visitor: Dr bank / Cr 4400; in kind: a receipt only). A resident sees their unit's donations. |
| GET / POST / PUT / DELETE | `/api/v1/cultural/events/{id}/expenses`, `/cultural/expenses[/{id}]`, `/{id}/decision`, `/{id}/pay`; POST `/cultural/events/{id}/credit` | Event expenses on the approval kernel (EC; a final approver too above the event's limit); a rejected one is changed and sent again; paid by a final approver (Dr 5100 / Cr bank). A completed event's unused budget is credited back by a final approver. |
| POST / DELETE | `/api/v1/cultural/{seva\|programme}/{id}/signup` | Sign up or leave as yourself while there is room (a household's head count at programme items); the committee removes anyone. |
| GET / POST / PATCH | `/api/v1/finance/cash-book[/{id}]`, `/{id}/reverse`, `/{id}/statement`; PUT `/finance/period-lock` | The cash book (MANAGE_LEDGER writes; the committee, FM and money roles read): GST and TDS from the base amount, posted to the journal as written (out: Dr 5000 / 5100 + 1300 input GST, Cr bank + 2150 TDS; in: Dr bank, Cr 4900 + 2100). Above the approval limit, money out is refused (`needs-second-approver`). Never edited for money or deleted: reversed once (not while matched to a bank line); a reversed release payment puts the release back to Approved. Closed books refuse anything dated on or before the lock; reopening needs a reason. |
| GET / POST / PUT | `/api/v1/finance/releases[/{id}]`, `/{id}/decision` · `/pay` · `/cancel` | A release on a task (within what is still open on its approved quotation / invoice) or an approved event expense; its own approval plan; paid by the accounts (a cash book entry); an expense covered by paid releases becomes Paid. |
| GET / POST | `/api/v1/finance/pay-requests`, `/{id}/decision` | Money out above the limit, waiting for a second person (another money role or a final approver, never the requester); approved, the server records the entry as asked. |
| GET / POST | `/api/v1/finance/bank-lines`, `/bank-lines/import`, `/{id}/match`, `/{id}/unmatch`; GET `/finance/ledger/accounts`, `/finance/ledger/journal` | Statement lines imported once (the same line again is skipped), matched one-to-one with an entry going the same way for the same amount; balances per account and the posted journal. |
| GET / POST / PUT / DELETE | `/api/v1/governance/meetings[/{id}]` | Meetings (MANAGE_GOVERNANCE writes): internal until published, residents read only published ones and are told when one is published, moved, cancelled or its minutes are out. Completed and minutes only once it has been held; a meeting that was published or has minutes is cancelled, never deleted. |
| GET / POST / PUT / DELETE | `/api/v1/governance/ballots[/{id}]`, POST `/{id}/open`, `/{id}/close`; GET `/{id}/roll`, `/{id}/box` | Ballots: a draft is edited by the committee; opening freezes the owners of each unit and fingerprints the roll; closing (from the closing day, or once every unit voted) checks the box's chain against the count kept while voting. The roll shows which units voted (owner names and who voted: the committee and the unit's own people); the box with its receipts, once closed, for everyone. Each ballot carries the reader's units on its roll and why they may not vote. |
| POST | `/api/v1/governance/ballots/{id}/code`, `/code/verify`, `/votes` | One vote per unit, by a registered owner on the frozen roll: a 6-digit code to the mobile registered for the unit (5 minutes, 3 tries, 30 seconds apart; shown on screen only by a development server whose codes go to the log), a proof good for one cast within 2 minutes, then the mark and the chained box row in one transaction with the ballot locked. The audit trail says who voted, never what. |
| GET / POST / PUT / DELETE | `/api/v1/vendors/directory[/{id}]`, GET `/{id}/reviews`, PUT `/{id}/review`, DELETE `/vendors/reviews/{id}` | The community's service directory: any member (not a vendor) adds someone; the adder changes or removes it; moderators (the committee, forum moderators) hide it with a reason or remove anyone's. Reviews: 1-5 stars, my review is written once and rewritten after; one per household for residents. The rating, counts and my review come with each contact. |
| GET / POST | `/api/v1/assets/inventory/{id}/movements`, POST `/api/v1/assets/condition-log` | Stock moves by movements only (the committee, FM and MEP): received (the restock date and supplier follow), issued (never below zero, optionally for a task), counted (the quantity found); falling to the minimum tells the FM and MEP once. An asset's condition is recorded in its log (an inspection, a task opened or closed) and the asset follows when it is the latest news. |
| GET / POST / PATCH | `/api/v1/field-staff`, `/field-staff/{id}` | Add a member as field staff; clock in / out (`If-Match`) |

OpenAPI is at `/v3/api-docs`, and metrics at `/actuator/prometheus`.

## 10. Web app: the v2 data source

To use it, pick **Back end v2** in the Data source panel, or set `VITE_USE_API=v2`. Modules keep calling `storage.*`. `src/lib/storage/v2/V2ApiAdapter.js` maps those calls onto the typed endpoints, and the field mapping is in `v2map.js`.

| The app's collection | v2 resource |
|---|---|
| `properties` | units. Only changed, allowed fields are sent, as PATCH with `If-Match`; extra fields go to `custom`. |
| `users` | members. A new user is POSTed; a role change is a PUT; Inactive means deactivate. |
| `dues` | bills. A new bill is POSTed: the typed amount is before tax, and the server adds the category's tax. Cancelled or Waived become cancel / waive. Amount edits are not sent; delete is refused. |
| `roles` | `GET /roles`, read only |
| `tickets` | A new ticket is POSTed (a resident's SLA is left to the committee). A change becomes the commands it needs: PATCH for fields, assign, status, rating, me-too. The money side (quotation / invoice status, approvals, approved amount) is read from the server and never written on a ticket. Photos are refused until files arrive; delete is refused. |
| `quotations` | A new one is POSTed with what is written on it; a change becomes its command: select, a decision (found by comparing the plan's decisions, or the two slots), send back with a correction note. Amount edits are refused. Plans come back with names in `by`, as the app's approval engine expects. |
| gate | `gatePasses` (new = POST, Cancelled = cancel), `gateApprovals` (Approved / Denied = answer), `gateFlags` (Closed = resolve); `gateVisits` and `gateScans` are read-only - on v2 the gate engine (`lib/gate/engine.js`) hands every desk decision to the server (`lib/gate/v2gate.js`) and the screens get the same `{ok, outcome, reason, visit}` back. The gate registers are in `RESOURCES`. |
| `notifications` | The reader's own inbox, addressed to them so the bell's "is it for me" check holds. Read = `/read`. A notification the app composes is not sent: on v2 the server notifies from the event itself (and the channel queue `notificationOutbox` is read-only). |
| `broadcasts`, `pollVotes` | A new notice is POSTed as a draft, or sent; unit numbers and block names become ids; counts and who signed are the server's. A change becomes its command: sign, move the maintenance window, PUT the draft, send. Poll answers: the committee gets the real rows; a reader their unit's row and anonymous rows that add up to the counts. |
| `forum`, `forumPosts` | Topics and posts: new = POST; pin / close / title = PATCH; a vote (an added name in `voters`) = `/vote`; an extra reaction = `/react`; the reply count is always the server's. |
| `files`, `documents` | A new file row's data URL goes up as bytes (`POST /files`), unattached. Tickets, comments, quotations and a booking's deposit photos then attach the files they list after the record is saved, and read back the files attached to them. Reading a file fetches `/content` into a data URL. A document is filed with its uploaded file; the app's "version" is the document's label. Folders are a register. |
| cultural | `culturalDonations` (new = POST; Received = `receive`, or `paid-online` with the prepayment id), `culturalExpenses` (fields = PUT, a decision found on the plan or the slots, Paid = `pay`), sign-ups on `culturalSevas` / `culturalPrograms` (an added or removed name = the sign-up command), `culturalOfferings` (the reservation fields are never written - pledging holds a slot), `culturalEvents` (the totals are never written; a credited amount = `credit`), `culturalPhotos` (the picture attached to the row). |
| governance | `meetings` (POST / PUT; agenda and minutes papers attached as files), `ballots` (a draft POST / PUT; Open = `open` - the roll the screen built is not used, the server freezes its own; Closed = `close`), `voteRoll` (the mark carries the code's proof; nothing is written until the choice), `ballotBox` (the choice: `votes`, which writes the mark and the box row together); `evoting.js` asks the server for the code and the proof and takes the server's reason a reader may not vote. |
| vendors | `vendors`, `vendorServices` (the vendor by name in the app, by id on the server), `vendorComments` through the kit (`RESOURCES`); a vendor's papers are attached files; `serviceContacts` (POST / PUT / DELETE; who added it and the rating are the server's), `contactReviews` (my review = PUT `/review`, delete by id). |
| assets | the registers through the kit (`RESOURCES`; equipment `specs` stay JSON text in the app); `inventory`: a quantity change is a movement (a count, or a receipt when the restock date moves); `infraLog` = POST `condition-log`; papers are attached files; the logs are not deleted. |
| finance | `ledger` (new = POST - except lines the server books itself: bill payments, bookings, donations; a reversal = `reverse`; a release's payment = the release's `pay`; Matched / Unreconciled / Not applicable = match / unmatch / statement; the words = PATCH; money edits and deletes refused), `releases` (decisions on the plan, cancel, pay), `payRequests` (new = POST, Approved / Rejected = decision), `bankTxns` (a statement = one import). Registers in `RESOURCES`. |
| `amenities` (bookings) | A new booking is POSTed with what to book and how it is paid; the app's `_action`s become the booking commands; other edits are refused. A resident's list is their bookings plus everyone else's as "taken" placeholders (from availability), so the calendar still shows what is full. Paying online first is a prepayment order (`V2Gateway`), and the booking claims it. |
| registers (`RESOURCES` in `v2map.js`) | `amenityTypes`, `amenityItems` (the amenity by name becomes its id), `amenitySettings`, `taskTypes`, `categoryMap`, `quickPhrases`, `approverSettings`, `wishes`, `serviceNotices`, `eventWork`, `tradeAvailability`, `approvalPolicies`, `financeSettings`, `importantNumbers`, `numberSections`, `mergeFields`, `noticeTemplates`, `notificationTemplates`, `notificationPrefs`, `notificationSettings` (found by the app as `default`): read from the resource kit; a write sends exactly the fields of the resource's request type (from `/meta/resources`), with unit numbers turned into unit ids and the few renamed fields mapped; PUT and DELETE carry `If-Match`; settings are one row. |
| `ticketComments` | The latest comments on tickets the caller may see; a new comment is POSTed; comments are never edited |
| `handymen` | Field staff: clock in / out; a new one must already be a member |
| `schema`, `communityConfig`, `roleGroups` | Kept in this browser until v2 has endpoints for them |
| anything else | Read as empty; a write is refused with "not on the v2 back end yet" |

**Sign-in** (`src/lib/auth/v2Auth.js`): `authApi.js` switches to it in v2 mode. The page's community id goes into the token request, so there is no community picker. The refresh token is the HttpOnly cookie.

**Payments** (`src/lib/payments/V2Gateway.js`):

- one `Idempotency-Key` per press of Pay;
- no amount is sent;
- the checkout is either the simulator or Razorpay Checkout (`window.Razorpay`);
- then `confirm`, and the page watches the order.

## 11. Running it

**Everything in Docker (quickest):** from `backend/`, run `docker compose up -d --build`, then open http://localhost:8081.

| Service | What it is |
|---|---|
| `postgres` | PostgreSQL 18. On first start, `api/docker/initdb/01-roles.sh` creates the `cos_app` and `cos_platform` login roles. |
| `api` | `backend/api` on Java 25, dev profile. Flyway builds the 156 tables at start-up, connecting as the owner `cos_owner`. |
| `seed` | Runs once, after `api` is healthy. `api/docker/seed.sql` creates the community `la-paloma`, Villa 1 to Villa 212, and a Super Admin on `SEED_ADMIN_PHONE` (default `+919800000000`). It is safe to run again. |
| `web` | The app built with `VITE_USE_API=v2`, served by nginx. `/api` is forwarded to `api`, so the app and the API share one origin. |

To sign in, request a code for the Super Admin's phone. In the dev profile the code is printed in the API log: `docker compose logs -f api | grep "sign-in code"`.

Open the app at `http://localhost:8081`, not at a LAN address. The refresh cookie is marked `Secure`, and browsers accept that over plain http only on `localhost`.

**By hand:**

```sh
# 1. database: migrations run as the owner; give the two runtime roles a login
#    (use the roles themselves: BYPASSRLS is not inherited by a member role)
psql -c "ALTER ROLE cos_app LOGIN PASSWORD '...'" -c "ALTER ROLE cos_platform LOGIN PASSWORD '...'"
# 2. secrets (from the secret manager in production)
COS_JWT_SIGNING_KEY="$(openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt)"
COS_OTP_PEPPER=<32+ random chars>  COS_DB_APP_PASSWORD=...  COS_DB_PLATFORM_PASSWORD=...  COS_DB_OWNER_PASSWORD=...
COS_RAZORPAY_ENABLED=true COS_RAZORPAY_KEY_ID=... COS_RAZORPAY_KEY_SECRET=... COS_RAZORPAY_WEBHOOK_SECRET=...
# 3. run
cd backend/api && mvn spring-boot:run                                # prod-like
cd backend/api && mvn spring-boot:run -Dspring-boot.run.profiles=dev # log the code, throw-away key, simulated payments
```

Requirements: Java 25 (Temurin 25), PostgreSQL 18 (the migrations were also checked on 16). With the `postgres:18` Docker image, mount the volume at `/var/lib/postgresql`, not `/var/lib/postgresql/data`: the 18 image keeps its data in `/var/lib/postgresql/18/docker`.

A new community needs a `platform.community` row, then `SELECT platform.provision_community(id)`. That creates the role groups, the 18 roles, the chart of accounts, the charge categories and the settings row.

## 12. How it was checked (this environment)

| Check | Result |
|---|---|
| Schema tests (`tools/test-schema.sh`): isolation, stamping, money rules, ledger balance, append-only audit, partitions, privileges, ticket rules, comms checks | 23 / 23 |
| Java unit tests (javac against hand-written Spring stubs, JUnit shim): kernel, auth, members, access policies, billing, maintenance, approvals, amenities, gate, comms, files and documents, cultural, finance, governance, vendors, assets, resource kit | 89 / 89 |
| **PostgreSQL flow test** (`it/PostgresFlowTest`): the real adapters as `cos_app` / `cos_platform`, through a psql bridge (bills and payments; a ticket's whole life; quotations through EC and final approval; registers through the kit; bookings; the gate; every event into the inboxes, channel choices and settings, notices with receipts, polls and the schedule, the forum with moderation; files on a ticket, documents by group and folder; pledges, receipts, an online donation, offerings, seva, expenses and the budget credit; the cash book with taxes, a second approver, bank matching, reversal, closed books, a release paid and reversed; a meeting published with its minutes, a ballot opened on a frozen roll, a code tried wrong and right, one vote per unit, the sealed box, the database refusing edits, the close and the count; a vendor with its workers and a discussion that stays, the directory with one review per household and a contact hidden; an asset's condition log, stock received and issued (never below zero), worked-out readings, one row a day / month) | 1 / 1 |
| Adapter SQL check (`tools/check-adapter-sql.sh`): every statement, including the list and detail queries composed with the real access rules of five kinds of caller and every resource's list / get / insert / update / delete, run with `PREPARE` + `EXPLAIN EXECUTE` as its role | 1340 / 1340 |
| Web adapter tests (`node tests/v2/run.mjs`): sign-in, units, bills, members, tickets, quotations, registers, bookings, the gate, comms, files and documents, cultural, finance, governance, vendors, assets, refusals and payment against a fake of the API | 18 / 18 |
| Production build (`npx vite build`) | Builds |

The adapter SQL check found two real bugs in the composed list and detail SQL (`JdbcDueRepository`, `JdbcMemberRepository`). Text blocks lost the leading space of a fragment, so `...d.version` + `FROM` became `d.versionFROM`. Both are fixed, and the check now composes exactly the strings the repositories run.

**Not checked here.** Maven Central is not reachable from this environment, so the service has never been built by Maven, and Spring itself has not run. That covers:

- configuration binding;
- the security filter chain;
- Jackson inside Spring MVC (including jsr310 for dates);
- Hikari;
- Flyway.

`SecurityConfig` and `DataConfig` are type-checked only against stubs. The first thing to run is `cd backend/api && mvn verify`. Then run the flow test on Testcontainers + PgJDBC instead of the psql bridge.

## 13. Next

1. Run `mvn verify` and the Spring context test.
2. Port the remaining modules onto their V6 tables, one at a time (workflows as services, registers as resources), each with tests and a v2 mapping: vendors / assets / workforce / reports.
4. Add endpoints for the app's configuration collections (field definitions, settings).
5. Add refunds, late fees and bill runs: a bulk `POST /dues:batch`, keyset-paged.
6. Add ShedLock if a job must run on exactly one instance.
7. Move the rate limits to Redis when traffic needs it. The interface is already a port.

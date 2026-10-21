# Back end: Spring Boot + PostgreSQL

> **Historical (r76).** This describes the retired servers (`backend/contract-server`, `backend/spring`). The current back end is `backend/api`: see docs/REDESIGN.md.

The browser app runs on either of two data sources, switched **at run time** from the small chip at the bottom-left of the screen
(“○ Browser demo” / “● Back end”):

| | Browser session | Back end |
|---|---|---|
| Where data lives | this tab (sessionStorage + IndexedDB) | PostgreSQL, through the Spring Boot service |
| Needs installing | nothing | the service + a database (or the Node stand-in below) |
| Use it for | building and demoing screens fast, tests | real data, several users, files, e-mail, payments |

Switching reloads the app. **Nothing is lost by switching**: the panel can copy a community **Browser → Back end** or **Back end → Browser**.
Opening the app never wipes a database (only the throw-away browser store is reset when the build changes).

## 1. Layout

```
backend/
  db/V1__documents.sql          the one schema (Flyway runs it; the Node stand-in runs the same file)
  spring/                       the Spring Boot service  (Java 25, Maven)
  contract-server/              a ~250-line Node stand-in that speaks the same REST contract (see 4)
  docker-compose.yml            postgres + service (+ MinIO, Mailpit on request)
  .env.example                  every setting, with its default
src/lib/storage/
  StorageAdapter.js             the contract every store implements
  SessionStorageAdapter.js      browser store
  ApiStorageAdapter.js          HTTP store (talks to the service)
  dataSource.js                 which one is active (saved in localStorage)
  index.js                      `storage` = facade that forwards to the active adapter
  migrate.js                    copy a community between the two
```

### Design (what to read before changing anything)
Hexagonal / ports-and-adapters. The core depends only on interfaces; each outside system sits behind one.

```
 web/ (controllers)  ->  service/ (use cases)  ->  port/ (interfaces)  <-  adapter/ (one class per vendor)
                                                        ^
                                       config/ProvidersConfig  = the ONE place that picks the vendor class from application.yml
```

| Port (interface) | Adapters shipped | Add another by |
|---|---|---|
| `DocumentRepository` | `JdbcDocumentRepository` (PostgreSQL JSONB), `InMemoryDocumentRepository` | one class + one `case` in ProvidersConfig |
| `FileStorage` | `LocalDiskFileStorage`, `S3FileStorage` (S3, MinIO, R2, Spaces, Wasabi) | same |
| `OutboundChannel` (Email / SMS / WhatsApp) | `LoggingChannel`, `SmtpEmailChannel`, `HttpChannel` | same |
| `PaymentProvider` | `SimulatedPaymentProvider` | same (Razorpay, Stripe ...) |
| `GstProvider` | `SimulatedGstProvider` | same (a GSP) |
| authorization | the Java **rule book** (`com.communityos.security`), proven equal to the web app's by a conformance test | edit the rule, regenerate the golden file (section 10) |
| `PaymentStore`, `IdempotencyStore`, `EventOutboxStore` | `Jdbc…` (PostgreSQL, the V3/V4 tables) and `InMemory…` | one class each + `PaymentsConfig` |

Patterns used on purpose: **Ports & Adapters** (vendor swap), **Strategy** (one `OutboundChannel` per channel, picked by config),
**Repository** (storage), **Composition root** (ProvidersConfig), **Observer-ready** services (a scheduled outbox dispatcher),
**Idempotency** (payment orders and webhook events), **Immutable value records** for requests/results.

The database is deliberately one generic table: `documents(tenant, collection, id, data jsonb, seq, updated_at)`.
A new collection, or a field a Super Admin adds in the UI, needs **no migration**. Add expression indexes for the lists that get big
(see the comment at the end of `V1__documents.sql`).

## 2. REST contract (what the UI calls)

Every call carries `X-Community-Id: <slug>` (and `Authorization: Bearer <key or token>` when security is on). Errors are `{ "message": "..." }`.

| Call | Meaning |
|---|---|
| `GET /api/health` | `{status, database, version, providers:{...}}` (open). Used by “Test connection”. |
| `GET /api/{c}` · `GET /api/{c}/{id}` | list (insertion order) · one (404 if missing) |
| `PUT /api/{c}/{id}` | upsert; **shallow-merged** into the stored document; body `id` must equal the path |
| `DELETE /api/{c}/{id}` | 204 |
| `POST /api/{c}/bulk` | `Record[]` upserted in one transaction |
| `PUT /api/{c}` | replace the whole collection (seed / import) |
| `GET /api/{c}/query?page&pageSize&sort=key:dir&search&searchKey&dateKey&from&to&periodKey&year&month&f.<field>=v` | `{rows,total,page,pageSize,pages}`; same meaning as `src/lib/storage/queryEngine.js` |
| `PUT/GET/DELETE /api/files/{id}/content` | file bytes (metadata row is an ordinary `files` document with no bytes) |
| `DELETE /api/admin/tenants/{slug}` | demo reset; only if `ALLOW_TENANT_RESET=true` |
| `POST /api/payments/orders` · `GET /api/payments/orders/{id}` · `POST /api/payments/refunds` · `POST /api/payments/webhook/{provider}` | see docs/ARCHITECTURE.md (payments) |
| `GET /api/gst/health` · `GET /api/gst/gstin/{g}` · `POST /api/gst/inward/lookup` | see docs/GST_API.md |

Reserved names that cannot be collections: `health`, `admin`, `payments`, `gst`. The collection `communities` is shared (tenant `platform`).
Both implementations (Spring and the Node stand-in) are checked against the browser's query engine: 11 query shapes return identical rows.

## 3. Run it

**A. Fastest: no Java, real PostgreSQL** (stand-in server)
```bash
createdb communityos                                   # any PostgreSQL 13+
cd backend/contract-server && npm install
DATABASE_URL=postgres://localhost/communityos PORT=8080 node server.mjs
cd ../.. && npm run dev                                 # UI on :5173; Vite forwards /api to :8080
# in the UI: chip bottom-left -> Back end -> address /api -> Test connection -> Browser -> Back end (push demo data) -> Use this and reload
```

**B. The real service, whole stack in Docker**
```bash
cd backend && docker compose up -d --build              # postgres + service on :8080
# optional extras:  docker compose --profile s3 --profile mail up -d   (MinIO console :9001, Mailpit inbox :8025)
```

**C. The service from source**
```bash
cd backend/spring
mvn spring-boot:run -Dspring-boot.run.profiles=memory   # no database: data is lost on restart
mvn spring-boot:run                                      # PostgreSQL from DB_URL / DB_USER / DB_PASSWORD (Flyway creates the table)
mvn test                                                 # HTTP contract test against the in-memory adapter
```
If the UI is served from a different address than the API, either use the Vite proxy (default `VITE_PROXY_TARGET=http://localhost:8080`)
or put the API address in the panel and add the site to `CORS_ORIGINS`.

## 4. The Node stand-in is the tested reference, not the product
`backend/contract-server` runs on real PostgreSQL and, since round 69, **enforces** everything in sections 5 and 6 (`AUTH_MODE=enforce`). It runs the *same* rule book as the screens (`src/lib/security/authz.js`, `src/lib/storage/secureStorage.js`) on the server, one PostgreSQL transaction per request. It has no mail, S3 or outbox. Spring is the production target and **has not yet been given these changes** (see section 7).

## 5. Authentication (round 69)
* `AUTH_MODE=enforce`: every call needs a token; the server learns user, role and community from the token and the `users` table, never from the request body or headers.
* Local provider: phone OTP (6 digits, hashed, 5 min, 3 tries, resend gap, per-phone and per-IP hourly limits, lockout after 5 wrong codes for 15 min). Access token 15 min; refresh token in an HttpOnly cookie, rotated on every use; reusing an old refresh token ends the whole session (theft detection).
* OIDC provider (Keycloak etc.): see docs/INTEGRATIONS.md §8 for the claims contract and setup. Roles stay in `users`/`roles`.
* Demo roster is off unless `DEMO_ROSTER=true`; production refuses to start with it.
* Spring: `none | api-key | jwt | local`. `jwt` validates an OpenID Connect provider's token; **`local` (round 75) is the phone sign-in above on the Spring server itself**: same endpoints, same limits, same tables (`db/V2__auth.sql`) and the same HS256 token format, so a session started on one server is honoured by the other when they share `JWT_SECRET` (section 10.9).

## 6. Authorisation (round 69, enforced by the Node reference)
Enforced on the server, tested with 51 API tests (role matrix over 18 roles × 6 questions, plus sign-in, rate limits, refresh theft, payments):
* role → collection → read / write / delete; resident → own-unit rows; block-scoped staff → their blocks; fields a role may not see are removed from responses and rejected on write.
* Money is never written by the app: residents cannot write `dues`, `ledger`, `unitCredits`; a payment is priced by the server, settled by a signed webhook (bill + ledger + receipt in one transaction), and a reconcile job settles or expires orders whose webhook was lost. A booking paid online must point at a real, unused, big-enough payment.
* The audit trail is written by the server only; every client write to it is refused (403). Denied attempts are recorded.
* Optimistic locking: a save carries the version the screen loaded; a stale one gets HTTP 409 and the screen shows the current record. Parallel saves of one record: exactly one wins.
* Background jobs (late fees, reminders, recurring bills …) run on the server per community under a database lock (`JOBS_INTERVAL_SECONDS`), not in browsers.

**Known limits of this round.** Row scope is applied after loading a collection, not in SQL (fine for thousands of rows, not 1M/10M; see docs/SCALE-AND-CONFIGURATION.md §4). `nextShortId` reads whole collections on the browser path. A few server-side module caches (utility names, region, locale) are shared across communities in one server process. Creating a brand-new community and the platform console are not available in enforce mode yet. The audit list is not paged.

## 7. What is verified and what is not

**Verified (round 67 validation).**
* All 63 existing UI test files were run twice: once on the browser store, once with the app pointed at the back end on **real PostgreSQL 16**
  (the Node stand-in in `contract-server/`, same REST contract and same SQL as the Spring code). Every flow passes in both modes.
  That run found and fixed three real defects: record ids containing spaces or "·" were rejected (HTTP 400); seeding an empty back end from two tabs
  at once produced cross-linked ids that did not match; and form toggles snapped back while the server was answering.
* The REST contract: 25 checks (`parity.mjs`) including 11 query cases compared against the browser query engine, tenant isolation, files, bad input.
* The Java in-memory adapter gives the same rows as the browser query engine on the same query cases.

**Not verified: the Spring Boot project has never been compiled or run.** The environment it was written in cannot reach Maven Central.
Every layer except `SecurityConfig` and `S3FileStorage` was type-checked against hand-written stubs, and the rest was desk-reviewed. Expect a few
compile or wiring errors on your first `mvn package`; start with `mvn test -Dtest=ApiContractTest`, which exercises every route.
Treat "the UI works against the Node stand-in" as proof of the **contract and the SQL**, not of the Java.

**What the Spring service does today versus what the browser still does** (flipping to "Back end" moves storage only):

| Area | Server-backed | Still in the browser |
|---|---|---|
| Records (every collection), query, paging, search | yes (JSONB documents) | rules and validation (`secureStorage`) |
| File bytes (photos, documents) | yes, through the `FileStorage` port | scan status is set by the browser |
| E-mail / SMS / WhatsApp | outbox dispatcher (log / SMTP / HTTP); Spring itself queues the amenity messages (10.8) and, since round 75, task, approval, invoice, forum, chat, release, payment-reminder, e-voting-reminder, receipt and report messages (10.9) | announcements and the other messages a screen writes directly |
| Payments | Node reference and **Spring (round 72)**: order priced by the server, signed webhook, settle bill + credit + ledger line + receipt in one REPEATABLE READ transaction, reconcile job, booking claim, outbox event; late fees added at pay time and the "Payment received" message (round 75). Spring: written, uncompiled by Maven (section 10) | a payer with several units pays for the first one only |
| Sign-in / OTP | Node reference: yes (sessions, limits, lockout, OIDC-ready); **Spring: yes (`app.security.mode=local`, round 75)** or OIDC token validation (`jwt`) | the e-voting one-time code is checked on the server (10.8); the `portalAccess` OTP is still a browser-only demo |
| Authorisation (who may read or write what) | Node reference: yes (shared rule book on the server). **Spring (round 72): yes, a Java rule book checked against 72 675 decisions generated from the real JavaScript** (section 10) | in the browser the same rules still run for display only |
| Late fees, billing runs, reminders | Node reference: 8 server jobs; **Spring: the same 8 jobs (round 75, 10.9)** | browser jobs are switched off when the server enforces |

**Spring cannot share the JavaScript rule book**, so it has its own Java copy, held equal to the original by the conformance test (section 10). The Node server remains the tested reference for everything else; `npm test` in `contract-server` is the acceptance suite to point at Spring too.

## 8. How many requests the UI makes (round 68)
Measured with a script that signs in as Super Admin and opens 25 pages in turn, counting calls to `/api` (back-end mode, dev build, which also runs React effects twice):

| | Before | After |
|---|---|---|
| Login screen | 111 | 8 |
| 25-page walkthrough, total | 755 | 271 |
| Security (gate) console left open, per 30 s | 72 | 48 |

What changed, all in `src/lib/storage/index.js` and the screens, none of it in the adapters:
* **Identical reads in flight at the same moment share one request.** Nothing is kept afterwards, so it cannot go stale. A write to a collection drops the waiting reads for it.
* **No data is cached (round 76).** The 3-second reference-list cache of round 68, the 60-second late-fee settings cache, the 20-second search cache and the servers' community-meta cache (`META_CACHE_MS` / `app.storage.meta-ttl-ms`, now 0 by default) are gone: every read asks the database. What remains is not a cache: reads in flight at the same moment share one request, the sign-in configuration is read once per tab, and the roles / schemas of the signed-in session are held as app state until a change to them is announced.
* **Data is loaded when the part of the page that shows it is opened (round 76).** `useCollection` reads a collection only when the screen actually uses its rows; users are no longer read on the home page (the "On duty now" list loads when it is opened), in a ticket until it is opened, on a property until "Show portal access" is pressed, or by tables for their filter lists. The data-health scan runs on its own page only. Measured (enforce mode, Super Admin): home page 32 calls -> 14, with no users call; the background users poll is off in back-end mode.
* **Seeding** looks at one collection (users) instead of one per collection. A back end that already has users is not re-seeded.
* **The gate sweep** runs one at a time and reads each collection once per run.
* **The background jobs** (bookings, recurring bills, reminders, reports) run one at a time.

Still to do for large communities: the pages listed in section 7 that read a whole collection (`storage.list`) should move to `ServerTable` or to server-side totals.


## 9. Where each collection lives: typed tables, JSONB, and row scope in SQL (round 71)

**Rule of thumb.** Collections whose shape the community can change (forum, notices, custom fields, settings, Studio schemas) stay **JSONB documents** in the `documents` table, because flexibility matters more than joins. The **hot, relational** collections have real tables with typed columns, foreign keys and indexes:

| Collection | Table | Notes |
|---|---|---|
| `properties` | `units` | UNIQUE (tenant, unit); target of the foreign keys below |
| `users` | `users` | digits-only phone for sign-in lookup |
| `dues` | `dues` | FK (tenant, unit) -> units |
| `amenities` | `bookings` | FK (tenant, unit) -> units |
| `tickets` | `tickets` | no FK on unit (tickets may name a common area) |
| `ledger` | `ledger_entries` | no FK on unit (same reason) |
| `audit` | `audit_log` | append-only, **partitioned by month** on `at`, plus a default partition |

**One document, generated columns.** Each record is still ONE JSON document in `data` (the source of truth, so community-defined extra fields need no migration). The typed columns are `GENERATED ALWAYS AS (...) STORED` from `data`, so there is no mapping code and they can never disagree with it. A bad number or date in the JSON becomes NULL in its column (tolerant casts `cos_num/cos_date/cos_ts`) and never blocks a save. The audit table is the exception: a partition key cannot be a generated column, so its columns are filled by the repository.

**Routing is in one place.** Node: `store/tables.mjs` + `store/repository.mjs`. Spring: `CollectionMappings` (registry) + `RoutingDocumentRepository` (sends a collection to `TypedDocumentRepository` or to `JdbcDocumentRepository`). The UI, the REST routes and the rule book do not know which one is used. Spring switch: `app.storage.typed-tables` / `TYPED_TABLES=false` keeps everything in `documents`.

**Row scope in the WHERE.** `src/lib/security/authz.js` describes a caller's row scope as data (`S.eq / in / empty / and / or ...`). Where that tree is exactly equivalent to the in-memory rule it carries a `sql` form, and the database filters the rows (own unit, own block) instead of the server loading a collection and filtering in memory. Node: `store/sqlquery.mjs`. Spring: `ScopeNode` (domain) -> `ScopeSql` -> `QueryCompiler`; `RowScopes` (Java) builds the same tree from the caller's principal and `SecureRecordService` hands it to the repository. The in-memory path is always the correct fallback and runs when:
- the collection has no `sql` scope (users, files, documents/folders rules),
- the request filters, sorts or searches on a field the caller may not see,
- the collection has a row `transform` and the request filters/sorts/searches.
`DB_SCOPE=off` forces the memory path (used by the tests to prove both paths return identical rows for every role).

**Paging.** Counting stops at 100 000 (`approx: true` / `total` is a floor). Sorting on typed columns is `NULLS LAST` with `seq` as tie-break, matching the browser. The audit screen pages on the server; its Coverage tab reads only the newest 2 000 entries.

**Partitions.** `cos_audit_partitions(from, to)` creates monthly partitions; the Node server runs it at start and daily. Old months can be detached or dropped as a unit. In Spring a scheduled call is still to be added (the default partition keeps writes working meanwhile).

### Spring: logging and API docs
- `RequestLoggingFilter` gives each request an id (accepts a safe `X-Request-Id`, else generates one), puts `requestId` and `community` in the logging context, returns the id in the response header and in error bodies, and writes ONE access line (path, status, ms; never headers, query strings or bodies). Levels: `LOG_LEVEL`, `APP_LOG_LEVEL`, `ACCESS_LOG_LEVEL`, `SQL_LOG_LEVEL` (DEBUG prints every statement). The pattern is in `logback-spring.xml`.
- Swagger UI at `/swagger-ui.html`, OpenAPI at `/v3/api-docs` (springdoc 2.6.0, `OpenApiConfig`, `@Tag` / `@Operation` on every controller). Turn off on a public site with `API_DOCS=false`. "Authorize" takes the bearer token.

### What is verified
- Node on real PostgreSQL: `npm test` 81 tests, including `scope.test.mjs` which compares the SQL path with the memory path for every role, FK refusals, audit immutability, partitions and short ids.
- Spring: the new classes (typed package) were compiled with `javac` against Jackson and SLF4J with stubs for Spring JDBC, and the SQL they generate was compared to the Node compiler for the same inputs (same WHERE structure and bind order, apart from Node reusing one parameter number). **Not run against a database, not built with Maven, and the unit test `QueryCompilerTest` was not executed** (no JUnit or Maven Central here). The logging filter, `OpenApiConfig` and annotations were only syntax-checked.
- Passing a `String[]` as a `= ANY(?)` bind relies on the PostgreSQL JDBC driver; confirm on first run.

## 10. Spring parity: authorization, row scope, locking, settlement, idempotency, outbox (round 72)

Everything below is **written and tested only against hand-made stubs, never compiled by Maven** (Maven Central is unreachable where this was written). Run `mvn test` first; expect a few compile or wiring errors. The Node server stays the tested reference.

### 10.1 Authorization and row scope
- **Java rule book** `com.communityos.security` (`WriteRules`, `ReadRules`, `FieldMasking`, `RowScopes`, `BlockScope`, `ApprovalEngine`, `TicketRules`, `FinanceRules` ...) is a port of `src/lib/security/authz.js`, not a re-design.
- **How we know it is the same.** `backend/contract-server/test/gen-rulebook-golden.mjs` (`npm run gen:rulebook`) runs the real JavaScript over every role x collection x scenario and writes `src/test/resources/rulebook/golden.json.gz` (about 69 450 write decisions and 3 225 read decisions, with masked fields and row scopes). `RuleBookConformanceTest` replays them against the Java and fails on any difference. Last local result: **0 mismatches**, and a deliberate rule change makes it fail. Change a rule in `authz.js` -> regenerate -> port -> the test tells you when they agree again.
- **Request path.** `SecureRecordService`: principal (`PrincipalResolver`: token -> `users` record -> role; in `none`/`api-key` mode the caller is the Super Admin) -> row scope in SQL where exactly expressible, else in memory -> field masking -> write pipeline: client guard, row lock, version check, rule book, block scope, closed books (`PeriodLock`), unported-hook guard, ticket rules, server stamps (shortId, recVersion, who/when, time trail), save, audit line. A refused write is audited after the rollback.
- **Locking.** `SELECT ... FOR UPDATE` in id order, and `recVersion`: a stale save gets 409 `conflict` with `current`.
- **`app.security.unported-hooks`** (`refuse` default | `allow`). Spring now has every Node write check (money guard, poll votes, amenity booking: 10.7; e-voting: 10.8), so the list of fenced collections is **empty** and the switch changes nothing today. It stays so that a future hook that is not ported yet can be fenced the same way (`ServerHooks.GUARDED`).
- Whole-collection replace and bulk write are refused in `jwt` mode (trusted callers only).

### 10.2 Payments: settlement and idempotency
- `PaymentService` (port of `payments.mjs`): `POST /api/payments/orders` prices from the bills / pledge (never from the browser; `quote:true` is a price check; asking twice returns the same open order), `GET /api/payments/orders/{id}`, signed webhook `POST /api/payments/webhook/{provider}`, dev-only `POST /api/payments/simulate/{id}`, finance-only refunds.
- **Settlement** is ONE REPEATABLE READ transaction (`Tx.repeatableRead`, retry on SQLSTATE 40001 / 40P01): lock the order row; skip if Paid; refuse and mark Failed when the provider's amount differs from the order; settle the bills (credit first), post the ledger line, mark the order Paid, write the `payment.settled` outbox event. The webhook event id is recorded in the same transaction, so a failure lets the provider's retry run again (the Node version recorded it first).
- **Reconcile** (`app.payments.reconcile-seconds`): asks the provider about open orders (`PaymentProvider.lookup`, behind a `CircuitBreaker`: timeout, open after N failures, one trial call), settles, fails or expires them. Safe on several instances.
- **Idempotency-Key** (`IdempotencyFilter`, table `idempotency_keys`): same key + same request replays the stored answer (`Idempotent-Replay: true`); same key, other request -> 422 `idempotency-mismatch`; first still running -> 409 `in-flight`; 5xx and 429 are not remembered; kept `app.idempotency.hours` (24). Scope = community + signed-in person.
- Production switches: `app.payments.allow-simulated=false` (refuses to start with the pretend bank or the default secret), `PAYMENT_WEBHOOK_SECRET`, a real `PaymentProvider` that also implements `lookup`.

### 10.3 Outbox
- `EventOutbox` (table `event_outbox`): `emit` inside the transaction of the change; a worker (`app.outbox.*`, every 5 s) takes due rows with `FOR UPDATE SKIP LOCKED`, calls the `OutboxTopicHandler` bean of the topic (default `payment.settled` just logs; add a bean to send the receipt, raise an invoice, export to accounts), optionally POSTs to `app.outbox.webhook-url` (`Idempotency-Key: outbox-<id>`), retries with back-off 10, 20, 40 ... s (cap 1 h), parks as `Dead` after `max-attempts` (8). The older `OutboxDispatcher` still sends the UI's `notificationOutbox` mail / SMS rows.

### 10.4 Still not ported (Spring)
- The browser-side `buildRoll` and `tally` of e-voting stay in the browser; the demo data is not offered when Spring creates a community; the SMS / e-mail gateway set-up itself (Spring has the adapters, a community still has to configure one).
- Everything else that was listed here is ported: notifications, late fees at pay time, the receipt message, field encryption, all eight background jobs and OTP sign-in (10.9); the property and meeting hooks, payers with several units and creating a community (10.10).

### 10.5 Known differences from the Node reference
- Roles: a community with no stored roles gets the built-in roles (Node: stored roles only). Second-step approvers and `finalCanDecideEC` are read for every collection (Node sets them for four). A malformed plan is denied (JS would throw). Custom document groups are honoured (Node's server ignores them).
- Settlement bumps `recVersion` on the bills it changes (a screen with an old copy gets 409 instead of un-paying the bill); an online donation's mode is "Online" (Node wrote "Online (demo)").
- Audit summaries strip HTML with a regex, not a DOM parser; the closed-books message may spell "Sept" differently.

### 10.7 Money guard, poll votes and amenities (round 73)
- `security/MoneyGuard` (releases, ledger, quotations, financial tickets), `security/PollRules` (one vote per villa), `amenities/AmenityEngine`, `AmenityRules`, `AmenityPosting`, `Defaulters` (booking price, window, cancellation refund, fee/deposit/credit postings). `Js` reproduces the JavaScript habits they depend on (undefined vs null, `Number(x)||0`, `Math.round` halves, `toString` of numbers, `\s`, `Object.entries` order, local-time `new Date("YYYY-MM-DDTHH:MM:SS")`).
- **Proof by replay.** `npm run gen:moneyguard` and `npm run gen:amenity` (in `backend/contract-server`) run the real JavaScript over generated cases and write `src/test/resources/{moneyguard,amenity}/golden.json.gz`; `MoneyGuardConformanceCheck` and `AmenityConformanceCheck` replay them in Java. Result: 144 000 money-guard cases, 18 000 amenity decisions and 2 632 postings, 0 mismatches. The poll rule has hand-written tests only.
- **Limits of that proof.** A deliberately wrong rounding tolerance in the money guard is not caught: no generated amount is sensitive to it. The amenity corpus was generated with `TZ=Asia/Kolkata`.
- **Differences from Node.** The money guard also runs on bulk create/update (Node: single put/delete only). Bulk writes to `amenities` are refused (Node has the same gap, unguarded). The ledger/credit postings of a booking are written in the booking's own transaction, so they succeed or fail together (Node logged a failed posting and kept the booking). The poll rule runs on bulk writes. A payment claim for a booking uses the Spring-assigned id when the client sends none. Payment modes are the India defaults (UPI, Card, Net banking, ...) as the Node server uses. Dates that only JavaScript's legacy parser would accept are treated as unreadable.
- **Time zone.** Booking times are local time like the JavaScript. Spring uses the JVM zone: set `TZ` or `-Duser.timezone=Asia/Kolkata` in production.

### 10.8 E-voting and amenity messages / scheduler (round 74)
**E-voting** (`com.communityos.evoting`, port of `src/lib/evoting.js`).
- **Why it was held back, and what changed.** The second factor is a one-time code. In the JavaScript the code, the proof it earns and the per-box allowance were three `Map`s in the process, and the browser asked for the code itself, so no server could prove anything. Now there are two server endpoints, `POST /api/evoting/otp/request` and `/verify`, and the state lives in a table (`evoting_state`, migration `V6`) behind the `EVotingState` port (in-memory and JDBC). The Node reference got the same endpoints; the UI calls them whenever a back end is in charge and keeps the old local demo path only for the browser store.
- **Rules ported:** who may vote (`whyCannotVote`), roll fingerprint (`rollHash`, SHA-256 of the roll), Draft -> Open needs a matching fingerprint and at least two options, an Open ballot cannot be edited, closing seals `chainHead` and `votesCounted`, a Closed ballot is immutable; a roll mark needs eligibility and a single-use proof and grants one box write; the box write needs that allowance, an open ballot and a valid option and gets `seq`, `prevHash`, `receipt` and `hash` (SHA-256 of `prev|seq|receipt|choice`); the box cannot be read until the ballot is closed, and then `verifyChain` can be run on it. Code: 6 digits, 5 minutes, 3 tries, 30 s between sends, salted SHA-256, proof valid 2 minutes. Stamps in the box keep only the day, author "Ballot box", no time trail and no audit line.
- **Transactions.** A wrong code and an expired code must stay recorded even though the answer is a refusal, so `OtpService.verify` commits first and throws after. A proof is consumed in its own transaction (`Tx.runIndependent`), so it is used up even if the vote is refused. The write path locks the ballot row before a roll mark or box write.
- **Code delivery** `app.evoting.delivery` (env `EVOTING_DELIVERY`): `sms` (the `OutboundChannel` "SMS", number taken from the unit's property record), `log` (default; the code goes to the server log) or `echo` (the code is returned to the browser; the application **refuses to start** with `echo` when `PAYMENT_ALLOW_SIMULATED=false`).
- **Differences from Node.** Bulk writes to the three collections are refused (Node does not run the check on bulk). A malformed roll is handled leniently. The code endpoint says "No such ballot" where the JavaScript would say "Not signed in". `buildRoll` and `tally` stay in the browser.
- **Proof by replay.** `npm run gen:evoting` runs the real JavaScript with a seeded random source and a controlled clock over 6 500 voting sessions (57 422 steps, 636 votes chained to `seq` 5, 33 125 refusals) and `EVotingConformanceCheck` replays them: 0 mismatches. Seven deliberate faults (proof expiry `>=`, code expiry `>=`, resend gap `<=`, chain separator, `opensOn <=`, 4 tries, `seq` off by one) were each caught. Node: `test/evoting.test.mjs`, 5 HTTP tests (fingerprint, no code no vote, wrong codes burn the code, a vote with the box sealed, closing).

**Amenity messages and scheduler** (`com.communityos.amenities`: `AmenityTemplates`, `AmenityReports`, `AmenityNotifier`, `AmenityScheduler`, `AmenitySystem`; run by `jobs/JobRunner` since round 75; port of the notification and scheduler half of `src/lib/amenityServer.js`).
- **Messages.** After a booking is stored (same transaction), for each enabled template of the event: one `notificationOutbox` row per recipient (the owner by e-mail or phone, the admins listed in the amenity settings), status `Queued — demo, not delivered`, or `Skipped — no contact` when there is no address; and the in-app bell (the unit's, and the managers' `inAppRoleIds`). `OutboxDispatcher` then sends the queued rows when `app.channels.enabled=true`. The event order is the JavaScript's (a cancellation tells "cancelled", then "refund processed" if the refund went to the unit account). A failing template is logged and does not undo the booking.
- **Reports** (`daily`, `summary`): plain text for WhatsApp / SMS / e-mail; slots are sorted the way Node's ICU `localeCompare` sorts them for ASCII (digits, spaces, punctuation, letters; other characters by code point).
- **Scheduler** (`JobRunner` since round 75, every `app.jobs.interval-seconds`, default 300, `0` switches it off; env `JOBS_INTERVAL_SECONDS`): unpaid bookings older than `paymentDueHours` are cancelled and their credit given back; Confirmed bookings of a past day become Completed; the day-before reminder (once per booking); the daily report from the set time, once a day; the weekly (Monday) or monthly (1st) summary. A community with no settings or templates gets the defaults. Days and `hh:mm` are read in the JVM time zone (**set `TZ`**, as for bookings). Each booking is locked and re-read inside its own transaction, so two servers never act twice.
- **Differences from Node.** HTML bodies are stripped to text with a regex (Node's server has no HTML parser and throws). The community's tax number is empty and the report line for it is omitted (as in Node). Tax and currency wording are India's (GST with CGST + SGST, the rupee). An unknown `{{token}}` prints nothing (JavaScript would print an inherited property such as `constructor`). `OutboxDispatcher` now reads the recipient name from `toLabel` when `toName` is absent.
- **Proof by replay.** `npm run gen:amenity-notify` (run in `TZ=Asia/Kolkata`) runs the real JavaScript over 500 random communities: 12 000 operations (5 000 message events, 4 000 booking actions, 2 000 reports, 1 000 scheduler passes at times on the day edges in India) and records every row queued, changed and returned; `AmenityNotifyConformanceCheck` replays them: 0 mismatches (9 287 outbox rows, 17 640 bell rows, 380 releases, 280 completions, 94 reminders, 104 daily and 56 summary reports). Fourteen deliberate faults were caught (release `>=`, report time `>`, Monday read in UTC, tax split 60/40, slot sort, admin switch, completion `<=`, bell roles, missing refund message, SMS line count, summary guard, version bump, inactive users, deposit-refund wording). Two were not, because they change nothing observable here: a day-before date computed in UTC (differs only in zones more than 12 hours from UTC) and `(inclusive ? ...)` in a line that is empty when the tax is zero.
- **A bug in the earlier port that this found:** a booking with no GST amount at all got GST columns on its ledger line; the JavaScript leaves them out. Fixed in `AmenityPosting`.

### 10.9 Notifications, late fees, background jobs, field encryption and phone sign-in (round 75)
**Notifications** (`com.communityos.notify`: `Notifier`, `EventNotifications`, `DueReminders`, `TicketApprovals`; port of `src/lib/notify.js`, `notifications.js`, `notifyExtra.js`, `dueReminders.js`).
- `Notifier` writes the in-app row (by name, unit or roles, plus the "Also tell" roles of Notifications → Channel settings) and one `notificationOutbox` row for each person who chose WhatsApp / SMS / e-mail when the community offers that channel for the event (`Queued — demo, not delivered`, or `Skipped — no phone number / e-mail address`). `deliverDirect` (scheduled reports) uses exactly the channels given.
- After a save, in the same transaction (`SecureRecordService.notifyAfterSave`): a task assigned, its status changed, a community request or a "me too", quotation decisions and "approval needed" (EC / final approvers from `approverSettings`), invoice approvals, new forum topics and polls, replies, closed ballots, task chat, new resident requests, release approvals / rejections / payments. A message that cannot be made is logged and the save stands. The person who made the change is not told.
- **Payment reminders**: the rules of the finance settings (on/off, every N days, lead time, maximum), the editable "Payment reminder" notice template, and the bill terms appended (tax breakdown, due date, the late-fee rule and what has built up; `finance/BillTerms`). As in the JavaScript, a cancelled bill that still shows an amount is reminded (only Paid is skipped).
- **E-voting**: "last chance to vote" to every unit that has not voted, once per ballot, within 2 days of closing.

**Money** (`com.communityos.finance`: `LateFees`, `RecurringBills`, `BillTerms`, `FinDates`, `ItcJob`, `UtilityTypes`, `SystemWriter`).
- Late fees: one fee bill per overdue bill per month after the grace days, the rule of the bill's own category, fees never earn fees, `maxMonths` caps them (36 when unset). The job adds them only when the community switched on "add automatically".
- **At pay time** (`PaymentService`, `includeLateFees`): the server adds the fees that built up on the asked bills as their own bills, then they are paid with the bill. A price check (`quote`) writes nothing: it counts the fees instead.
- **Receipt**: after a bill payment settles, the unit is told "Payment received · <unit>" (its own transaction, after the money is committed; a failed message never undoes a payment).
- Recurring bills raise this month's association bill once; GST input-credit check once a day for a registered society (GSTIN format and check character, invoice details, the `GstProvider`); utility types (Water and DG rows, the choices in the bill, rate-card, reading and notice-template fields, a notice template per utility).

**Background jobs** (`jobs/JobRunner`, replaces `AmenityJobs`): utility types, amenity scheduler, recurring bills, late fees, payment reminders, e-voting reminders, GST input credit, report schedules, in that order, every `app.jobs.interval-seconds` (300; `0` = off), and on demand with `POST /api/admin/jobs/run` (Super Admin). Each job of each community is one transaction that first takes `pg_try_advisory_xact_lock(727001, hashtext(community/job))`: a second server skips that job this time, and every job only does what is still due. (Node takes one session lock for the whole run; the effect is the same.)

**Scheduled reports** (`reports/ReportCatalog`, `ReportSchedules`): the eight built-in reports (bookings, dues, payments received, water & plant, tasks, audits, infrastructure, event work), the custom report from its stored recipe, columns / tax / totals / summary choices, Summary / Detailed / Excel / CSV text, the audiences (roles, people, all villas, selected villas, extra addresses), "skip when empty", and the `reportRuns` row.

**Proof by replay.** `npm run gen:jobs` (in `TZ=Asia/Kolkata`) runs the real JavaScript over 700 random communities, 15 346 operations: 2 800 task saves, 1 400 invoices, 2 800 other writes, 700 runs of each job, 902 reminder runs, 1 400 bill-terms texts and 444 hand-run reports. `JobsConformanceCheck` replays them and compares every row added (in order), every row changed, the audit lines and what was returned: **0 mismatches** (9 886 in-app rows, 8 523 outbox rows, 2 553 late-fee bills, 361 recurring bills, 548 report runs, 329 ledger lines checked for input credit, 1 164 field-choice changes). Of 12 deliberate faults, 11 were caught (late-fee month edge, "Also tell" roles, reminder frequency, telling yourself, dues sort, report time, GSTIN check character, recurring day cap, option order, and two in the bill terms); the twelfth (rounding of the CGST / SGST split) changes nothing visible, because the message rounds to whole rupees.

**Field encryption** (`crypto/FieldCrypto`, `adapter/persistence/EncryptingDocumentRepository`): AES-256-GCM for `aadhaar`, `panNumber`, `accountNumber`, `ssn`, `passportNumber`, `taxId` (or `ENCRYPT_FIELDS`), key `DATA_ENCRYPTION_KEY`, older keys in `DATA_ENCRYPTION_KEY_OLD`. The stored format is the Node one (`enc:v1:<keyid>:<iv>:<tag>:<data>`): values written by either server open in the other (checked both ways). The audit trail never shows these fields. A protected field cannot be searched or sorted on; a typed-table column built from one would hold ciphertext (none of the default fields is a typed column).

**Phone sign-in** (`com.communityos.auth`: `AuthService`, `Tokens`, `AuthStore` with `InMemoryAuthStore` / `JdbcAuthStore`, `LocalAuthentication`; `web/AuthController`; `app.security.mode=local`, settings `app.auth.*`).
- `POST /api/auth/request-code`, `/verify`, `/refresh`, `/switch-role`, `/logout`, `/demo`; `GET /api/auth/config`, `/community`, `/invite/{token}`, `/roster`, `/me`: the paths, bodies and messages of `auth.mjs`. Codes: 6 digits, salted SHA-256, 5 minutes, 3 tries, 20 s between codes, 5 per number and 30 per network an hour, a number locked for 15 minutes after 5 wrong codes. Access token HS256, 15 minutes; refresh token only in an HttpOnly cookie, rotated on every use, an old one revokes the session. The first sign-in activates an invited person and accepts the invite.
- Every request with a token: signature, issuer and expiry checked first (`SecurityConfig.LocalTokenFilter`, a bad or expired token gets 401 with `code`), then the session must still be live and the `users` row still active (`PrincipalResolver`), so logout or deactivation takes effect at once.
- Delivery `app.auth.otp-delivery`: `sms` (the SMS channel), `log` (default) or `echo` (demo; refused at start-up with `PAYMENT_ALLOW_SIMULATED=false`, as is the demo roster). `JWT_SECRET` (32+ characters) is required in `local` mode.
- Checked: 13 plain-Java tests (the sign-in cases of `api.test.mjs`: unknown and deactivated numbers, wrong codes burn the code, lock-out, rate limits and resend gap, expiry, refresh rotation and theft, logout, deactivation, role switch, invite links, demo roster, forged / altered / foreign / expired tokens); a token signed by Java verifies in Node and the other way round; the SQL of `JdbcAuthStore` and the advisory lock ran on PostgreSQL 16 against `db/V2`. Not run: the controller, the filter and the JDBC store through Spring.
- Differences from Node: the users of a phone number are found by reading the community's users (Node asks the `phone` column of the typed table); `otp-delivery` defaults to `log` (Node: `echo`); `sms` delivery is implemented (Node only logs); a price check with `includeLateFees` counts the fees instead of adding them and rolling back, so the returned `refs` name only fee bills that already exist.

### 10.10 Property and meeting hooks, several units, new communities, save conflicts (round 76)
**Phone numbers** (`people/Phones`): there is no libphonenumber jar in this build, so the part of libphonenumber-js 1.11.14 ("min" metadata) the app uses is ported: parse a number written with its country code (any spacing, full-width or Arabic-Indic digits, an extension, a `tel:` URI), possible / valid for its country, E.164 and the international format, and `validatePhone` / `phoneKey` of `src/lib/phone.js` with their messages and the placeholder check. It reads the same metadata file (`resources/phone/metadata.min.json`, copied from `node_modules`): **when the npm package is upgraded, copy the file again and run `npm run gen:people` + `PeopleConformanceCheck`.**

**Property register** (`people/PropertyHooks`, run by `SecureRecordService.put`): before the save, every phone is checked and stored in E.164, the primary owner's phone is required, a tenant when "Tenant occupied", a name and phone for each additional person, the old secondary-owner fields are folded into `people`, and one number is one person on the property and across the community (a refusal is a 403 with the message, and an audit "Denied" line). After the save, in the same transaction: a new number gets a user ("Invited") and a sign-in link by SMS + WhatsApp (outbox rows), a known number gets the villa added (or is re-invited if it was deactivated), a number that left the property loses that villa (the account is deactivated when it was all they had), its open invites are revoked, and one "Portal access" audit line says what happened. Links start at `app.site.public-url` (Node: `PUBLIC_APP_URL`).

**Meetings** (`people/MeetingHooks`): `publishedAt` is set when a meeting is first published to residents and kept; residents' roles are told (in-app + their channels) when a published meeting is new, moved, renamed, cancelled or gets minutes.

**Proof by replay.** `npm run gen:people` asks the real JavaScript about 24 071 typed numbers (every country code, odd spacing, extensions, URIs, placeholders) and 2 500 random communities (property checks, the after-save step, the form's access warning, meeting publish time and messages, invite addresses for seven kinds of install). `PeopleConformanceCheck`: **0 mismatches** (3 928 valid and 20 143 refused numbers, 398 accepted and 2 102 refused properties, 3 386 users and 3 880 invites created, 9 395 outbox rows, 1 706 meeting messages). Of 14 deliberate faults 12 were caught; the other two change nothing observable (a too-short length reported as "invalid length", which every caller treats alike; a no-op edit).

**Two bugs found on the way and fixed in both servers.** (1) On the Node server the invite links read `undefined//undefined/...#/join/...` (the server had no web address): it now builds them from `PUBLIC_APP_URL`. (2) Reactivating a user deleted `deactivatedAt` / `deactivatedReason`, but the stores merge fields into the saved row, so they came back: they are now blanked.

**A payer with several units.** Spring's principal now carries all of the person's units (`Principal.units`); a payment for a bill of any of them is accepted, never for another person's unit (Node already did this; now tested in both).

**Creating a community with a back end in charge** (`/api/platform/communities`: GET list with people counts, POST create, PATCH status; Node `platform.mjs`, Spring `platform/PlatformService` + `web/PlatformController`). The caller is the platform operator: every call carries `X-Platform-Key` = `PLATFORM_ADMIN_KEY` (Spring `app.platform.admin-key`, 16+ characters; empty = refused). One transaction writes the registry row, the starting data (roles, task types, templates, merge fields ... exactly what the browser console writes; Spring reads it from `resources/rulebook/new-community.json`, made by `npm run gen:new-community`) and the first Super Admin, who must have a valid phone and signs in with a code. The platform console asks for the key when the data source is a back end; it shows people counts only, not names (the platform does not see a community's people). Node can also load the demo data; Spring cannot.

**"Another user changed this record" on your own saves.** Two causes, both fixed in the browser: (a) with a server in charge, a save did not announce the change, so the screen kept the row with its old `recVersion` and the next save of the same record was refused; (b) against Spring in open mode the browser stepped the version itself before Spring checked it. Now the server alone decides when it is in charge (`/auth/config` returns `authority: "server"`; Spring always does), every write announces itself, the saved row (with its new version) replaces the one on screen, and a 409 on a version this tab itself wrote is retried once with the stored version. A real edit by someone else is still refused.

### 10.6 What was run, and what was not
- `RuleBookConformanceCheck`, `MoneyGuardConformanceCheck`, `AmenityConformanceCheck`, `EVotingConformanceCheck`, `AmenityNotifyConformanceCheck`, `JobsConformanceCheck` (round 75), `PeopleConformanceCheck` (round 76): 0 mismatches each (plain `java`, no JUnit).
- Round 76 adds 6 tests (101 in all): `PaymentServiceTest` several units, `SecureRecordServiceTest` property save + meeting announcement, `PlatformServiceTest` 3. `PlatformController` was desk-checked only, like the other controllers.
- 95 plain-Java tests with no Spring context (`JobRunnerTest` 2, `SecureRecordServiceTest` 24, `PaymentServiceTest` 19 (2 new: late fees at pay time, the receipt), `AuthServiceTest` 13, `IdempotencyFilterTest` 7, `QueryCompilerTest` 7, `AmenitySchedulerTest` 6, `FieldCryptoTest` 5, `PollRulesTest` 4, `AmenityEngineTest` 4, `CircuitBreakerTest` 4) plus the six conformance wrappers, through a small JUnit shim. They cover the settlement cases of `payments.test.mjs` (priced by the server, asked twice, other unit refused, forged / short / repeated / concurrent events, declined then retried, lost webhook, expiry, credit, donation receipt, booking claim) and the idempotency cases.
- **Not run:** Maven, any Spring context, `ApiContractTest` (MockMvc), PostgreSQL. The SQL of `JdbcPaymentStore` / `JdbcEventOutboxStore` / `JdbcIdempotencyStore` was run as prepared statements on PostgreSQL 16 against `db/V3` and `V4` (`src/test/resources/sql/payment-statements-check.sql`: every statement parses and runs, duplicates are refused), but never through the JDBC driver. REPEATABLE READ, `FOR UPDATE`, `SKIP LOCKED` and the `String[]` bind of `= ANY(?)` need a first run on real PostgreSQL; the in-memory profile serialises money steps with one monitor instead. The servlet filter, controllers, `SecurityConfig` and `ApiExceptionHandler` were desk-checked only.

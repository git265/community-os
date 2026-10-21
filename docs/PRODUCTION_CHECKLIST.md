# Production checklist: data integrity, security, payments, scale, audit

Each point of the review below is marked with where it stands. **Node** = the `backend/contract-server` reference (tested: `cd backend/contract-server && npm test`, 81 tests). **Spring** = `backend/spring`, which is **uncompiled** and has not received the Node work; the last column says what is left for it.

## 1. Data integrity and concurrency
| Point | Status | Where / what is left |
|---|---|---|
| Isolation levels | **Node: done.** Money (settling a payment) runs `REPEATABLE READ`; PostgreSQL aborts one of two conflicting transactions and the server re-runs it (up to 4 times, SQLSTATE 40001/40P01). Everything else is `READ COMMITTED` plus row locks. | `service.mjs` `run({isolation})`. Spring: set `@Transactional(isolation = REPEATABLE_READ)` on the settlement service when it is ported. |
| Pessimistic locking | **Node: done.** `SELECT … FOR UPDATE` on the record before every save/update/delete and on a payment order while settling. A payment claimed by two bookings at once is one atomic `UPDATE` (exactly one wins). | `lockRows`, `payments.mjs`. |
| Optimistic locking | **Node: done.** The screen sends the version it loaded; a stale save gets HTTP 409 with the current record and the UI shows it. Tested with parallel saves: exactly one wins. | Spring: the JSONB repository has no version check yet (the `@Version` equivalent is a `recVersion` compare in `upsert`). |
| Idempotency keys | **Node: done.** Every write may carry `Idempotency-Key` (the web app sends one on every write): a retry gets the stored first answer (`Idempotent-Replay: true`), the same key with a different request gets 422, a simultaneous duplicate gets 409/replay. Stored in PostgreSQL (`idempotency_keys`, unique key), 24 h. Payment orders have their own business key too. | `idempotency.mjs`. Redis is not needed for correctness; see section 4. |
| Transactions / rollback | **Node: done.** One PostgreSQL transaction per request covers the record, audit line, ledger entry and notification; any failure rolls back all of it (a refused attempt's audit line is kept). Spring: `rollbackFor = Exception.class` now set on the repository's transactional methods. | Spring service layer for payments does not exist yet. |

## 2. Security and compliance
| Point | Status | Notes |
|---|---|---|
| OAuth2/OIDC, short-lived JWT, refresh rotation | **Node: done** (15-min access token, rotating HttpOnly refresh cookie, theft detection, OIDC/Keycloak mode). **Spring:** JWT validation only. | docs/INTEGRATIONS.md §8 |
| RBAC / ABAC | **Node: done** (role → collection, own-unit rows, block scope, field hiding), tested over 18 roles. **Spring: ported in round 72** (Java rule book, conformance-tested; uncompiled by Maven). | docs/BACKEND.md §6 |
| TLS in transit | **Done at the edge, enforced here.** TLS 1.2/1.3 ends at your reverse proxy / load balancer; with `NODE_ENV=production` (or `REQUIRE_HTTPS=true`) the server answers 426 to anything that did not arrive over HTTPS (`TRUST_PROXY=true` to believe `X-Forwarded-Proto`) and sends HSTS, `nosniff`, `no-store`, frame denial. Spring: `forward-headers-strategy=framework` set; add a redirect/HSTS rule in the proxy. | |
| Encryption at rest | **Node: field level done.** `DATA_ENCRYPTION_KEY` (32 bytes) turns on AES-256-GCM for personal numbers (default fields: `aadhaar`, `panNumber`, `accountNumber`, `ssn`, `passportNumber`, `taxId`; change with `ENCRYPT_FIELDS`), with key rotation (`DATA_ENCRYPTION_KEY_OLD`). An encrypted field cannot be searched or sorted. **Also turn on disk/database encryption** (managed PostgreSQL, LUKS, TDE) and encrypt backups. Keys belong in a secret manager (KMS/Vault), not in the repo. | `fieldcrypto.mjs`. Spring: not ported. Encryption applies to the enforced (service) path; the legacy open mode stores plain. |
| PCI-DSS | **Node: guard done.** Card data never belongs on this server: the checkout page is the provider's. Any request carrying a Luhn-valid card number as a value, or fields named `cvv/cvc/cardNumber…`, is refused with 400 and not stored. Payment records keep only provider ids. Using the provider's hosted fields keeps the society at the lightest PCI scope (SAQ A); that is a legal/compliance decision for you and the provider. | `guards.mjs` |
| Rate limiting | **Node: done.** Per address (1200/min), per signed-in user (600/min) and sign-in endpoints (30/min per address), token bucket, HTTP 429 + `Retry-After`; the web app waits and retries reads. Plus the existing database-backed OTP limits and lockouts. The buckets are in memory per process: **with several instances enforce the same limits at the gateway** (nginx `limit_req`, Cloudflare, Spring Cloud Gateway/Bucket4j + Redis). | `guards.mjs`, env `RATE_*` |

## 3. Payment gateway integration
| Point | Status | Notes |
|---|---|---|
| Asynchronous + webhooks | **Node: done.** Order → provider checkout → signed webhook settles bill + ledger + receipt in one transaction; reconcile job for lost webhooks; "we're checking your payment" screen. | `payments.mjs` |
| Verify webhook signatures | **Node: done** (HMAC-SHA256, constant-time compare, forged/unsigned/mismatched amounts refused, duplicates ignored). Real providers: swap `sign()` for their SDK verifier (`Utils.verifyWebhookSignature` for Razorpay) | docs/INTEGRATIONS.md §6 |
| Message queue | **Node: transactional outbox done** (`event_outbox`): the follow-up work is written in the SAME transaction as the payment, then delivered by a worker with `SKIP LOCKED`, exponential back-off, and a `Dead` state after 8 tries. `OUTBOX_WEBHOOK_URL` forwards every event as JSON, so Kafka/RabbitMQ can be fed through a connector (Debezium/Kafka Connect HTTP sink) without changing the app. A broker is not required for correctness at this size. | `outbox.mjs`. Spring already has an outbox dispatcher for mail/SMS. |
| Saga pattern | **Not applicable:** this is one service and one database; the settlement is a single ACID transaction, which is better than a saga. If it is ever split into services, the outbox above is the building block for choreography with compensating events. | |

## 4. Scalability and fault tolerance
| Point | Status | Notes |
|---|---|---|
| Redis | **Deliberately not used.** Idempotency keys, sessions, OTP/lockout counters, advisory-locked jobs and the outbox all live in PostgreSQL, which keeps one thing to run and is correct across instances. (You also asked earlier not to add a general cache until needed.) Add Redis for distributed rate limits or hot lookups when measurements ask for it. | |
| Connection pool | **Done.** `PG_POOL_MAX` (20), connect timeout 10 s, `statement_timeout` 30 s, `idle_in_transaction_session_timeout` 60 s. Spring: Hikari equivalents in `application.yml`. | |
| Circuit breaker + timeouts | **Node: done.** Calls to a real provider's status API go through a breaker (5 failures → open for 30 s → one trial) with an 8 s timeout; the browser has its own timeouts and safe read retries. Spring: add Resilience4j `@CircuitBreaker` + `@TimeLimiter` on the provider adapter when it is written. | `breaker.mjs`; set `PAY.lookup` in the provider adapter. |
| Async / virtual threads | Node is non-blocking by design. **Spring:** `spring.threads.virtual.enabled=true` (Java 21+; the services build on Java 25) set. | |
| Known scale limit | Row scoping is applied after loading a collection, not in SQL; large collections (1M+ rows, 10M audit lines) need that pushed down and paging for the audit list. See docs/SCALE-AND-CONFIGURATION.md §4. | |

## 5. Auditing and observability
| Point | Status | Notes |
|---|---|---|
| Audit every critical action | **Node: done**, server-written only; includes who, role, when, what changed (before → after), denied attempts and sign-ins. Now also the **IP address and request id** of each line (`X-Request-Id` is returned to the caller and can be quoted to support). | |
| Never log secrets | **Done for the audit trail:** fields named like password/otp/token/card/aadhaar/account number and any encrypted field show `[hidden]`; card data is refused before it can be logged. Codes sent by SMS are only printed when `OTP_DELIVERY=log` (development). | `guards.mjs` |
| Monitoring | Health endpoint and server logs only. **To add before go-live:** structured JSON logs shipped to a log service, metrics (requests, 429/409/5xx, outbox `Dead` count, pending payment orders older than 10 minutes) and alerts on them. | |

## Before go-live (in order)
1. Port to Spring (or run the Node server): authorisation, auth/sessions, payment settlement, optimistic locking, idempotency, outbox. Point the same API tests at it.
2. Real SMS/OTP delivery; real payment provider adapter (webhook verifier + `PAY.lookup`); `PAYMENT_PROVIDER` not `simulated`.
3. `NODE_ENV=production`, `DATA_ENCRYPTION_KEY`, `JWT_SECRET`/OIDC, `CORS_ORIGIN`, `TRUST_PROXY` behind your TLS proxy; database and backup encryption.
4. Gateway-level rate limits if more than one instance; alerts on the outbox and pending payments.


## Round 71 additions
| Item | Status |
|---|---|
| Typed tables for units, users, dues, bookings, tickets, ledger, audit (FKs, indexes, `data jsonb` for extras) | **Node: done and tested.** **Spring: written** (`CollectionMappings`, `TypedDocumentRepository`, `RoutingDocumentRepository`), uncompiled by Maven. |
| JSONB kept for configurable collections | Done (`documents` table). |
| Route by collection in one place | Node `store/repository.mjs`; Spring `RoutingDocumentRepository`. |
| Audit partitioned by month | **Node: done.** Spring: table exists via the shared migration; no scheduled partition creation yet. |
| Row scope in SQL WHERE | **Node: done**, equal to memory path for 24+ roles. Spring: translator written (`ScopeSql`) and, since round 72, fed by the Java rule book (`RowScopes`). |
| Logging (request id, access line) and Swagger | Spring: written, syntax-checked only. |


## Round 72 additions (Spring parity)
| Item | Status |
|---|---|
| Authorization and row scope | **Spring: written** as a Java rule book, equal to the JavaScript on 72 675 generated decisions (`RuleBookConformanceTest`). Not built by Maven. |
| Locking (`FOR UPDATE`, `recVersion` -> 409) | Spring: written, tested in memory only; needs a PostgreSQL run. |
| Settlement (REPEATABLE READ, retry 40001/40P01, atomic bill + credit + ledger + receipt) | Spring: written, tested in memory; the isolation level itself needs a PostgreSQL run. |
| Idempotency-Key (replay, 422, 409, 24 h) | Spring: written (`IdempotencyFilter`), tested with fakes; not run in a servlet container. |
| Transactional outbox (SKIP LOCKED, back-off, Dead) | Spring: written (`EventOutbox`), tested in memory. |
| Circuit breaker around the provider | Spring: written and tested. |
| **Before going live** | `app.payments.allow-simulated=false`, a real provider adapter with `lookup`, `PAYMENT_WEBHOOK_SECRET`; `app.security.unported-hooks=refuse`; alerts on `event_outbox` rows with status `Dead` and on orders stuck `Pending`; run `mvn test` and `npm test` against the same PostgreSQL. |
| Not ported (when this table was written) | e-voting, field encryption, background jobs, OTP sign-in, late fees at pay time; e-voting and the amenity jobs came in round 74. |


## Round 76 additions (save conflicts, no caches, lazy loading, property / meeting hooks, several units, new communities)
| Item | Status |
|---|---|
| Own saves refused with "another user changed this record" | **Fixed** (browser): the server decides when it is in charge; the saved version replaces the one on screen. Real conflicts still refused. |
| Caches | **Removed.** `META_CACHE_MS` / `app.storage.meta-ttl-ms` default 0; raising them is possible but means role and setting changes show late. |
| Property / meeting hooks, meeting notifications | **Spring: written**, equal to the JavaScript on 24 071 numbers and 2 500 communities. When upgrading `libphonenumber-js`, copy `metadata.min.json` into `backend/spring/src/main/resources/phone/` and rerun `npm run gen:people`. |
| Invite links | Set `PUBLIC_APP_URL` (Node) / `app.site.public-url` (Spring) to the address people open; `DEFAULT_COMMUNITY` if not `la-paloma`. |
| Several units per payer | **Spring: written** and tested; Node tested. |
| Creating communities | `/api/platform/communities` on both servers. Set `PLATFORM_ADMIN_KEY` (a long random secret, known only to the operator; empty = off). The first Super Admin's phone is required. Spring does not load the demo data. After `src/lib/seed` changes, rerun `npm run gen:new-community`. |
| Still before going live | `mvn test`; create a test community through the console and sign in as its Super Admin with a real phone. |

## Round 75 additions (Spring: notifications, late fees, background jobs, field encryption, phone sign-in)
| Item | Status |
|---|---|
| Task, approval, invoice, forum, chat, release, payment-reminder and e-voting-reminder messages | **Spring: written**, equal to the JavaScript on 15 346 generated operations (with the jobs below). Written in the save's transaction; a failed message is logged and the save stands. |
| Late fees (job and at pay time), payment receipt message | **Spring: written.** Pay-time fees are added by the server before the order is priced; the receipt goes out after the payment commits. |
| Background jobs (utility types, amenity scheduler, recurring bills, late fees, payment and e-voting reminders, GST input credit, report schedules) | **Spring: written**, every `JOBS_INTERVAL_SECONDS` (300; `0` = off) and `POST /api/admin/jobs/run` (Super Admin). One transaction and one advisory lock per community and job: safe on several servers. |
| Field encryption | **Spring: written**, same format as Node (checked both ways). Set `DATA_ENCRYPTION_KEY` (keep old keys in `DATA_ENCRYPTION_KEY_OLD`); back the key up outside the database. |
| Phone sign-in (one-time codes, sessions, lock-out) | **Spring: written** (`SECURITY_MODE=local`), 13 tests, tokens interoperable with Node. Needs `JWT_SECRET` (32+ characters, the same on every server), `OTP_DELIVERY=sms` with a real SMS adapter, `COOKIE_SECURE=true` behind HTTPS. `echo` delivery and the demo roster are refused with `PAYMENT_ALLOW_SIMULATED=false`. |
| Before going live | Set `TZ`; pick `local` or `jwt` sign-in; configure SMS / e-mail and `app.channels.enabled=true`; run `mvn test` and `npm test`; sign in once with a real phone; run the jobs once by hand and read the audit trail. |
| Not ported | Property / meeting normalisation hooks and meeting notifications, payer with several units, tenant creation (BACKEND.md 10.4). |

## Round 74 additions (Spring: e-voting, amenity messages and scheduler)
| Item | Status |
|---|---|
| E-voting (eligibility, roll fingerprint, one-time code, single-use proof, sealed hash-chained ballot box) | **Spring: written**, equal to the JavaScript on 6 500 generated voting sessions (57 422 steps). Not built by Maven. Needs migration `V6` (`evoting_state`). |
| One-time code delivery | `app.evoting.delivery` = `sms` (real SMS channel), `log` (default, the code is in the server log) or `echo` (code shown in the browser: the application refuses to start with it when `PAYMENT_ALLOW_SIMULATED=false`). **Set `sms` before a real vote.** |
| Amenity messages (e-mail / SMS / WhatsApp rows, in-app bell, daily and summary reports) | **Spring: written**, equal to the JavaScript on 12 000 generated operations. Rows are queued in the booking's transaction; `OutboxDispatcher` sends them when `app.channels.enabled=true`. |
| Amenity scheduler (release unpaid, complete, day-before reminder, reports) | **Spring: written**, every `app.jobs.interval-seconds` (300; `0` = off). Safe on several servers (row lock and re-check). Reads days and times in the JVM time zone. |
| Before going live | Set `TZ` to the community's; choose the e-voting delivery; turn on `app.channels.enabled` with a real SMTP / HTTP adapter; run `mvn test` and `npm test`; test one real ballot end to end. |
| Not ported | Late fees at pay time, payment receipt message, field encryption, the other background jobs, OTP sign-in, ticket and approval notifications (BACKEND.md 10.4). |

## Round 73 additions (Spring: money guard, poll votes, amenities)
| Item | Status |
|---|---|
| Money guard (release caps, payment/ledger reversals, quotation and task rules) | **Spring: written**, equal to the JavaScript on 144 000 generated cases. Not built by Maven. |
| One poll answer per villa | Spring: written, unit-tested only. |
| Amenity pricing, booking window, cancellation refund, fee/deposit/credit postings | **Spring: written**, equal to the JavaScript on 18 000 decisions and 2 632 postings. Postings are atomic with the booking. |
| E-voting | **Still refused** (`ballots`, `voteRoll`, `ballotBox`): one-time-code proofs live in process memory and need an SMS/e-mail gateway; the sealed ballot box needs its own port. Keep `app.security.unported-hooks=refuse`. |
| Before going live | Set the JVM time zone (`TZ` or `-Duser.timezone`) to the community's; run `mvn test`. |
| Not ported | amenity notifications and scheduler (release unpaid, complete, reminders, reports), e-voting, plus the items in round 72. |

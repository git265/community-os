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
config     DataConfig (two pools), SecurityConfig, AuthConfig, ModulesConfig, CoreConfig, Jobs, CosProperties
```

The domain and application layers have no Spring imports. They depend on ports, and `Tx` is one of those ports. Use cases are therefore tested with in-memory adapters, and the same classes run against PostgreSQL in the flow test.

Persistence uses explicit SQL on `NamedParameterJdbcTemplate`, with no ORM. Every statement is a constant, or is composed by a public `listSql` / `getSql` method, so it can be checked against the database (§10).

### Design patterns

| Pattern | Where |
|---|---|
| Specification | `Spec` — one access rule, as both a SQL predicate and an in-memory predicate (deterministic parameter names) |
| Strategy | `AccessPolicy` (`UnitPolicy`, `DuePolicy`, `MemberPolicy`), `PaymentGateway`, `OtpSender`, `EventPublisher` |
| Chain of Responsibility | `Guard` / `GuardChain` |
| State | `DueStatus`, `OrderStatus`: each state lists where it may go; final states are final |
| Template Method | `Settlement.settle()`: verify → idempotency → lock → record and allocate → hook → events and audit |
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

OpenAPI is at `/v3/api-docs`, and metrics at `/actuator/prometheus`.

## 10. Web app: the v2 data source

To use it, pick **Back end v2** in the Data source panel, or set `VITE_USE_API=v2`. Modules keep calling `storage.*`. `src/lib/storage/v2/V2ApiAdapter.js` maps those calls onto the typed endpoints, and the field mapping is in `v2map.js`.

| The app's collection | v2 resource |
|---|---|
| `properties` | units. Only changed, allowed fields are sent, as PATCH with `If-Match`; extra fields go to `custom`. |
| `users` | members. A new user is POSTed; a role change is a PUT; Inactive means deactivate. |
| `dues` | bills. A new bill is POSTed: the typed amount is before tax, and the server adds the category's tax. Cancelled or Waived become cancel / waive. Amount edits are not sent; delete is refused. |
| `roles` | `GET /roles`, read only |
| `schema`, `communityConfig`, `financeSettings`, `roleGroups` | Kept in this browser until v2 has endpoints for them |
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
| Schema tests (`tools/test-schema.sh`): isolation, stamping, money rules, ledger balance, append-only audit, partitions, privileges | 15 / 15 |
| Java unit tests (javac against hand-written Spring stubs, JUnit shim): kernel, auth, members, access policies, billing | 39 / 39 |
| **PostgreSQL flow test** (`it/PostgresFlowTest`): the real adapters as `cos_app` / `cos_platform`, through a psql bridge, about 200 statements | 1 / 1 |
| Adapter SQL check (`tools/check-adapter-sql.sh`): every statement, including the list and detail queries composed with the real access rules of five kinds of caller, run with `PREPARE` + `EXPLAIN EXECUTE` as its role | 103 / 103 |
| Web adapter tests (`node tests/v2/run.mjs`): sign-in, units, bills, members, refusals and payment against a fake of the API | 6 / 6 |
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
2. Port the remaining modules onto their V6 tables, one at a time, each with a policy, a service, a controller and a v2 mapping: tickets, amenities, gate, notices, cultural, documents.
3. Add endpoints for the app's configuration collections (field definitions, settings).
4. Add refunds, late fees and bill runs: a bulk `POST /dues:batch`, keyset-paged.
5. Add ShedLock if a job must run on exactly one instance.
6. Move the rate limits to Redis when traffic needs it. The interface is already a port.

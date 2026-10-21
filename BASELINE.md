# Baseline r76 (2026-10-20)

Git tag `baseline-r76`. This is the reference version: later changes are compared with it, and it is the version to return to if a later round goes wrong.

## Since r76 (current structure)
- **One back end: `backend/api`** (Spring Boot 3.5, Java 25, PostgreSQL 18, `/api/v1`). The Node reference server (`backend/contract-server`), the
  r76 Spring service (`backend/spring`) and their schemas (`backend/db`, `backend/platform`) were retired; they remain at tag `baseline-r76` (commit 9ef79c0).
- **Two data sources in the app:** Session (browser demo) and Back end (v2). The "old API" mode, its adapter and the browser→server copy are gone.
- On the back end the app keeps reference lists for 30 s (dropped by any write or pushed change); records that move are always read fresh.
  Not-paged lists that hit their cap say so (`X-List-Truncated`). See docs/REDESIGN.md section 7.
- Unit numbers follow rules (characters, a community / block naming pattern, unique whatever their case), checked in the app and on the server; units and blocks can be added, renamed and imported on the back end. Names compare case-blind; e-mail addresses are stored in lower case. See docs/REDESIGN.md.
- A committee or staff member who owns a unit acts as its owner for that unit (pay dues, book, gate, tickets, donations). Amenities can be "Items only" (chairs, tables, linen hired with no space held; stock shared across bookings for the day). A vendor has one service line per category, each with employees and contractors; gate workers and fixed expenses name their line. Vendor GSTINs are checked (check character) on save; a vendor without one is "Unregistered vendor" for input credit.
- The r76 description below is kept as the record of that baseline.

## What is in it (r76)
- **Web app** (React / Vite): every module, Session (browser) or Back-end data source. Data is loaded only when the screen shows it; nothing is cached.
- **Node reference server** (`backend/contract-server`, PostgreSQL): every rule enforced in `AUTH_MODE=enforce`, phone sign-in, payments, jobs, the platform console's server side (`PLATFORM_ADMIN_KEY`), invite links from `PUBLIC_APP_URL`.
- **Spring Boot service** (`backend/spring`): parity with the Node server for authorization and row scope, money rules, payments and settlement, amenities, e-voting, notifications, the eight background jobs, field encryption, phone sign-in, the property and meeting hooks, payers with several units and creating a community.

## How it was checked
| Check | Result |
|---|---|
| Node API tests (`cd backend/contract-server && npm test`, PostgreSQL 16) | 92 / 92 pass |
| Spring plain-Java tests (javac against stubs, JUnit shim) | 101 / 101 pass |
| Spring replays of the real JavaScript (rule book, money guard, amenities, amenity messages, e-voting, jobs, people) | 7 corpora, 0 mismatches |
| Browser regression suite (62 Playwright scripts) | pass, except one patrol test that depends on the time of day |
| Production build (`npx vite build`) | builds |

## Known limits of this baseline
- **Spring has never been built by Maven** (Maven Central was not reachable): controllers, security filters and the JDBC stores have not run through Spring. Run `cd backend/spring && mvn test` first. The Node server is the tested reference.
- **Rules still only in the browser** (on both servers): building the approval steps of quotations, invoices, releases and expenses from the approval policies (the server checks each decision against the steps stored on the record, but not that those steps match the policies); required / conditional form fields; "a record with payments attached is never deleted"; cultural event totals; the gate (security) engine. Bulk property imports skip the phone and portal-access rules.
- Spring cannot load the demo data into a new community.

Details: `docs/BACKEND.md` (section 10), `docs/PRODUCTION_CHECKLIST.md`, `README.md` (Round 76).

# API calls per page: what each page calls, why, and what to change

Measured on 24 Oct 2026 against the v2 server (`/api/v1`). Use this document to decide what to fix first.

## 1. How it was measured
* **What was measured**
  * The production build (`vite build`, served by `vite preview` with the `/api` proxy) against the dev server on `cos_dev`. The dev build was not used, because React StrictMode doubles every read there.
  * Six people:
    * Super Admin
    * Treasurer (Gautam Shah)
    * Facility manager (Rohit Verma)
    * Owner and resident (Ananya Mehta)
    * Guard (Devendra Singh)
    * Plumber (Ramesh Kumar)
  * Every page in each person's menu, then every first-level tab on it.
* **How each call was recorded**
  * A headless browser recorded each `/api/v1` request: method, path (ids folded to `:id`), query keys, status, size and time.
  * A page counted as settled after 1.3 s with no calls, with a limit of 9 s.
  * The live stream (`/notifications/stream`) was held open. The dev server closes it at once, which would otherwise add a bell reload every second (see 6).
* **Data in `cos_dev`**

  | Records | Count |
  |---|---|
  | Units (synthetic towers) | 10,216 |
  | Bank lines | 3,835 |
  | Notifications | 206 |
  | Members | 41 |
  | Gate visits | 18 |
  | Dues | 15 |
  | Files | 13 |
  | Tickets | 9 |
  | Bookings | 8 |

  Unit volume is therefore the dominant factor. The other lists are small today, but they will grow.
* **Cold and warm**
  * **Cold:** the in-browser cache is emptied before each page. This is what a person sees on a page's first visit after sign-in, or after 30 s away.
  * **Warm:** pages are visited in order without clearing. This is what a person sees moving around.
  * The figure in brackets in the tables is the warm count.
* **Sizes** are as sent, uncompressed (the dev server does not compress). With gzip, the JSON is about 5× smaller.

## 2. Headline
* **About two thirds of all calls read the whole unit register.**
  * The register is read as `GET /units` (staff) or `GET /units/directory` (residents), 200 rows per call. At 10,216 units that is **52 calls and 4.5–6 MB** per page.
  * For the Super Admin, 574 of 861 calls are these reads.
  * Most pages that do this need only unit numbers, a count or one person's own block.
* **Guards and plumbers make 80 calls (6.3 MB) at sign-in.** Their first page is Maintenance, which reads the register.
* **Approvals are worked out in the browser** from about 9 lists. This happens on every staff sign-in and again on Billing.
* **Several pages read the same list twice:**
  * Payments
  * Gate console
  * Meetings
  * Documents
  * Vendors
  * Attendance
* **Some reads repeat once per row (N+1).** Service directory reads reviews once per contact, and E-voting reads ballots three times.
* **Some lists are read whole on every visit**, although they grow every month:
  * tickets
  * dues
  * bank lines (1.3 MB)
  * audit (6 pages for Coverage)
  * files by kind
* **Some screens poll.** The gate console reads its settings every 8 s. On site makes about 24 calls a minute.

## 3. Start-up: from the sign-in screen to the first page (cold)

| Person | Calls | Size | First page |
|---|---|---|---|
| Super Admin | 24 | 1.7 MB | Command Center |
| Treasurer | 24 | 1.7 MB | Command Center |
| Facility manager | 26 | 1.7 MB | Command Center |
| Owner | 14 | 0.4 MB | Command Center |
| Guard | 79 | 6.2 MB | **Maintenance** |
| Plumber | 80 | 6.2 MB | **Maintenance** |

The Super Admin's 24 calls, and why each is made:

| Call | Why |
|---|---|
| `GET /demo/roster/:community` (375 KB), `GET /public/communities/:slug`, `POST /auth/refresh` | Sign-in screen. The roster exists only in the demo; a real sign-in does not call it. |
| `POST /demo/sign-in`, `GET /me` | Who the person is, their roles and their permissions. |
| `GET /roles` | Builds the menu and the page and tab rights. |
| `GET /finance/settings` | Currency, financial year and money format, used everywhere. |
| `GET /notifications?limit=200` | The bell. After this, the live stream keeps it up to date. |
| `GET /summary/dashboard` | Command Center tiles, counted on the server. |
| `GET /units/index` (1.3 MB) | Number and block for every unit, so that records pointing at a unit can show its name. Kept for 60 s. |
| `quotations`, `cultural/expenses`, `maintenance/task-types`, `task-types`, `maintenance/approver-settings`, `finance/releases`, `finance/approval-policies`, `tickets` ×2, `files` ×2 | **"Waiting for you".** The approvals panel works out in the browser which items wait for this person (10 calls). |
| `comms/broadcasts`, `comms/important-numbers`, `comms/number-sections` | Command Center notices and important numbers. |

For the owner, `/units/:id` (their own home) takes the place of the approvals panel.

## 4. Per page (cold)
* Each cell gives: calls · size, then the warm count in brackets, then the extra calls when every tab is opened.
* "—" means the page is not in that person's menu.
* The guard's and the plumber's Maintenance shows 0 because it was already loaded at sign-in (section 3).

| Page | Super Admin | Treasurer | Facility mgr | Owner | Guard | Plumber |
|---|---|---|---|---|---|---|
| Command Center | 0 | 0 | 0 | 0 | — | — |
| Maintenance | 73 · 5.8 MB (70) +9 tabs | 73 · 5.8 MB (70) +7 tabs | 73 · 5.8 MB (70) +3 tabs | 68 · 1.7 MB (67) | 0 | 0 |
| Billing & Finance | 71 · 7.0 MB (15) +40 tabs | 71 · 7.0 MB (15) +40 tabs | 2 · 5 KB +90 tabs | 2 · 5 KB | — | — |
| Utilities & Assets | 59 · 4.4 MB (7) +2 tabs | 59 · 4.4 MB (7) +2 tabs | 59 · 4.4 MB (7) +2 tabs | — | — | — |
| Site map | 60 · 5.8 MB (7) +4 tabs | 60 · 5.8 MB (7) +4 tabs | 60 · 5.8 MB (7) +4 tabs | — | 60 · 5.8 MB (7) +4 tabs | 60 · 5.8 MB (7) +4 tabs |
| Reports | 4 · 1.3 MB (3) +76 tabs | 4 · 1.3 MB (3) +76 tabs | 4 · 1.3 MB +75 tabs | — | — | — |
| Audits | 2 · 5 KB | 2 · 5 KB | 2 · 5 KB +3 tabs | 2 · 3 KB | — | — |
| Amenities | 57 · 4.4 MB (4) +13 tabs | 57 · 4.4 MB (4) +13 tabs | 57 · 4.4 MB (56) +13 tabs | 60 · 1.7 MB (7) | — | — |
| Vendors | 6 · 19 KB (3) | 6 · 19 KB (3) | 6 · 19 KB (3) | — | — | — |
| On site | 7 · 1.4 MB (6) +9 tabs | 7 · 1.4 MB (6) +9 tabs | 7 · 1.4 MB (6) +9 tabs | — | 7 · 1.4 MB (6) | — |
| Security & Visitors | 67 · 7.1 MB (10) +74 tabs | 4 · 1.4 MB (2) +72 tabs | 4 · 1.4 MB (2) +20 tabs | — | 68 · 7.1 MB (13) +78 tabs | — |
| Workforce | 4 · 53 KB +2 tabs | 4 · 53 KB +1 tabs | 4 · 53 KB +2 tabs | — | 4 · 4 KB +1 tabs | 4 · 13 KB (3) +1 tabs |
| Unit Directory | 2 · 24 KB +1 tabs | 2 · 24 KB +1 tabs | 2 · 24 KB +1 tabs | 63 · 1.7 MB (9) +8 tabs | — | — |
| Calendar | 3 · 4 KB | 3 · 4 KB | 3 · 4 KB | 3 · 4 KB | 3 · 4 KB | 3 · 4 KB |
| Service directory | 7 · 29 KB | 7 · 29 KB (6) | 7 · 29 KB (6) | 7 · 11 KB (6) | — | — |
| Cultural | 10 · 25 KB | 10 · 25 KB | 13 · 26 KB (10) +3 tabs | 10 · 9 KB +2 tabs | — | — |
| Communications | 57 · 5.7 MB (5) +9 tabs | 57 · 5.7 MB (5) +9 tabs | 57 · 5.7 MB +9 tabs | 58 · 1.7 MB (57) +8 tabs | — | — |
| Governance | 9 · 1.3 MB (7) | 9 · 1.3 MB (7) | 8 · 1.3 MB (7) | 4 · 1 KB (3) | — | — |
| Documents | 3 · 4 KB | 3 · 4 KB | 3 · 2 KB | 3 · 3 KB | — | — |
| Users | 55 · 5.7 MB (2) | — | — | — | — | — |
| Community setup | 54 · 4.4 MB +2 tabs | — | 55 · 4.4 MB (2) +2 tabs | — | — | — |
| Roles & Permissions | 2 · 1.3 MB (0) | — | — | — | — | — |
| No-code Studio | 0 | — | — | — | — | — |
| Audit Trail | 2 · 1.3 MB +6 tabs | 2 · 1.3 MB (1) +6 tabs | — | — | — | — |
| My Gate | — | — | — | 2 · 4 KB +8 tabs | — | — |
| **All pages** | **614 · 57 MB (226)** | **440 · 40 MB (160)** | **426 · 36 MB (253)** | **282 · 7 MB (171)** | **142 · 14 MB (33)** | **67 · 6 MB (13)** |

**Why the warm count stays high on some pages.**
* The unit register is kept for only 30 s (`KEEP_MS` in `storage/index.js`). Once a page takes longer than that, the next page reads all 52 pages again.
* The page that needs it is reached cold. For example, Maintenance is the first page to need the register, so the warm crawl still made 70 calls there.
* Some pages read the register only when a person is a resident. That is why the owner's Maintenance (67) and Communications (57) stay high when warm.

### What each heavy page calls, and why
* **Maintenance** (73)
  * `52 × /units` (with the owner, `52 × /units/directory`): `ServiceNotices` loads the whole register only to find the person's own block (`useMyBlock`) and the block list for "notice to a block".
  * `tickets` ×2: the list and the active filter.
  * `summary/tickets`: the counts.
  * `files` ×4: attachment clips, read as every file of the kind.
  * `assets/equipment`: the asset picker.
  * `vendors/vendors`, `maintenance/categories`, `field-staff`: the assignment pickers.
  * `quotations`, `finance/releases`, `finance/approval-policies`, `maintenance/approver-settings`, `finance/settings`: the quote and approval state shown on tickets.
  * `maintenance/task-types` and `task-types`: two endpoints for one list (who may raise what).
  * `maintenance/quick-phrases`.
* **Billing & Finance**, Treasurer dashboard (71)
  * `52 × /units`: owner names and occupancy for defaulters.
  * Read whole and summed in the browser:
    * `finance/cash-book`
    * `finance/bank-accounts`
    * `finance/bank-lines` (1.3 MB, 3,835 rows)
    * `finance/fixed-expenses`
    * `finance/budget-lines`
    * `finance/deposits`
    * `dues` (all)
  * The approvals panel's lists again.
  * **Payments tab** (24 calls) reads these twice each:
    * `cash-book`
    * `ledger-skips`
    * `releases`
    * `quotations`
    * `tickets`

    It also reads `files` six times.
* **Utilities & Assets** (59)
  * `52 × /units`: the meter-reading sheet lists every unit with its owner and block.
  * `billing/readings`
  * `billing/rate-cards`
  * `billing/utility-types`
  * `dues`
  * the notice templates and merge fields
* **Site map** (60)
  * `52 × /units`: `impactOf`, which works out which units an asset outage affects.
  * `assets/equipment`
  * `assets/site-plans`
  * `assets/map-layers`
  * `assets/condition-log`
  * `tickets`: the open tickets on each asset.
* **Amenities** (57)
  * `52 × /units`: looks up the unit type, because rates differ by type.
  * `amenities/types`, `bookings`, `settings`, `items`
  * The owner also reads `availability`.
* **Security & Visitors**, gate console (67)
  * `52 × /units`: the unit picker on the gate console. The registry and the simulator also read the register.
  * `units/index`, `gate/visits`, `gate/people`, `gate/household-links`, `gate/approvals` and `gate/flags`: each is read **twice**, because the console and the panel beside it each load their own copy.
  * `POST /gate/beat`: the guard's "on duty" heartbeat.
  * `gate/settings`
  * The tab **Import from MyGate** reads the whole register again (54 calls) to match imported flats.
* **Communications** (57)
  * `52 × /units`: the reach counts for each audience ("All villas", "Selected blocks").
  * `comms/broadcasts`, `blocks`, `units/index`, `notice-templates`, `merge-fields`
  * The E-voting tab reads `governance/ballots` three times.
* **Users** (55): `52 × /units` only to show unit chips (unit numbers); also `members` and `blocks`.
* **Community setup** (54): `52 × /units` for bulk add and import (clash checks); also `blocks` and `units/naming`.
* **Reports, Data health tab** (73): the whole register plus about 16 lists, checked in the browser.
* **Unit Directory, owner** (63): `52 × /units/directory`, the whole contact directory, before anything is filtered. Staff use the paged `/units` and `/units/by-block` (2 calls).
* **Service directory** (7)
  * `vendors/directory` is read twice.
  * `vendors/directory/:id/reviews` is read **once per contact** (N+1).
* **Pages that read `/units/index` (1.3 MB) for names:**
  * Governance
  * Roles & Permissions
  * Audit Trail
  * Reports
  * On site

  The index is one call, but it is large, because each row carries a random UUID that does not compress.

## 5. Polling while a screen stays open (per minute, idle)

| Screen | Calls a minute | What |
|---|---|---|
| Security & Visitors (gate console) | about 8 + attendance | `gate/settings` every 8 s (`GateConsole.jsx`), with the ghost sweep on the same timer |
| On site | about 24 | `site/events` 7, `attendance` 4, `attendance-settings` 4, `gate/approvals` 3, `gate/visits` 3, `site/devices` 2 (`useSite`, `OnSiteLive` 20 s) |
| Any page | 2, only while the stream is down | `notifications/unread-count` every 30 s |

**Risk.** If a proxy or load balancer cuts the live stream short, `startLive` reconnects at once and `onReconnect` reloads the bell list, about once a second per open tab. This shows up in dev today, because the dev server closes the stream.

## 6. What to change

Fixes are listed by how much they save.
* **Flow** means only the app changes.
* **Schema / endpoint** means the server changes too.

| # | Change | Kind | Saves (Super Admin, cold) |
|---|---|---|---|
| 1 | Pages that need only names or counts use `/units/index` or `/units/by-block` instead of the whole register (see below). | Flow | 52 calls and 4–6 MB on each of 10 pages, about 470 calls |
| 2 | A slim **unit roster** for the pages that need more than names. | Schema / endpoint | the remaining register reads become 1 call |
| 3 | Cache the index and the roster with a version (ETag / `If-None-Match`); keep a copy in IndexedDB. | Endpoint + flow | 1.3 MB on each cold page becomes a 304 of a few bytes |
| 4 | `GET /approvals/waiting`: the server lists what waits for the caller. | Endpoint | 10 calls at every staff sign-in and 10 on Billing; no whole ticket list |
| 5 | `GET /summary/finance` and `GET /dues/defaulters`: the dashboard totals and defaulters by unit are summed in SQL. | Endpoint | Billing dashboard 15 calls to about 3; bank lines (1.3 MB) no longer read whole |
| 6 | One shared load per page, and a short dedupe window (2–3 s) for identical GETs. | Flow | Payments 24 to about 18 (13 with change 7); gate console 6; Meetings, Documents, Vendors and Attendance 1 each |
| 7 | Show file counts in list rows (`file_count` kept by a trigger, or a count in the list SQL); open the files only on the record. | Schema | 1–6 calls on most pages; stops `/files?ownerType` growing with every upload |
| 8 | One task-type endpoint: `/maintenance/task-types` with a `canRaise` flag, and `/task-types` removed. | Endpoint | 1 call on every page that lists task types |
| 9 | Show the rating and count in `/vendors/directory` rows; read reviews when a contact is opened. Read E-voting ballots once. | Endpoint + flow | N calls (one per contact) and 2 calls |
| 10 | Server-side data health (`GET /reports/data-health`, checks in SQL); audit coverage counted on the server (`GET /audit/coverage`). | Endpoint | 73 calls to 1; 6 to 1 |
| 11 | Page the tickets and bank lines everywhere they are listed; dashboards use counts. | Flow + endpoint | grows with data: tickets and bank lines today, hundreds of KB a year from now |
| 12 | Send gate and site changes over the existing live stream (event `gate.visit`, `site.event`, `attendance`) instead of polling. Cache the gate settings until a change event. | Endpoint + flow | about 30 calls a minute on the guard's screens |
| 13 | Back off when the live stream reconnects (1 s, 2 s, 4 s … 60 s); reload the bell only when events were missed (`Last-Event-ID`). | Flow | prevents the once-a-second reload |
| 14 | Land the guard on the gate console and the plumber on "My tasks" (`tickets?mine&active`), not Maintenance. | Flow | sign-in 80 calls to about 25 |

### Change 1 in detail: where the register is not needed

| Page | Needs | Use instead |
|---|---|---|
| Maintenance (`ServiceNotices`) | the person's own block and the block list | `/me` or `/units/:id` for the person's own home; `/blocks` for the list |
| Communications | how many homes each audience reaches | `/units/by-block`, extended with a split by type (villa, apartment …) |
| Amenities | the type of the booking's unit | `/units/:id` for the chosen unit, or the type in the roster |
| Users, Documents, Roles & Permissions | unit numbers | `/units/index` |
| Gate console, registry, simulator | a unit picker | `/units/index`, or a search box over `/units?q=` (the server already filters) |
| Site map (`impactOf`) | units of a block | `/units/index` (it already carries the block) |
| Community setup import, MyGate import | clash checks and matching flats | the import endpoint checks on the server and returns the rows it could not match |
| Owner: Unit Directory, Maintenance, Amenities, Communications | the person's own home; the directory paged | the paged directory (already exists: `PAGED.directory` in `V2ApiAdapter.js`) and `/units/:id` |

### Change 2 in detail: the unit roster
* **What stays whole.** Billing defaulters, the meter-reading sheet and Data health really do need every unit, but only a few columns of each.
* **The endpoint.** Change `/units/index` into the roster:

  `GET /units/index?fields=type,occupancy,contact`

  Each row would have: `id, unit_no, block_id, type, occupancy, contact name`. The contact is the bill-to person, or else the owner.
* **The work is in one SQL statement.** It joins `property.unit` to the current `property.occupant` where `primary` and `to_date IS NULL`, using the existing `INDEX` query with these columns added.
* **Size.**
  * The UUID is most of the size: 285 KB gzipped for 10,216 rows, against about 28 KB for number and block alone.
  * Optional schema change: a short per-community number `unit.seq` (an int). The roster would carry `seq` instead of the UUID, and records would keep the UUID. That makes the roster about 10× smaller.
* **Versioning.**
  * A version on the community, `property.unit_version`, bumped by the trigger that already stamps unit rows.
  * The roster then answers `304 Not Modified` until a unit or a block changes.
  * The browser keeps it in IndexedDB across sign-ins, instead of the 30 s and 60 s windows.

### Expected result
These figures apply changes 1, 2, 6, 7, 8 and 9 to the recorded calls, and change 4 to the start-up. Changes 5 and 10 cut Billing and Reports further.

| Person | Start-up | All pages | All tabs |
|---|---|---|---|
| Super Admin | 24 → about 14 | 614 → about 114 | 247 → about 115 |
| Treasurer | 24 → about 14 | 440 → about 101 | 240 → about 110 |
| Facility manager | 26 → about 16 | 426 → about 91 | 236 → about 105 |
| Owner | 14 → 14 | 282 → about 56 | 26 → about 22 |
| Guard | 79 → about 23 | 142 → about 29 | 83 → about 29 |
| Plumber | 80 → about 23 | 67 → about 12 | 5 → about 2 |

## 7. At other sizes
How the register reads scale with the number of units:

| Units | Calls to read the register |
|---|---|
| 10,216 (as measured) | 52 |
| 1,000 (the sizing target) | 5 |
| La Paloma's real units | 2 |

At La Paloma's size the register costs little. The fixes matter as communities grow, and they matter on phones (6 MB per page on mobile data).

Changes 4, 5, 10 and 11 take work that grows with the community's history off the browser and are worth doing at any size. Changes 1 and 14 are small app changes.

## 8. Re-measuring
The scripts are kept outside the repo. To re-measure:
1. Run `vite build`, then `vite preview` with an `/api` proxy to the server.
2. Point a Playwright crawl at it that signs in as each person, opens every page and tab, and records the `/api/v1` requests. Keep `**/notifications/stream` held open.
3. Run it cold (clear `sessionStorage` and the cache before each page) and warm.

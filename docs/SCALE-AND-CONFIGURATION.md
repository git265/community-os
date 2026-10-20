# CommunityOS — configuring for a community, and scaling to a township

## 1. What is configuration (no code) and where it lives
| What | Where | Stored as |
|---|---|---|
| Blocks / towers / phases | Community setup → Blocks & units | `blocks` |
| Units (single, range, Excel) | Community setup → Blocks & units | `properties` |
| Property types (Villa, Apartment, Plot, Shop …) | Community setup → Money & financial year; also typed freely in the unit form | `communityConfig.propertyTypes` + values already used |
| Facilities / locations (Clubhouse A, Pool 2, STP-1 …) | Community setup → Facilities | `facilities` |
| Amenity at a facility | Amenities → Rates & rules → Booking setup → Located at | `amenityTypes.facility` |
| Currency symbol, number grouping, large-amount unit, financial-year start month | Community setup → Money & financial year | `communityConfig` (one row) |
| Block-limited staff (block secretary / block admin) | Users → edit a non-resident user → "Limited to blocks" | `users.blocks` |
| Roles, permissions, tabs, pages, custom fields | Roles & Permissions, No-code Studio | `roles`, `schema` |

A user with `blocks` set sees, and may change, only units of those blocks — properties, dues, tickets, amenity bookings, readings,
credits, visitors, donations. Rows that name no unit stay visible. Enforced twice: row scope on every read (`withBlockScope` in
`lib/security/authz.js`) and a write guard (`blockWriteOk`) used by `put`, `remove`, `createMany`, `updateMany`. The Super Admin is never limited.

## 2. What is still La Paloma-specific (honest list)
* Literal `₹` in about 170 labels/messages is swapped in the page text when another symbol is chosen (`lib/locale.js`); numbers follow the chosen grouping everywhere (`toLocaleString('en-IN')` is routed through `numberLocale()`). Proper i18n of those strings is a later pass.
* "Budget in lakhs": the budget workbook works in units of 1,00,000 internally; with another amount unit it is *displayed* converted.
* Bank statement import rules are seeded from La Paloma's bank format (editable per community in Accounts & budget → Bank statements → import profile).
* Announcement audiences "All villas" / "All apartments" mean property type exactly `Villa` / `Apartment`. Use **Selected blocks** or **Selected villas** for other types.
* Parking is still only a number on each unit (no spot inventory).

## 3. Measured at township size (browser demo adapter)
Synthetic community from Platform console → New community → "Load large test data": 5 blocks, 2,000 units, 24,000 dues (12 months),
400 tickets, 3,000 bookings, 11 facilities, 7 amenities. Chromium headless, dev server:

| Action | Before batching | Now |
|---|---|---|
| Open Unit Directory (2,000 units) | 26.6 s (the 5-minute payment-reminder sweep blocked the page) | ~1.6 s |
| Dues list (24,000 rows, 50 at a time) | 0.7 s | 0.8 s |
| Publish maintenance fee to 2,025 units | one write per unit | 0.7 s |
| Payment reminders to 5,359 unpaid bills | one write per bill | 1.7 s |
| Import 2,000 units from Excel | – | 0.4 s |
| Search units / filter by block | – | ~0.15–0.75 s |

What changed: `putMany` on the storage contract (one read + one write), `createMany` / `updateMany` on `secureStorage` (one
authorisation, one audit line), `notifyMany` (one write for notifications and one for the e-mail/SMS/WhatsApp outbox, recipients
indexed once), Set look-ups instead of nested scans in the fee preview.

Browser-demo limit: `sessionStorage` is ~5 MB per tab. A collection that no longer fits is kept in memory and mirrored to this tab's
IndexedDB (`lib/storage/spillStore.js`), so a reload keeps it; a banner says so. This does not exist in production.

## 4. API contract for the Spring Boot + PostgreSQL back end (so the screens stay fast)
The front end only asks for one page at a time through `query`; keep these semantics server-side:

```
GET  /api/{collection}/query?page=1&pageSize=50&sort=unit:asc&search=..&dateKey=..&from=..&to=..&f.zone=Tower B&f.status=Overdue
     -> { rows, total, page, pageSize, pages }
POST /api/{collection}/bulk        body: Record[]   -> upsert all in ONE transaction, returns saved Records   (putMany)
```
* Every request carries `X-Community-Id`; derive it from the token and reject a mismatch.
* Row scope (resident → own unit; block-limited staff → units of their blocks) must be applied in SQL, not after loading:
  `WHERE tenant = :t AND (:blocks IS NULL OR data->>'zone' = ANY(:blocks))` (units: join `properties` on `data->>'unit'`).
* Indexes (JSONB): btree on `(tenant, data->>'unit')`, `(tenant, data->>'status')`, `(tenant, data->>'billedMonth')`, `(tenant, data->>'dueDate')`;
  GIN `jsonb_path_ops` on `data` for free-text; `pg_trgm` on `unit`, `owner`, `title` for the search box.
* Dashboards currently add up whole collections in the browser. For 24,000+ dues add aggregate endpoints:
  `GET /api/dues/summary?from=&to=&group=category,status` → `[{category,status,count,amount}]`, and the same for ledger and tickets.
* Notification fan-out (announcement to 2,000 units, reminders) should be a queued job, not a request; `notifyMany` is the seam.
* File bytes go to object storage (S3 / Azure Blob); only the metadata row stays in PostgreSQL.


### 4a. Storage layout and row scope (round 71)
Hot collections use real tables (units, users, dues, bookings, tickets, ledger, audit by month); configurable ones stay JSONB. `GET /api/{collection}/query` applies the caller's row scope in the SQL WHERE for typed tables and stops counting at 100 000. Details: docs/BACKEND.md section 9.

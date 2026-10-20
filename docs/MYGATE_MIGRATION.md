# Moving from MyGate to CommunityOS: plan and steps

## What we can and cannot rely on
* MyGate is a separate company’s product. CommunityOS does **not** connect to it: no login to MyGate, no scraping, no private API.
  The only supported route is the one a society admin already has: **download the lists from the MyGate admin portal as Excel/CSV** and import them here.
* **Check first** which downloads your MyGate plan offers (residents/flat directory, daily-help register, vehicles, visitor log, complaints, notices, payments). Plans and portal versions differ, and I could not verify MyGate’s current export columns.
  That is why the importer **recognises columns by synonyms and lets you correct the match**, instead of expecting fixed headings. If MyGate gives a list only as a PDF or on screen, ask MyGate support for an export, or key the list into the template (`Download a template`).
* Your contract and MyGate’s terms decide whether you may export and re-use resident data. Read them, and ask MyGate in writing for a full export before you cancel.

## Privacy and consent (do not skip)
Resident, visitor and staff data is personal data (in India: Digital Personal Data Protection Act, 2023; elsewhere GDPR-like rules).
* Tell residents before moving: what moves, why, who sees it, and how to correct or delete it. Residents entered their data in MyGate; the society is now the one responsible for it.
* Move only what you need. The importer: keeps **only the last 4 digits** of any ID number; keeps visitors’ phone numbers **masked** unless you tick the box; never imports photos, face data or OTPs.
* Treat the export files as sensitive: store them on the admin’s own device or encrypted storage, delete them after the import, never e-mail or chat them.

## Plan in six steps
| Step | Who | What | Done when |
|---|---|---|---|
| 1. Decide | Committee | Pick a cut-over date; decide whether to run both for 1-2 weeks | date agreed |
| 2. Export | Society admin | In MyGate admin download: residents/flats, daily help, vehicles, visitor log (last 12-24 months is plenty) | files saved |
| 3. Residents & flats | Super Admin | Unit Directory → Import units (or Security → Import from MyGate → 1). Fix rows the review rejects (usually phone formats). | every villa/flat exists with owner and phone |
| 4. Daily help, vehicles | Security manager | Security → **Import from MyGate** → 2 and 3. People arrive as **Under review**; security checks ID and police verification, enrols faces, then sets them Active. | registry matches the old list |
| 5. Visitor history | Super Admin | → 4. History appears in Security → Visits, marked “Imported from MyGate”. Not needed for the gate to work; it keeps reports and “who came last year”. | optional |
| 6. Cut over | Committee | Announce date; residents sign in to CommunityOS (phone OTP); guards use the gate console; run both a week; then close MyGate | MyGate off |

**Order matters:** villas first (daily help and vehicles are linked to villa numbers; an unknown villa is reported and its link skipped).
**You can re-run any step.** People are matched on mobile number, vehicles on plate, visits on name + villa + time, so a second run updates instead of doubling. An import is also one audit-logged action per list.

## What each list becomes
| MyGate list (typical headings) | CommunityOS | Rules applied |
|---|---|---|
| Residents / flats (Flat, Block, Owner/Resident name, Mobile, Email, Resident type) | Properties & residents (existing Unit import) | owner + valid phone required; tenant rows need a tenant; duplicate phone across different people refused; new blocks can be created |
| Daily help / staff (Name, Mobile, Type, Flats, Aadhaar) | Gate registry (`gatePeople`) + villa links (`gateLinks`) | mobile → international format (10-digit gets `+91`, changeable); type → Maid/cook, Nanny, Driver, Landscaper, Delivery rider, Daily worker, Other; flats split on `, ; / |`; status **Under review** by default (Active only after you confirm they were vetted); ID → last 4; unknown villa → warning, link skipped; no days/hours are set (add them per villa) |
| Vehicles (Vehicle no, Flat, Owner) | Gate vehicles (`gateVehicles`) | plate upper-cased without spaces/dashes, 4-12 letters/digits; class Resident; same plate = update |
| Visitor log (Name, In, Out, Flat, Type, Purpose, Mobile, Vehicle) | Gate visits (`gateVisits`) as history | dates read day-first (05/10/2026 14:32, 5-Oct-2026 2:32 PM, ISO, Excel dates); type → Guest/Delivery/Cab/Maid/Driver/Crew/Other; state Exited (or Auto-closed without an exit time); exit before entry → exit dropped; phone masked to last 4 |
| Complaints / helpdesk | **not imported** | open ones are better re-raised in CommunityOS (new categories, assignment, SLA); export the history as PDF/Excel for your records. Can be added as a dataset in `lib/migrate/mygate.js` if you want closed history in Tickets |
| Notices / announcements | **not imported** | re-post the live ones; history is rarely needed |
| Payments / invoices / dues | **not imported** | money needs opening balances reconciled by the treasurer: enter closing dues per unit as the opening balance and keep MyGate’s statements for audit |
| Amenity bookings | **not imported** | future bookings: re-enter (few); past: not needed |
| Photos, face data, OTP/PIN, app accounts | **never** | residents install CommunityOS and register fresh; guards re-enrol faces |

## Doing it (screens)
Security & Visitors → **Import from MyGate** (visible to Super Admin, Security managers and the committee).
1. Open a list → choose the file → check the **column match** (change any wrong one) and the options (country code for 10-digit numbers; status for new people; keep full visitor numbers or not).
2. **Review** shows new / already here / skipped (with line numbers and reasons) / warnings. Nothing is written yet.
3. **Import**. Fix the skipped rows in the file and run again; only those rows are new work.
4. **Download a template** gives the exact columns the importer reads; **Download what is here now (CSV)** exports the current list in that same layout (a safety copy before a big import, and a way to move data on).

## Rollback
Each import is a few audit-logged bulk actions (“Imported from MyGate …”). People and vehicles added by mistake can be removed from their lists (filter by the shortIds in the audit line). For a full undo before go-live, use the Data source panel: copy the community Back end → Browser *before* importing, or take a `pg_dump`.

## Risks to watch
* Phone formats: Excel turns `9845012345` into a number or `9.845e9`. Format the column as text, or send CSV; the importer handles `.0`, 10-digit, `0`-prefixed and `91`-prefixed numbers.
* The same maid works for several flats: MyGate lists her once with several flats, or once per flat. Both work (matched by mobile); links are added per villa.
* Staff without a mobile cannot be imported (the registry needs a number); add them by hand.
* Names in your MyGate export may differ in spelling from the directory; match is on villa number, not name.
* Visitor history for a large society can be tens of thousands of rows; import by quarter if the browser feels slow. With the back end data source it is stored in PostgreSQL, not the browser.

## Extending
Add a dataset in `src/lib/migrate/mygate.js`: its `fields` and `syn` (heading synonyms), a builder `(grid, headerRow, map, ctx) → {rows, errors, warnings}`, an entry in `DATASETS`/`BUILDERS`/`TEMPLATE`, and its collection in `COLS` in `modules/gate/MyGateImport.jsx`. The same screen then handles it. A live MyGate API integration, if MyGate ever offers one to societies, would be a new adapter that produces the same grid.

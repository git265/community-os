# Billing & Finance — what is built, where it lives, what the backend must own

Everything here is configuration-driven and works for any community (currency, financial year and blocks come from *Community setup*).
All of it runs through the same write path (authorize → stamp → persist → audit) except the system postings noted below.

## Screens (Billing & Finance)
| Tab | What it has |
|---|---|
| **Dues** (toolbar) | 📣 Publish maintenance fee · 🏗 Special levy · ⏱ Late fees · 💳 Credits & advances · 🔔 Payment reminders · ⚙ Rules. A bill's detail has **Pay in instalments…** |
| **Defaulters** | Overdue units by age (1-30/31-60/61-90/90+), sort by amount/days, select → **Reminder / Demand / Final notice** (editable wording, kept as records, printable), waive late fees, CSV |
| **Payments** | + New payment (fund, TDS, GST, second-approver rule), ＋ Other income, 🔁 Recurring bills, "waiting for approval" list |
| **Reports** | Income & expenditure (+ by bank account), Funds, Levies, Unit statement, TDS (+ deposit), Cash book (+ cash count). Each prints (🖨) and exports CSV |

## Rules
* **Charge rules** (`lib/finance/rules.js → chargeFor`): *Flat per unit*, *Per sq ft*, *Per bedroom*; the rate can be replaced per property type (Villa/Apartment "pay instead") and per block (a block's rate wins). Units with no area/bedrooms recorded are skipped and counted in the preview. Used by the maintenance fee and by levies.
* **Late fees**: fixed ₹ or % of the bill per month, grace days, optional stop-after-N-months, optional automatic monthly run (5-minute scheduler). One `Late fee` bill per overdue bill per month (`lateFeeFor` + `lateFeeNo` make it idempotent); late fees never earn fees. Waive = remove the unpaid fee (audited).
* **Special levies** (`levies`): name, purpose, fund, basis/rate, scope (all / blocks / types), due date → one `Special levy` bill per unit (`levyId`). Payments post to the levy's **fund** (`ledger.fund`). Reports → Levies shows raised / collected / pending.
* **Credit notes & advances** (`unitCredits`, rows tagged `kind`): a credit note is a different amount per unit (paste `unit, amount` lines); *adjust against the next bill* keeps it as credit, *refund* pays it from the bank. An **advance** is booked in the ledger when received and held as credit. Credit is used on the unit's unpaid bills oldest-first (a bill is cleared if covered, otherwise reduced; `grossAmount`/`creditApplied` keep the original). Amenity refunds sit in the same account but are **not** auto-spent on dues.
* **Payment plans**: any unpaid bill → 2–24 monthly instalments (`splitDue`); the first keeps the bill number.
* **Defaulters + amenity block**: *Rules → stop amenity booking for units overdue ≥ N days and owing > ₹X*. Enforced in `amenityServer.amenityPreWrite` (residents only; staff can still reserve).
* **Bill to**: Properties → *Bills go to* Owner/Tenant; bills carry `billTo`/`billedTo`; defaulter notices go to the tenant when set.
* **Funds**: `kind` = Operating / Sinking / Corpus / Restricted. Tag a fund on a payment, on income, or via a levy.
* **TDS**: on a payment, *Deduct TDS* (194C/J/I/H/Q/A with default rates, editable). The ledger amount is what left the bank; `tdsAmount` is held back; expenditure reports show gross. Reports → TDS lists deducted vs deposited and records the challan deposit. **Thresholds / lower-deduction certificates are not applied — confirm with the CA.**
* **Period lock**: *Rules → books closed up to*. `lib/finance/lock.js` blocks add / change / delete of ledger rows dated on or before it (Treasurer / President / Super Admin set it).
* **Approval limit**: *Rules → payments above ₹X need a second approver*. The payment becomes a `payRequests` row; a different person with ledger rights approves → the payment is recorded.
* **Recurring bills** (`recurringBills`): raise the month's association bill automatically (idempotent per month).
* **Other income**: parking/hall/tower/hoarding/interest/scrap… recorded as ledger credits under that head (+ optional fund).
* **Cash book**: ledger rows paid in cash with a running balance, and cash counts (`cashCounts`) that record the difference.

## What a Spring Boot backend must own
These run in the browser today (they read/write below the permission layer like `amenityServer.js`) and must move server-side, each as one transaction:

| Operation | Suggested endpoint | Notes |
|---|---|---|
| Publish fee / raise levy | `POST /billing/fee-runs`, `POST /levies` | idempotent per (unit, period) / levy; bulk insert |
| Late-fee run | `POST /billing/late-fees/run` | scheduler; unique `(lateFeeFor, lateFeeNo)` |
| Credit notes / advances / apply credit | `POST /credits/notes`, `POST /credits/advances`, `POST /credits/apply` | ledger row + credit rows in one transaction |
| Payment plan | `POST /dues/{id}/plan` | |
| Notices | `POST /defaulters/notices` | store a record per unit |
| Pay request approve | `POST /pay-requests/{id}/approve` | server checks approver ≠ requester |
| Period lock | server-side check on every ledger write | the browser check is a convenience only |

Suggested indexes: `dues(unit, status, dueDate)`, `dues(levyId)`, `dues(lateFeeFor, lateFeeNo)` unique, `ledger(date, type)`, `ledger(fund)`, `ledger(tdsSection, vendor)`, `unitCredits(unit)`.

## Not built / honest limits
* **Online payment gateway**: not connected (needs a provider and the backend webhook). `lib/finance/gateway.js` documents the contract; today the owner's Pay is a demo that marks the bill paid.
* **Not double-entry**: reports are cash-basis from the ledger. There is no trial balance or balance sheet; the auditor prepares statutory accounts.
* **GST on income** (e.g. GST on rent/hall hire) is not computed; GST handling is India-only.
* **TDS** has no thresholds, no PAN checks, no Form 26Q/challan export.
* **Credit/advance** posting is automatic but only oldest-bill-first; no per-bill-type priority.
* Late fees are simple (no compounding, no interest on interest).

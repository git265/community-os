# CommunityOS - architecture, extension points and the Spring Boot hand-off

> The Spring Boot + PostgreSQL service now exists in `backend/`. See **BACKEND.md** (design, contract, running), **INTEGRATIONS.md** (every outside system, how to switch) and **MYGATE_MIGRATION.md**. The sections below remain the design notes.

The rule of the codebase: **the screens know *what* to do; small replaceable classes/modules know *how*.**
Anything that differs by country, provider or storage is behind an interface and chosen by a registry entry, never an `if` in a screen.

## 1. Layers

| Layer | Where | Rule |
|---|---|---|
| Screens | `src/modules/*`, `src/components/*` | Render and collect input. No money maths, no provider calls, no raw storage. |
| Schema | `src/lib/schema/registry.js` | Every collection's fields, who may see/edit them. Forms and tables are generated from it. |
| Rules / engines | `src/lib/finance/*`, `amenityEngine.js`, `billText.js`, `deleteGuard.js`, `approval/*` | Pure functions where possible, so the same rule can be re-implemented on the server and compared. |
| Write path | `lib/security/secureStorage.js` | authorize → stamp → persist → audit → notify. The only way screens write. |
| Storage | `lib/storage/StorageAdapter.js` (+ `SessionStorageAdapter`, `ApiStorageAdapter`) | Swap the adapter for Spring Boot + PostgreSQL JSONB; nothing above changes. |
| Region | `lib/region/regions.js` | Country profile: currency, tax name and split, number format, FY month, gateways. |
| Payments | `lib/payments/*` | `PaymentGateway` interface + registry + `PaymentService`. |

## 2. Multiple countries (hooks, not forks)

`registerRegion({ code, name, currency, tax: { name, idLabel, split }, defaults, gateways })`.
A community picks its **Country** in Community setup; `setCommunityConfig()` activates the region, and its defaults
(currency symbol, number grouping, FY start) apply until the community overrides them.

* Tax text: `billText.taxBreakdown()` splits a tax per the region (India: CGST + SGST; UAE/UK: one VAT line; AU/SG: GST).
* Messages use `{{tax_name}}` (not a hard-coded "GST").
* Money: `money()` / `fmtNum()` in `lib/locale.js` (symbol and grouping from the region).
* Providers: a region lists the gateways that work there; `activeGateway()` picks the community's choice if the country supports it.
* **Known gaps for a new country** (documented, not hidden): amenity-settings labels still say GST/GSTIN; the TDS/statutory
  tags on contracts are India-specific; the phone validator accepts the Indian 10-digit format only (the region carries `phone`
  so it can be generalised); report wording is English only (no i18n catalogue yet).

## 3. Bill terms - one explanation everywhere

`lib/billText.js` produces, from one set of figures:
1. the **tax breakdown** (taxable value, tax lines, total, "included/added"),
2. the **due date**, highlighted by tone (ok / soon / overdue),
3. the **late-fee rule** in one sentence and **what it will cost** (or has cost so far).

`components/BillTerms.jsx` renders it on screen (bill detail, pay dialog, booking detail). `lib/billTermsServer.js` appends the same
text to payment reminders, new-bill notifications and levy notices; booking messages carry `{{tax_name}}` and `{{tax_breakdown}}`.
Change a rule once, every channel follows.

## 4. Payment gateway adapter

```
UI (PayDueModal, SettleDues, Amenities booking, Donation PayPanel)
   └─ useGatewayPay().start(request)            components/GatewayCheckout.jsx
        └─ PaymentService.pay()                 lib/payments/index.js
             ├─ gateway.createOrder()           idempotent: same key → same order
             ├─ gateway.checkout()              provider page (simulator: fake hosted page; real: provider SDK)
             ├─ webhook → receiveWebhook()      verify signature → ignore duplicates → settler(purpose)
             └─ gateway.getOrder()              final status (the webhook is the truth, not the browser)
```

* `PaymentGateway` - abstract contract (`createOrder`, `checkout`, `verifyWebhook`, `getOrder`, `refund`).
* `SimulatedGateway` - the demo provider. Signs events with HMAC-SHA256 like a real one; supports **Success / Failure / Pending**;
  a pending payment can be confirmed later; repeating the same webhook changes nothing (idempotent).
* `SpringGateway` - the production adapter that talks only to *your* Spring Boot service (never to the provider's secret API).
* **Settlers** (`registerSettler(purpose, fn)`): `due` (marks bills paid, uses the advance first, writes receipts - `lib/finance/settle.js`),
  `booking`, `donation`. A new thing that can be paid online = one settler.

### Spring Boot hand-off

| Endpoint | Does |
|---|---|
| `POST /payments/orders` | Re-prices from the record ids (never trusts the browser amount), creates the provider order, stores `Created`, returns `{orderId, providerOrderId, publicKey}`. Honour `idempotencyKey`. |
| `POST /payments/webhook/{provider}` | Provider → server. Verify the signature header against the provider secret **before parsing**; store the event id (unique) to drop repeats; in ONE transaction settle the records (mark dues Paid, ledger credit, receipt) and set the order `Paid`. |
| `GET /payments/orders/{id}` | Status for the browser to poll. |
| `POST /payments/refunds` | Refund against a `paymentId` (cancellations, deposit returns). |

Recommended provider for India: **Razorpay** (Java SDK, webhook signature helper, UPI/cards/net banking, test mode).
For UAE/UK/US/SG/AU: **Stripe** (same four endpoints; Stripe's `PaymentIntent` replaces the order). Both only need a new
`SpringGateway` registration on the front end plus a provider class behind the same four endpoints on the server.

## 5. Delete and money safety rules

* `lib/deleteGuard.js` - a task or expense with **any payment** cannot be deleted (payments are never erased); the screen explains why and what to do
  instead (Treasurer records a reversal, then cancel/reject). Only Super Admin sees delete on tasks.
* Settling dues at unit level reuses the same rules as single bills (`applyCredits` for the advance, the same Paid/receipt fields).

## 6. Adding things

| To add | Do |
|---|---|
| A country | `registerRegion({...})` |
| A payment provider | subclass `PaymentGateway` (or configure `SpringGateway`), `registerGateway(...)` |
| Something payable online | `registerSettler('purpose', fn)` and call `useGatewayPay().start({ purpose, ... })` |
| A message with tax/due/penalty text | `termsFor(due)` (server-side text) or `<BillTerms/>` (screen) |
| A collection | an entry in the schema registry + permissions; the table and form appear |

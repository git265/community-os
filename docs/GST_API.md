# GST integration

The app never talks to the GST portal or a GST provider directly. It talks to **your Spring Boot service**, which holds the
provider keys and the society's GST session. In the browser: Billing, Input credit, GST connection: choose **Live**, enter the
service address (for example `/api`), pick the statement to check, press **Test connection**.

## What the server must offer

| Call | Purpose |
|---|---|
| `GET /gst/health` | `{ ok, provider, detail }` - used by Test connection |
| `GET /gst/gstin/{gstin}` | `{ valid, legalName, tradeName, status, state }` - verify a vendor's GSTIN |
| `POST /gst/inward/lookup` | body `{ gstin, invoiceNo, date, gstAmount, source }` -> `{ found, filedOn, amountMatches }` |

`source` is `GSTR-2B` (the monthly statement; final once generated, around the 14th of the next month) or `GSTR-2A` (shows a
vendor's filing as it happens, so it suits a same-day check). GSTR-2B is what input credit is claimed against.

## What you need that code cannot supply
* The society must be **GST registered** (Tax split, "Registered" = Yes).
* A licensed **GST Suvidha Provider** account (a GSP or an application provider sold by tax-software companies) or a direct GSP agreement.
* The taxpayer's **authorisation** to the provider (an OTP-based session on the GST portal, renewed on a schedule the provider sets).
  The server keeps that session; the app never does.

The matching is done in `lib/finance/itc.js` (`checkLine`). Replace the simulator by saving "Live"; no screen changes.
Runs on demand (Check all now, Check this) and once a day if "Also check automatically each day" is on.

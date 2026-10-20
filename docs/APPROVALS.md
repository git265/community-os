# Approvals — rules, plans, releases (Round 40)

One engine decides **who must approve what**. It is pure JavaScript (`src/lib/approval/engine.js`) with no storage or React in it, so the same logic can be ported 1:1 to the Spring Boot service.

## Concepts

| Thing | What it is | Stored in |
|---|---|---|
| **Rule** (policy) | Written by each community. *When* (kind of approval, amount range, category, task type, situation flag) → *steps* (who, how many must approve, can-be-last-step, deadline). | `approvalPolicies` |
| **Plan** | A frozen copy of the steps for ONE record (quotation, invoice, release, event expense) plus the decisions made on it, and any one-off changes. | `plan` (JSON) on the ticket / quotation / release / expense |
| **Kinds** | `Maintenance quotation`, `Maintenance invoice`, `Maintenance release`, `Cultural expense`. | |
| **Situation flags** | `overBudget` (invoice above the approved amount + tolerance %), `eventFinal` (event's "final approval over" limit crossed). | computed when the plan is built |

### Every matching rule applies
Rules are sorted by their order; the steps of **all** matching rules are joined; a step whose approver set is identical to an earlier one is merged (the higher "how many" wins). If no rule matches: EC, then final approvers. Seeded rules reproduce the behaviour before Round 40.

### Approvers
`group` (EC members · Final approvers — the roles under Maintenance → Final approvers), `role` (a named role) or `user` (a named person). Admin may always act.

### Plans are frozen
The plan is built from the rules at the first decision (until then the screen shows what the rules *would* give). Later rule edits never change a plan already in progress. Records approved before Round 40 are read as plans on the fly (`hydrate()` in `kit.js`).

### Per-task override
The EC (if "EC may change the approvals of one task" is on) can replace the **undecided** steps of one record. A reason is mandatory; who/when/why/before is kept in `plan.overrides` and shown on the record. Decided steps are never changed.

### Old fields still work
`legacy(plan, shape)` mirrors the plan into the two-slot fields (`ecApproval…`, `finalRequired`, `finalApproval…` / `treasurerApproval…`) so Payments, closing rules, reports, the Approvals page and every older test keep reading the same data. Step 1 = "EC" slot; all later steps together = the "final" slot.

## Releases
* **One action: "Ask for a release".** The requester (Facility Manager / MEP / coordinators) or the EC asks for money at any stage - before or after the quotation or invoice, no separate advance permission. The approvers of the *Maintenance release* rules are the control; the EC's approval of a release is itself the approval of an advance.
* Each release (`releases` collection) has its own plan under the *Maintenance release* rules. The amount is prefilled from the approved invoice(s), else the approved quotation, else blank; once either is approved the total released cannot pass the larger of the two (`releaseSummary` -> `cap`, `capLeft`, `basis`). `kind` is now `Release` / `Against quotation` / `Against invoice` (old `Advance`/`Stage` rows still display).
* Approved releases wait in Payments → Maintenance. Paying one writes the ledger row (`sourceType: release`, `taskRef`) and marks the release Paid. The quotation row then shows only the **balance**.
* When the invoice arrives, paid releases are **credited** against invoices in upload order; Payments proposes `invoice − credit`.
* **Closing:** a task with paid releases does not close itself until approved invoices cover them (within the tolerance %), or the EC *settles it with a note*.
* **Invoice vs approved amount:** beyond *tolerance %* (default 5) the `overBudget` flag is set on the invoice and the rules requiring it add their steps.

## Settings (financeSettings)
`invoiceSkipWithinQuote` (an invoice within the approved quotation plus tolerance is pre-approved; replaces the old per-task dropdown, which is still honoured for tasks that already had it), `approvalSeparate` (one person cannot approve two steps / their own request), `allowOverride`, `invoiceTolerancePct`.

## Server-side contract (Spring Boot)
`planChange()` in `authz.js` is the check to port: on any write where `plan` changed — (1) each new decision must be in the actor's own name; (2) the actor must be eligible for the step that is currently pending; (3) an override needs EC + reason; (4) the legacy mirror fields must equal `legacy(plan)`. **The server must rebuild the plan from the stored rules when the record is created** — in this browser build a client could submit a crafted plan; `approvalSeparate` is enforced in the UI only.

## Known limits
* Deadlines on steps are stored but no reminders/escalations are sent yet.
* An invoice paid net of an advance is recorded without its GST split (the GST input credit is claimed on the invoice, not the balance).
* Rules cannot yet compare against cumulative spend on a vendor or budget head; only the single record's amount.
* Only maintenance and cultural expenses use the engine. Utility bills, amenity refunds, pay requests (the older "approval limit") are unchanged.

## Round 41b additions
* Override of one task's steps: **Super Admin only** (`planChange` denies anyone else).
* `financeSettings.finalCanDecideEC` (default true): when false, a role listed as a final approver does not match the *EC members* group in a step (explicit role/user approvers still match). Mirrored in `authz.js` (`setFinalCanDecideEC`) and `usePlans.js`.
* Permission `SET_FINANCIAL_FLAG` guards changes to `ticket.financial` on update.
* `moneyPosition(ticket, docs, releases, ledger, tol)` -> `{quoted, invoiced, released, paid, due, owed, overpaid}`; backend must reproduce it for the close rule.

## Cultural releases
`releases` rows carry `expenseId` instead of `ticketId`; plan subject `Cultural release`; authz allows MANAGE_CULTURAL to create / withdraw them. Ledger `sourceType: 'culturalRelease'`, `sourceId: 'culrel:<releaseId>'`.

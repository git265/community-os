-- =====================================================================================================================================
-- V4 money: bills (dues), unit credits, online payments, receipts, and a double-entry ledger underneath
--
-- Integrity rules the DATABASE enforces (not only the application):
--   * amounts are numeric(14,2), never negative where that makes no sense, never NULL;
--   * a bill's paid amount never exceeds what it is for; "Paid" means fully paid; a cancelled bill says why;
--   * a provider payment is recorded once (provider + provider reference is unique) and its allocations never exceed it;
--   * every journal entry balances (debits = credits), checked at COMMIT; a posted entry is never edited or deleted (reverse it instead).
-- =====================================================================================================================================

-- ---- what a bill can be for (Maintenance, Water, DG, Corpus, Late fee, Levy ...) ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.charge_category (
  community_id   uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  code           text        NOT NULL CHECK (code ~ '^[A-Za-z][A-Za-z0-9 _-]{0,39}$'),
  name           text        NOT NULL,
  is_utility     boolean     NOT NULL DEFAULT false,          -- metered (Water, DG): billed from readings
  tax_rate       numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  counts_to_tax_limit boolean NOT NULL DEFAULT true,
  income_account_id uuid,                                      -- finance.account the bill is credited to
  active         boolean     NOT NULL DEFAULT true,
  version        bigint      NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, code)
);

CREATE TABLE IF NOT EXISTS billing.due (
  community_id   uuid          NOT NULL REFERENCES platform.community (id),
  id             uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id       text,
  unit_id        uuid,                                                       -- NULL: a community-level charge
  category_id    uuid          NOT NULL,
  billed_month   date          CHECK (billed_month IS NULL OR billed_month = date_trunc('month', billed_month)::date),
  description    text,
  bill_to        text          NOT NULL DEFAULT 'Owner' CHECK (bill_to IN ('Owner', 'Tenant')),
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  tax_amount     numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total          numeric(14,2) GENERATED ALWAYS AS (amount + tax_amount) STORED,
  paid_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  credit_applied numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_applied >= 0),
  due_date       date          NOT NULL,
  status         text          NOT NULL DEFAULT 'Unpaid' CHECK (status IN ('Unpaid', 'Partly paid', 'Paid', 'Cancelled', 'Waived')),
  paid_at        timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text,
  levy_id        uuid,
  reading_id     uuid,
  late_fee_for   uuid,                                                       -- the bill this late fee is charged on
  correction_of  uuid,                                                       -- the bill this one replaces
  instalment     smallint      CHECK (instalment IS NULL OR instalment > 0),
  reminder_count smallint      NOT NULL DEFAULT 0,
  last_reminded_at timestamptz,
  custom         jsonb         NOT NULL DEFAULT '{}',
  version        bigint        NOT NULL DEFAULT 1,
  created_at     timestamptz   NOT NULL DEFAULT now(), created_by uuid,
  updated_at     timestamptz   NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id),
  FOREIGN KEY (community_id, category_id) REFERENCES billing.charge_category (community_id, id),
  FOREIGN KEY (community_id, late_fee_for) REFERENCES billing.due (community_id, id),
  FOREIGN KEY (community_id, correction_of) REFERENCES billing.due (community_id, id),
  CONSTRAINT due_paid_within_total CHECK (paid_amount + credit_applied <= amount + tax_amount),
  CONSTRAINT due_paid_means_settled CHECK (status <> 'Paid' OR paid_amount + credit_applied = amount + tax_amount),
  CONSTRAINT due_paid_has_date CHECK (status NOT IN ('Paid', 'Partly paid') OR paid_at IS NOT NULL),
  CONSTRAINT due_cancel_has_reason CHECK (status <> 'Cancelled' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0))
);
CREATE INDEX IF NOT EXISTS due_unit_status   ON billing.due (community_id, unit_id, status);
CREATE INDEX IF NOT EXISTS due_status_date   ON billing.due (community_id, status, due_date);
CREATE INDEX IF NOT EXISTS due_month         ON billing.due (community_id, billed_month);
CREATE INDEX IF NOT EXISTS due_open          ON billing.due (community_id, due_date) WHERE status IN ('Unpaid', 'Partly paid');
CREATE INDEX IF NOT EXISTS due_reading       ON billing.due (community_id, reading_id) WHERE reading_id IS NOT NULL;

-- refunds credited to a unit and their later use: a signed running ledger per unit (+ credit, - used)
CREATE TABLE IF NOT EXISTS billing.unit_credit (
  community_id uuid          NOT NULL REFERENCES platform.community (id),
  id           uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id     text,
  unit_id      uuid          NOT NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount <> 0),
  reason       text          NOT NULL,
  source_type  text          NOT NULL CHECK (source_type IN ('booking-refund', 'overpayment', 'adjustment', 'applied-to-due')),
  source_id    uuid,
  version      bigint        NOT NULL DEFAULT 1,
  created_at   timestamptz   NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz   NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id)
);
CREATE INDEX IF NOT EXISTS unit_credit_unit ON billing.unit_credit (community_id, unit_id, created_at);

-- ---- online payments ---------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.payment_order (
  community_id     uuid          NOT NULL REFERENCES platform.community (id),
  id               uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id         text,
  purpose          text          NOT NULL CHECK (purpose IN ('due', 'booking', 'donation')),
  unit_id          uuid,
  payer_membership_id uuid       NOT NULL,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),              -- priced by the server from the records, never from the request
  currency         char(3)       NOT NULL DEFAULT 'INR',
  status           text          NOT NULL DEFAULT 'Created' CHECK (status IN ('Created', 'Pending', 'Paid', 'Failed', 'Expired')),
  provider         text          NOT NULL,
  provider_order_ref text,
  idempotency_key  text          NOT NULL,
  expires_at       timestamptz   NOT NULL,
  paid_at          timestamptz,
  failure_reason   text,
  version          bigint        NOT NULL DEFAULT 1,
  created_at       timestamptz   NOT NULL DEFAULT now(), created_by uuid,
  updated_at       timestamptz   NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, payer_membership_id, idempotency_key),            -- the same "Pay" pressed twice makes ONE order
  UNIQUE (provider, provider_order_ref),
  FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id),
  CHECK (status <> 'Paid' OR paid_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS payment_order_open ON billing.payment_order (status, updated_at) WHERE status IN ('Created', 'Pending');
-- what one order pays for (bills, a booking, a pledge) and how much of it each
CREATE TABLE IF NOT EXISTS billing.payment_order_item (
  community_id uuid          NOT NULL,
  order_id     uuid          NOT NULL,
  target_type  text          NOT NULL CHECK (target_type IN ('due', 'booking', 'donation')),
  target_id    uuid          NOT NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (community_id, order_id, target_type, target_id),
  FOREIGN KEY (community_id, order_id) REFERENCES billing.payment_order (community_id, id) ON DELETE CASCADE
);

-- a captured payment (from the provider's signed webhook, or recorded at the office)
CREATE TABLE IF NOT EXISTS billing.payment (
  community_id     uuid          NOT NULL REFERENCES platform.community (id),
  id               uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id         text,                                                   -- the receipt number
  order_id         uuid,
  unit_id          uuid,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  refunded_amount  numeric(14,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  method           text          NOT NULL CHECK (method IN ('UPI', 'Card', 'Net banking', 'Wallet', 'Cash', 'Cheque', 'Bank transfer', 'Unit credit')),
  provider         text,
  provider_payment_ref text,
  received_at      timestamptz   NOT NULL,
  status           text          NOT NULL DEFAULT 'Captured' CHECK (status IN ('Captured', 'Partly refunded', 'Refunded', 'Reversed')),
  note             text,
  version          bigint        NOT NULL DEFAULT 1,
  created_at       timestamptz   NOT NULL DEFAULT now(), created_by uuid,
  updated_at       timestamptz   NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  UNIQUE (provider, provider_payment_ref),                                -- one provider payment is recorded once, however often the webhook comes
  FOREIGN KEY (community_id, order_id) REFERENCES billing.payment_order (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id),
  CHECK (refunded_amount <= amount),
  CHECK (method IN ('Cash', 'Cheque', 'Bank transfer', 'Unit credit') OR provider IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS payment_unit ON billing.payment (community_id, unit_id, received_at DESC);

-- how a payment settles bills
CREATE TABLE IF NOT EXISTS billing.payment_allocation (
  community_id uuid          NOT NULL,
  payment_id   uuid          NOT NULL,
  due_id       uuid          NOT NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (community_id, payment_id, due_id),
  FOREIGN KEY (community_id, payment_id) REFERENCES billing.payment (community_id, id),
  FOREIGN KEY (community_id, due_id) REFERENCES billing.due (community_id, id)
);
CREATE INDEX IF NOT EXISTS allocation_due ON billing.payment_allocation (community_id, due_id);

-- allocations never exceed the payment (checked at COMMIT, so a payment and its allocations can be written in any order)
CREATE OR REPLACE FUNCTION billing.check_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid numeric(14,2); allocated numeric(14,2);
BEGIN
  SELECT p.amount INTO paid FROM billing.payment p WHERE p.community_id = NEW.community_id AND p.id = NEW.payment_id;
  SELECT COALESCE(sum(a.amount), 0) INTO allocated FROM billing.payment_allocation a WHERE a.community_id = NEW.community_id AND a.payment_id = NEW.payment_id;
  IF allocated > paid THEN RAISE EXCEPTION 'payment % is allocated % but is only %', NEW.payment_id, allocated, paid USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS allocation_within_payment ON billing.payment_allocation;
CREATE CONSTRAINT TRIGGER allocation_within_payment AFTER INSERT OR UPDATE ON billing.payment_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.check_allocation();

-- ---- double-entry ledger ------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance.account (
  community_id uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  code         text        NOT NULL CHECK (code ~ '^[0-9A-Z][0-9A-Z.-]{0,19}$'),
  name         text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('Asset', 'Liability', 'Equity', 'Income', 'Expense')),
  parent_id    uuid,
  is_bank      boolean     NOT NULL DEFAULT false,
  active       boolean     NOT NULL DEFAULT true,
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, code),
  FOREIGN KEY (community_id, parent_id) REFERENCES finance.account (community_id, id)
);

CREATE TABLE IF NOT EXISTS finance.fund (
  community_id uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id     text,
  name         text        NOT NULL,
  purpose      text,
  restricted   boolean     NOT NULL DEFAULT false,               -- corpus / sinking fund: spending needs the general body
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, name)
);

-- books closed up to a date: nothing dated on or before it is posted or changed
CREATE TABLE IF NOT EXISTS finance.period_lock (
  community_id uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  locked_until date        NOT NULL,
  locked_by    uuid,
  locked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id)
);

CREATE TABLE IF NOT EXISTS finance.journal_entry (
  community_id uuid        NOT NULL REFERENCES platform.community (id),
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id     text,
  entry_date   date        NOT NULL,
  memo         text        NOT NULL,
  source_type  text        NOT NULL CHECK (source_type IN ('due', 'payment', 'refund', 'expense', 'release', 'bank', 'manual', 'reversal', 'opening')),
  source_id    uuid,
  reverses_id  uuid,
  status       text        NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Posted')),   -- write lines while Draft, then set Posted
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  FOREIGN KEY (community_id, reverses_id) REFERENCES finance.journal_entry (community_id, id)
);
CREATE INDEX IF NOT EXISTS journal_date ON finance.journal_entry (community_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS journal_source ON finance.journal_entry (community_id, source_type, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_one_reversal ON finance.journal_entry (community_id, reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance.journal_line (
  community_id uuid          NOT NULL,
  entry_id     uuid          NOT NULL,
  line_no      smallint      NOT NULL CHECK (line_no > 0),
  account_id   uuid          NOT NULL,
  fund_id      uuid,
  unit_id      uuid,
  debit        numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  narration    text,
  PRIMARY KEY (community_id, entry_id, line_no),
  FOREIGN KEY (community_id, entry_id) REFERENCES finance.journal_entry (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, account_id) REFERENCES finance.account (community_id, id),
  FOREIGN KEY (community_id, fund_id) REFERENCES finance.fund (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id),
  CONSTRAINT journal_line_one_side CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX IF NOT EXISTS journal_line_account ON finance.journal_line (community_id, account_id);
CREATE INDEX IF NOT EXISTS journal_line_unit ON finance.journal_line (community_id, unit_id) WHERE unit_id IS NOT NULL;

-- every posted entry balances (checked at COMMIT, after all its lines are written)
CREATE OR REPLACE FUNCTION finance.check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric(14,2); c numeric(14,2); n int; st text; cid uuid := COALESCE(NEW.community_id, OLD.community_id); eid uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN eid := COALESCE(NEW.id, OLD.id); ELSE eid := COALESCE(NEW.entry_id, OLD.entry_id); END IF;
  SELECT status INTO st FROM finance.journal_entry WHERE community_id = cid AND id = eid;
  IF st IS DISTINCT FROM 'Posted' THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*) INTO d, c, n FROM finance.journal_line WHERE community_id = cid AND entry_id = eid;
  IF n < 2 OR d <> c THEN RAISE EXCEPTION 'journal entry % does not balance (debit %, credit %, % lines)', eid, d, c, n USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS journal_line_balanced ON finance.journal_line;
CREATE CONSTRAINT TRIGGER journal_line_balanced AFTER INSERT OR UPDATE OR DELETE ON finance.journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.check_balanced();
DROP TRIGGER IF EXISTS journal_entry_balanced ON finance.journal_entry;
CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT OR UPDATE ON finance.journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.check_balanced();

-- a posted entry is history: no edits, no deletes (post a reversal); nothing is posted into a closed period
CREATE OR REPLACE FUNCTION finance.guard_posted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; lk date; d date; cid uuid := COALESCE(NEW.community_id, OLD.community_id); eid uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    IF TG_OP <> 'INSERT' AND OLD.status = 'Posted' THEN RAISE EXCEPTION 'posted journal entry % cannot be changed - post a reversal', OLD.id USING ERRCODE = '55000'; END IF;
    d := COALESCE(NEW.entry_date, OLD.entry_date);
  ELSE
    eid := COALESCE(NEW.entry_id, OLD.entry_id);
    SELECT status, entry_date INTO st, d FROM finance.journal_entry WHERE community_id = cid AND id = eid;
    IF st = 'Posted' THEN RAISE EXCEPTION 'lines of posted journal entry % cannot be added, changed or removed', eid USING ERRCODE = '55000'; END IF;
  END IF;
  SELECT locked_until INTO lk FROM finance.period_lock WHERE community_id = cid;
  IF lk IS NOT NULL AND d <= lk THEN RAISE EXCEPTION 'the books are closed up to %', lk USING ERRCODE = '55000'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS journal_entry_guard ON finance.journal_entry;
CREATE TRIGGER journal_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON finance.journal_entry FOR EACH ROW EXECUTE FUNCTION finance.guard_posted();
DROP TRIGGER IF EXISTS journal_line_guard ON finance.journal_line;
CREATE TRIGGER journal_line_guard BEFORE INSERT OR UPDATE OR DELETE ON finance.journal_line FOR EACH ROW EXECUTE FUNCTION finance.guard_posted();

-- account balances for statements and dashboards
CREATE OR REPLACE VIEW finance.account_balance WITH (security_invoker = true) AS
  SELECT l.community_id, l.account_id, sum(l.debit) AS debit, sum(l.credit) AS credit, sum(l.debit) - sum(l.credit) AS balance
  FROM finance.journal_line l JOIN finance.journal_entry e ON e.community_id = l.community_id AND e.id = l.entry_id AND e.status = 'Posted'
  GROUP BY l.community_id, l.account_id;

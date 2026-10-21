-- =====================================================================================================================================
-- Money: chart of accounts, double-entry journal, bills, payments and their allocation, unit credits, meter readings
--
-- Integrity rules held by the database, not only by the code:
--   * every journal entry balances (sum of debits = sum of credits), checked when the transaction commits;
--   * posted journal lines never change: a correction is a reversing entry;
--   * nothing is posted on or before the community's closed-books date;
--   * a payment can only be allocated up to its own amount, and a bill can only receive up to what it is owed;
--   * amounts are never negative where a negative would mean something else (refunds are their own rows).
-- =====================================================================================================================================

CREATE TABLE gl_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  code          text NOT NULL CHECK (code ~ '^[0-9A-Z.-]{2,20}$'),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('Asset', 'Liability', 'Equity', 'Income', 'Expense')),
  parent_id     uuid,
  is_bank       boolean NOT NULL DEFAULT false,
  is_receivable boolean NOT NULL DEFAULT false,      -- the "owners owe us" control account
  active        boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, code),
  FOREIGN KEY (community_id, parent_id) REFERENCES gl_accounts (community_id, id)
);
SELECT use_row_stamps('gl_accounts');

CREATE TABLE bank_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   uuid NOT NULL REFERENCES communities (id),
  gl_account_id  uuid NOT NULL,
  name           text NOT NULL,
  bank_name      text,
  account_last4  char(4) CHECK (account_last4 ~ '^[0-9]{4}$'),   -- never the full number
  ifsc           text CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  kind           text NOT NULL DEFAULT 'Current' CHECK (kind IN ('Current', 'Savings', 'Fixed deposit', 'Cash')),
  active         boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, gl_account_id),
  FOREIGN KEY (community_id, gl_account_id) REFERENCES gl_accounts (community_id, id)
);
SELECT use_row_stamps('bank_accounts');

CREATE TABLE funds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   uuid NOT NULL REFERENCES communities (id),
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('Operating', 'Sinking', 'Corpus', 'Restricted')),
  gl_account_id  uuid NOT NULL,                     -- the equity / liability account the fund lives in
  annual_budget  numeric(14,2) CHECK (annual_budget >= 0),
  target_balance numeric(14,2) CHECK (target_balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, name),
  FOREIGN KEY (community_id, gl_account_id) REFERENCES gl_accounts (community_id, id)
);
SELECT use_row_stamps('funds');

-- What a bill can be for: maintenance, water, DG, sinking fund, special levy ... each posts to an income (or fund) account.
CREATE TABLE charge_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  code             text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name             text NOT NULL,
  income_account_id uuid NOT NULL,
  tax_rate         numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_inclusive    boolean NOT NULL DEFAULT false,
  metered          boolean NOT NULL DEFAULT false,   -- billed from meter readings (water, DG)
  late_fee_rule    jsonb CHECK (late_fee_rule IS NULL OR jsonb_typeof(late_fee_rule) = 'object'),
  active           boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, code),
  FOREIGN KEY (community_id, income_account_id) REFERENCES gl_accounts (community_id, id)
);
SELECT use_row_stamps('charge_types');

CREATE TABLE meter_readings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  unit_id          uuid NOT NULL,
  charge_type_id   uuid NOT NULL,
  period_month     date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  previous_reading numeric(14,3) NOT NULL CHECK (previous_reading >= 0),
  current_reading  numeric(14,3) NOT NULL CHECK (current_reading >= 0),
  units_consumed   numeric(14,3) GENERATED ALWAYS AS (current_reading - previous_reading) STORED,
  status           text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published')),
  published_at     timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, unit_id, charge_type_id, period_month),
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id),
  FOREIGN KEY (community_id, charge_type_id) REFERENCES charge_types (community_id, id),
  CHECK (current_reading >= previous_reading),
  CHECK ((status = 'Published') = (published_at IS NOT NULL))
);
SELECT use_row_stamps('meter_readings');

CREATE TABLE levies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   uuid NOT NULL REFERENCES communities (id),
  title          text NOT NULL,
  purpose        text,
  charge_type_id uuid NOT NULL,
  fund_id        uuid,
  rule           text NOT NULL CHECK (rule IN ('Flat per unit', 'Per sq ft', 'Per unit type')),
  rate           numeric(14,4) NOT NULL CHECK (rate > 0),
  due_date       date NOT NULL,
  status         text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Issued', 'Closed')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id),
  FOREIGN KEY (community_id, charge_type_id) REFERENCES charge_types (community_id, id),
  FOREIGN KEY (community_id, fund_id) REFERENCES funds (community_id, id)
);
SELECT use_row_stamps('levies');

-- ---- bills (what the UI calls dues) ---------------------------------------------------------------------------------------------------
CREATE TABLE bills (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  bill_no          text NOT NULL,                          -- BIL-000231, from number_series
  unit_id          uuid NOT NULL,
  charge_type_id   uuid NOT NULL,
  period_month     date CHECK (period_month = date_trunc('month', period_month)::date),
  description      text,
  net_amount       numeric(14,2) NOT NULL CHECK (net_amount >= 0),
  tax_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount     numeric(14,2) GENERATED ALWAYS AS (net_amount + tax_amount) STORED,
  amount_paid      numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),   -- maintained by payment_allocations (trigger)
  due_date         date NOT NULL,
  issued_on        date NOT NULL DEFAULT current_date,
  status           text NOT NULL DEFAULT 'Unpaid' CHECK (status IN ('Unpaid', 'Partially paid', 'Paid', 'Cancelled')),
  cancelled_reason text,
  correction_of    uuid,                                   -- this bill replaces a cancelled one
  late_fee_for     uuid,                                   -- this bill is the late fee of another
  levy_id          uuid,
  meter_reading_id uuid,
  instalment_no    smallint CHECK (instalment_no > 0),
  journal_entry_id uuid,                                   -- the receivable posting (V4 journal), set when issued
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, bill_no),
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id),
  FOREIGN KEY (community_id, charge_type_id) REFERENCES charge_types (community_id, id),
  FOREIGN KEY (community_id, correction_of) REFERENCES bills (community_id, id),
  FOREIGN KEY (community_id, late_fee_for) REFERENCES bills (community_id, id),
  FOREIGN KEY (community_id, levy_id) REFERENCES levies (community_id, id),
  FOREIGN KEY (community_id, meter_reading_id) REFERENCES meter_readings (community_id, id),
  CHECK (amount_paid <= net_amount + tax_amount),
  CHECK ((status = 'Cancelled') = (cancelled_reason IS NOT NULL)),
  CHECK (status <> 'Paid' OR amount_paid = net_amount + tax_amount),
  CHECK (due_date >= issued_on - 31)
);
CREATE UNIQUE INDEX bills_one_per_reading ON bills (community_id, meter_reading_id) WHERE meter_reading_id IS NOT NULL AND status <> 'Cancelled';
CREATE UNIQUE INDEX bills_one_late_fee ON bills (community_id, late_fee_for) WHERE late_fee_for IS NOT NULL AND status <> 'Cancelled';
CREATE INDEX bills_unit ON bills (community_id, unit_id, due_date DESC);
CREATE INDEX bills_open ON bills (community_id, due_date) WHERE status IN ('Unpaid', 'Partially paid');
CREATE INDEX bills_period ON bills (community_id, period_month, charge_type_id);
SELECT use_row_stamps('bills');

-- ---- payments and where they went --------------------------------------------------------------------------------------------------
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  receipt_no       text NOT NULL,
  unit_id          uuid,
  payer_person_id  uuid,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  currency         char(3) NOT NULL,
  method           text NOT NULL CHECK (method IN ('UPI', 'Card', 'Net banking', 'Cash', 'Cheque', 'Bank transfer', 'Direct debit', 'Unit credit')),
  provider         text,                                   -- 'razorpay', 'stripe' ... NULL for offline payments
  provider_order_id text,
  provider_payment_id text,
  status           text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Settled', 'Failed', 'Refunded', 'Reversed')),
  received_on      date NOT NULL DEFAULT current_date,
  settled_at       timestamptz,
  bank_account_id  uuid,
  journal_entry_id uuid,
  note             text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, receipt_no),
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id),
  FOREIGN KEY (community_id, payer_person_id) REFERENCES people (community_id, id),
  FOREIGN KEY (community_id, bank_account_id) REFERENCES bank_accounts (community_id, id),
  CHECK ((status = 'Settled') <= (settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX payments_provider ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;   -- a provider payment is recorded once
CREATE INDEX payments_unit ON payments (community_id, unit_id, received_on DESC);
SELECT use_row_stamps('payments');

CREATE TABLE payment_allocations (
  community_id  uuid NOT NULL,
  payment_id    uuid NOT NULL,
  bill_id       uuid NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, payment_id, bill_id),
  FOREIGN KEY (community_id, payment_id) REFERENCES payments (community_id, id),
  FOREIGN KEY (community_id, bill_id) REFERENCES bills (community_id, id)
);
CREATE INDEX payment_allocations_bill ON payment_allocations (community_id, bill_id);
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- An allocation updates the bill's amount_paid / status in the same transaction; over-allocation of a payment or a bill is refused.
CREATE OR REPLACE FUNCTION apply_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pay_total numeric(14,2); used numeric(14,2); b bills%ROWTYPE;
BEGIN
  SELECT amount INTO pay_total FROM payments WHERE community_id = NEW.community_id AND id = NEW.payment_id FOR UPDATE;
  SELECT COALESCE(sum(amount), 0) INTO used FROM payment_allocations WHERE community_id = NEW.community_id AND payment_id = NEW.payment_id;
  IF used + NEW.amount > pay_total THEN RAISE EXCEPTION 'payment over-allocated (% of %)', used + NEW.amount, pay_total USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO b FROM bills WHERE community_id = NEW.community_id AND id = NEW.bill_id FOR UPDATE;
  IF b.status = 'Cancelled' THEN RAISE EXCEPTION 'a cancelled bill cannot be paid' USING ERRCODE = 'check_violation'; END IF;
  IF b.amount_paid + NEW.amount > b.total_amount THEN RAISE EXCEPTION 'bill over-paid (% of %)', b.amount_paid + NEW.amount, b.total_amount USING ERRCODE = 'check_violation'; END IF;
  UPDATE bills SET amount_paid = amount_paid + NEW.amount,
                   status = CASE WHEN amount_paid + NEW.amount = total_amount THEN 'Paid' ELSE 'Partially paid' END
   WHERE community_id = NEW.community_id AND id = NEW.bill_id;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_allocations_apply BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION apply_allocation();

-- Money a unit holds with the association (refunds, advances): a running ledger per unit, never edited.
CREATE TABLE unit_credit_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  unit_id       uuid NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount <> 0),       -- + credited to the unit, - used against a bill
  reason        text NOT NULL,
  source_type   text NOT NULL CHECK (source_type IN ('Refund', 'Advance', 'Bill', 'Adjustment')),
  source_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid DEFAULT app_user(),
  UNIQUE (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id)
);
CREATE INDEX unit_credit_unit ON unit_credit_movements (community_id, unit_id, created_at);
CREATE TRIGGER unit_credit_append_only BEFORE UPDATE OR DELETE ON unit_credit_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- the balance can never go below zero
CREATE OR REPLACE FUNCTION check_unit_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal numeric(14,2);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.community_id::text || NEW.unit_id::text, 0));
  SELECT COALESCE(sum(amount), 0) INTO bal FROM unit_credit_movements WHERE community_id = NEW.community_id AND unit_id = NEW.unit_id;
  IF bal + NEW.amount < 0 THEN RAISE EXCEPTION 'unit credit would go below zero (%)', bal + NEW.amount USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unit_credit_balance BEFORE INSERT ON unit_credit_movements FOR EACH ROW EXECUTE FUNCTION check_unit_credit();

-- ---- double-entry journal ----------------------------------------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  entry_no      text NOT NULL,
  entry_date    date NOT NULL,
  memo          text NOT NULL CHECK (length(memo) BETWEEN 1 AND 500),
  source_type   text NOT NULL CHECK (source_type IN ('Bill', 'Payment', 'Refund', 'Expense', 'Release', 'Transfer', 'Adjustment', 'Opening', 'Reversal')),
  source_id     uuid,
  reversal_of   uuid,
  posted_at     timestamptz NOT NULL DEFAULT now(),
  posted_by     uuid DEFAULT app_user(),
  UNIQUE (community_id, id), UNIQUE (community_id, entry_no),
  FOREIGN KEY (community_id, reversal_of) REFERENCES journal_entries (community_id, id)
);
CREATE UNIQUE INDEX journal_one_reversal ON journal_entries (community_id, reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX journal_source ON journal_entries (community_id, source_type, source_id);
CREATE INDEX journal_date ON journal_entries (community_id, entry_date);
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE journal_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  community_id  uuid NOT NULL,
  entry_id      uuid NOT NULL,
  account_id    uuid NOT NULL,
  debit         numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit        numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  unit_id       uuid,
  fund_id       uuid,
  memo          text,
  PRIMARY KEY (community_id, id),
  FOREIGN KEY (community_id, entry_id) REFERENCES journal_entries (community_id, id),
  FOREIGN KEY (community_id, account_id) REFERENCES gl_accounts (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id),
  FOREIGN KEY (community_id, fund_id) REFERENCES funds (community_id, id),
  CHECK ((debit > 0) <> (credit > 0))                                   -- each line is a debit OR a credit
);
CREATE INDEX journal_lines_entry ON journal_lines (community_id, entry_id);
CREATE INDEX journal_lines_account ON journal_lines (community_id, account_id);
CREATE INDEX journal_lines_unit ON journal_lines (community_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- every entry must balance and have at least two lines: checked once per entry when the transaction commits
CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric(14,2); c numeric(14,2); n integer; locked date; edate date;
BEGIN
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), count(*) INTO d, c, n FROM journal_lines WHERE community_id = NEW.community_id AND entry_id = NEW.entry_id;
  IF n < 2 OR d <> c THEN RAISE EXCEPTION 'journal entry % does not balance (debits %, credits %, % lines)', NEW.entry_id, d, c, n USING ERRCODE = 'check_violation'; END IF;
  SELECT books_locked_until INTO locked FROM communities WHERE id = NEW.community_id;
  SELECT entry_date INTO edate FROM journal_entries WHERE community_id = NEW.community_id AND id = NEW.entry_id;
  IF locked IS NOT NULL AND edate <= locked THEN RAISE EXCEPTION 'the books are closed up to %', locked USING ERRCODE = 'check_violation'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- account balances for reports: a view over the journal (a materialised summary can be added when a community grows large)
CREATE VIEW account_balances AS
  SELECT l.community_id, l.account_id, sum(l.debit) AS debits, sum(l.credit) AS credits, sum(l.debit) - sum(l.credit) AS balance
  FROM journal_lines l GROUP BY l.community_id, l.account_id;

-- ---- bank statement lines and their reconciliation ---------------------------------------------------------------------------------
CREATE TABLE bank_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  bank_account_id  uuid NOT NULL,
  txn_date         date NOT NULL,
  value_date       date,
  narration        text NOT NULL,
  reference        text,
  debit            numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit           numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  balance          numeric(14,2),
  import_batch     uuid,
  dedupe_hash      bytea NOT NULL,                       -- the same statement line imported twice is stored once
  recon_status     text NOT NULL DEFAULT 'Unreconciled' CHECK (recon_status IN ('Unreconciled', 'Matched', 'Not applicable')),
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, bank_account_id, dedupe_hash),
  FOREIGN KEY (community_id, bank_account_id) REFERENCES bank_accounts (community_id, id),
  FOREIGN KEY (community_id, journal_entry_id) REFERENCES journal_entries (community_id, id),
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX bank_transactions_date ON bank_transactions (community_id, bank_account_id, txn_date DESC);
CREATE INDEX bank_transactions_open ON bank_transactions (community_id, txn_date) WHERE recon_status = 'Unreconciled';
SELECT use_row_stamps('bank_transactions');

-- links to journal entries, declared now that the journal exists
ALTER TABLE bills    ADD FOREIGN KEY (community_id, journal_entry_id) REFERENCES journal_entries (community_id, id);
ALTER TABLE payments ADD FOREIGN KEY (community_id, journal_entry_id) REFERENCES journal_entries (community_id, id);

-- ---- what a bill may do on its own ---------------------------------------------------------------------------------------------------
-- The amount paid and the paid states follow the allocations only; amounts are fixed once issued (corrections replace the bill);
-- a bill with money on it cannot be cancelled (reverse the payment first).
CREATE OR REPLACE FUNCTION guard_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;            -- called from apply_allocation
  IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN RAISE EXCEPTION 'amount paid changes only through a payment' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.status IN ('Paid', 'Partially paid') AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'a bill is paid only through a payment' USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.net_amount, NEW.tax_amount, NEW.unit_id, NEW.charge_type_id) IS DISTINCT FROM (OLD.net_amount, OLD.tax_amount, OLD.unit_id, OLD.charge_type_id)
     THEN RAISE EXCEPTION 'an issued bill cannot be changed - cancel it and issue a correction' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.status = 'Cancelled' AND OLD.status <> 'Cancelled' AND OLD.amount_paid > 0 THEN RAISE EXCEPTION 'a bill with payments cannot be cancelled' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.status = 'Cancelled' AND NEW.status <> 'Cancelled' THEN RAISE EXCEPTION 'a cancelled bill stays cancelled' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bills_guard BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION guard_bill();
CREATE TRIGGER bills_no_delete BEFORE DELETE ON bills FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- =====================================================================================================================================
-- V18 finance beyond bills: the cash book, releases on tasks and event expenses, payments waiting for a second approver, bank statements and
-- matching, funds, budgets, deposits, cash counts, the closed-books date.
--   * a cash book entry is money in or out of the bank, posted to the journal when it is written; it is never edited for money or deleted -
--     a wrong one is reversed by an entry that points at it (once)
--   * a release spends part of an approved task (or an event expense) after its own approval; paid, it is a cash book entry
--   * a payment above the community's approval limit waits as a pay request for a second approver, then is recorded by the server
--   * bank statement lines are imported once (the same line twice is refused) and matched to at most one cash book entry each
-- =====================================================================================================================================

-- ---- the cash book ----------------------------------------------------------------------------------------------------------------------------------
DELETE FROM finance.cash_book_entry WHERE date IS NULL OR amount IS NULL OR amount <= 0 OR type IS NULL;
UPDATE finance.cash_book_entry SET recon_status = 'Unreconciled' WHERE recon_status IS NULL;
ALTER TABLE finance.cash_book_entry
  ADD COLUMN IF NOT EXISTS entered_by_id uuid,
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid,
  ALTER COLUMN date SET NOT NULL, ALTER COLUMN amount SET NOT NULL, ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN recon_status SET NOT NULL, ALTER COLUMN recon_status SET DEFAULT 'Unreconciled',
  ALTER COLUMN internal SET DEFAULT false,
  ADD FOREIGN KEY (community_id, entered_by_id) REFERENCES identity.membership (community_id, id),
  ADD FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id),
  ADD CONSTRAINT cash_book_type CHECK (type IN ('Debit', 'Credit')),
  ADD CONSTRAINT cash_book_amount CHECK (amount > 0 AND amount <= 100000000),
  ADD CONSTRAINT cash_book_tax CHECK (coalesce(gst_amount, 0) >= 0 AND coalesce(tds_amount, 0) >= 0 AND coalesce(base_amount, 0) >= 0 AND coalesce(gst_rate, 0) BETWEEN 0 AND 40
                                      AND coalesce(tds_rate, 0) BETWEEN 0 AND 30 AND coalesce(gst_amount, 0) <= amount),
  ADD CONSTRAINT cash_book_recon CHECK (recon_status IN ('Unreconciled', 'Matched', 'Not applicable')),
  ADD CONSTRAINT cash_book_matched CHECK ((recon_status = 'Matched') = (bank_txn_id IS NOT NULL)),
  ADD CONSTRAINT cash_book_reversal CHECK (reversal_of IS NULL OR coalesce(btrim(reason), '') <> ''),
  ADD CONSTRAINT cash_book_description CHECK (length(btrim(coalesce(description, ''))) BETWEEN 1 AND 500);
CREATE UNIQUE INDEX IF NOT EXISTS cash_book_one_reversal ON finance.cash_book_entry (community_id, reversal_of) WHERE reversal_of IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cash_book_one_match ON finance.cash_book_entry (community_id, bank_txn_id) WHERE bank_txn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_book_by_date ON finance.cash_book_entry (community_id, date DESC);
CREATE INDEX IF NOT EXISTS cash_book_by_task ON finance.cash_book_entry (community_id, task_ref) WHERE task_ref IS NOT NULL;
ALTER TABLE finance.journal_entry DROP CONSTRAINT journal_entry_source_type_check,
  ADD CONSTRAINT journal_entry_source_type_check CHECK (source_type IN ('due', 'payment', 'refund', 'expense', 'release', 'bank', 'manual', 'reversal', 'opening', 'booking', 'credit',
                                                                         'donation', 'cashbook'));

-- ---- releases and pay requests ------------------------------------------------------------------------------------------------------------------------
DELETE FROM finance.release WHERE amount IS NULL OR (ticket_id IS NULL AND expense_id IS NULL);
UPDATE finance.release SET kind = 'Release' WHERE kind IS NULL;
ALTER TABLE finance.release
  ADD COLUMN IF NOT EXISTS raised_by_id uuid,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_entry_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ALTER COLUMN amount SET NOT NULL, ALTER COLUMN kind SET NOT NULL, ALTER COLUMN kind SET DEFAULT 'Release',
  ADD FOREIGN KEY (community_id, raised_by_id) REFERENCES identity.membership (community_id, id),
  ADD FOREIGN KEY (community_id, ticket_id) REFERENCES maintenance.ticket (community_id, id),
  ADD FOREIGN KEY (community_id, expense_id) REFERENCES cultural.expense (community_id, id),
  ADD CONSTRAINT release_for CHECK (num_nonnulls(ticket_id, expense_id) = 1),
  ADD CONSTRAINT release_kind CHECK (kind IN ('Release', 'Against quotation', 'Against invoice', 'Advance', 'Stage', 'Final')),
  ADD CONSTRAINT release_paid CHECK ((status = 'Paid') = (paid_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS release_by_expense ON finance.release (community_id, expense_id) WHERE expense_id IS NOT NULL;
UPDATE finance.pay_request SET status = 'Waiting' WHERE status IS NULL;
DELETE FROM finance.pay_request WHERE amount IS NULL OR amount <= 0;
ALTER TABLE finance.pay_request
  ADD COLUMN IF NOT EXISTS requested_by_id uuid,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decision_note text,
  ADD COLUMN IF NOT EXISTS entry_id uuid,
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'Waiting', ALTER COLUMN amount SET NOT NULL,
  ALTER COLUMN payload TYPE jsonb USING coalesce(platform.try_jsonb(payload), '{}'::jsonb),
  ADD FOREIGN KEY (community_id, requested_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT pay_request_status CHECK (status IN ('Waiting', 'Approved', 'Rejected')),
  ADD CONSTRAINT pay_request_amount CHECK (amount > 0),
  ADD CONSTRAINT pay_request_decided CHECK ((status = 'Waiting') = (decided_at IS NULL)),
  ADD CONSTRAINT pay_request_separate CHECK (decided_by_id IS NULL OR decided_by_id IS DISTINCT FROM requested_by_id);

-- ---- the bank ---------------------------------------------------------------------------------------------------------------------------------------
UPDATE finance.bank_account SET name = 'Account ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE finance.bank_account
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT bank_account_last4 CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$');
CREATE UNIQUE INDEX IF NOT EXISTS bank_account_name ON finance.bank_account (community_id, lower(name));
DELETE FROM finance.bank_txn WHERE date IS NULL;
ALTER TABLE finance.bank_txn
  ADD COLUMN IF NOT EXISTS imported_by_id uuid,
  ADD COLUMN IF NOT EXISTS line_hash text,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN debit SET DEFAULT 0, ALTER COLUMN credit SET DEFAULT 0,
  ADD FOREIGN KEY (community_id, matched_ledger_id) REFERENCES finance.cash_book_entry (community_id, id),
  ADD CONSTRAINT bank_txn_side CHECK (coalesce(debit, 0) >= 0 AND coalesce(credit, 0) >= 0 AND (coalesce(debit, 0) > 0) <> (coalesce(credit, 0) > 0));
UPDATE finance.bank_txn SET line_hash = 'legacy-' || id::text WHERE line_hash IS NULL;   -- earlier lines keep their own key; new lines hash their content
CREATE UNIQUE INDEX IF NOT EXISTS bank_txn_once ON finance.bank_txn (community_id, line_hash);
CREATE UNIQUE INDEX IF NOT EXISTS bank_txn_one_match ON finance.bank_txn (community_id, matched_ledger_id) WHERE matched_ledger_id IS NOT NULL;
ALTER TABLE finance.cash_book_entry ADD FOREIGN KEY (community_id, bank_txn_id) REFERENCES finance.bank_txn (community_id, id);

-- ---- funds, budgets, deposits, cash counts --------------------------------------------------------------------------------------------------------------
ALTER TABLE finance.fund
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS balance numeric(14,2),
  ADD COLUMN IF NOT EXISTS annual_budget numeric(14,2),
  ADD COLUMN IF NOT EXISTS target_balance numeric(14,2),
  ADD COLUMN IF NOT EXISTS bank_account text,
  ADD CONSTRAINT fund_kind CHECK (kind IS NULL OR kind IN ('Operating', 'Sinking', 'Corpus', 'Restricted')),
  ADD CONSTRAINT fund_money CHECK (coalesce(annual_budget, 0) >= 0 AND coalesce(target_balance, 0) >= 0);
UPDATE finance.fund SET name = 'Fund ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE finance.fund ALTER COLUMN name SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fund_name ON finance.fund (community_id, lower(name));
ALTER TABLE finance.budget_line
  ADD CONSTRAINT budget_line_kind CHECK (kind IS NULL OR kind IN ('Income', 'Expense')),
  ADD CONSTRAINT budget_line_fy CHECK (fy IS NULL OR fy ~ '^[0-9]{4}(-[0-9]{2,4})?$'),
  ADD CONSTRAINT budget_line_money CHECK (coalesce(forecast, 0) >= 0 AND coalesce(revised, 0) >= 0);
ALTER TABLE finance.deposit
  ADD CONSTRAINT deposit_status CHECK (status IS NULL OR status IN ('Active', 'Matured', 'Closed')),
  ADD CONSTRAINT deposit_money CHECK (coalesce(amount, 0) >= 0 AND coalesce(rate, 0) BETWEEN 0 AND 30 AND coalesce(interest_earned, 0) >= 0 AND coalesce(tax_deducted, 0) >= 0),
  ADD CONSTRAINT deposit_dates CHECK (maturity_date IS NULL OR start_date IS NULL OR maturity_date >= start_date);
ALTER TABLE finance.cash_count
  ADD CONSTRAINT cash_count_money CHECK (coalesce(counted, 0) >= 0 AND coalesce(expected, 0) >= 0);
ALTER TABLE finance.fixed_expense
  ADD CONSTRAINT fixed_expense_money CHECK (coalesce(avg, 0) >= 0 AND coalesce(months, 0) >= 0);
ALTER TABLE finance.account ADD COLUMN IF NOT EXISTS short_id text;   -- read by the chart-of-accounts register like any other row
ALTER TABLE finance.finance_setting
  ADD CONSTRAINT finance_setting_approval_limit CHECK (approval_limit IS NULL OR approval_limit >= 0);

CREATE OR REPLACE FUNCTION platform.provision_ledger(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance.account (community_id, code, name, kind, is_bank) VALUES
    (p_community, '1300', 'Input GST receivable', 'Asset', false),
    (p_community, '2150', 'TDS payable', 'Liability', false),
    (p_community, '4900', 'Other income', 'Income', false)
  ON CONFLICT (community_id, code) DO NOTHING;
  INSERT INTO finance.fund (community_id, name, purpose, restricted, kind)
  SELECT p_community, v.name, v.purpose, v.restricted, v.kind FROM (VALUES ('General', 'Day-to-day running', false, 'Operating'), ('Sinking', 'Major repairs and replacements', true, 'Sinking'),
                                                                           ('Cultural', 'Festivals and events', false, 'Operating')) AS v(name, purpose, restricted, kind)
  WHERE NOT EXISTS (SELECT 1 FROM finance.fund f WHERE f.community_id = p_community);
END $$;

CREATE OR REPLACE FUNCTION platform.provision_community(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform.provision_core(p_community);
  PERFORM platform.provision_maintenance(p_community);
  PERFORM platform.provision_finance(p_community);
  PERFORM platform.provision_amenities(p_community);
  PERFORM platform.provision_gate(p_community);
  PERFORM platform.provision_comms(p_community);
  PERFORM platform.provision_cultural(p_community);
  PERFORM platform.provision_ledger(p_community);
END $$;

SELECT platform.provision_ledger(id) FROM platform.community;

SELECT platform.apply_security();

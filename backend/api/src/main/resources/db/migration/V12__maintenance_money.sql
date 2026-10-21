-- =====================================================================================================================================
-- V12 maintenance, step 2: quotations and invoices with their approval plans, the money position of a task, and the maintenance registers
-- (wishes, service notices, event work, trade availability) as checked resources.
--   * a quotation / invoice always belongs to a ticket; its amounts are computed by the server (base + GST); its approval plan is JSON text
--   * the approval slots (ec_approval, final_approval) only take the three values the plan produces
--   * finance.finance_setting and maintenance.approver_setting are one row per community; every community gets them (provision_finance)
--   * releases carry a checked status; they are found by ticket for the money position
-- =====================================================================================================================================

-- ---- quotations and invoices --------------------------------------------------------------------------------------------------------------
DELETE FROM maintenance.quotation WHERE ticket_id IS NULL;
ALTER TABLE maintenance.quotation
  ALTER COLUMN ticket_id SET NOT NULL,
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN amount SET NOT NULL,
  ALTER COLUMN base_amount SET NOT NULL,
  ALTER COLUMN ec_approval SET DEFAULT 'Pending',
  ALTER COLUMN final_approval SET DEFAULT 'Pending',
  ALTER COLUMN gst_mode SET DEFAULT 'None',
  ADD CONSTRAINT quotation_kind CHECK (kind IN ('Quotation', 'Invoice')),
  ADD CONSTRAINT quotation_gst_mode CHECK (gst_mode IS NULL OR gst_mode IN ('None', 'Included', 'Extra')),
  ADD CONSTRAINT quotation_gst_rate CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 40)),
  ADD CONSTRAINT quotation_amounts CHECK (amount >= 0 AND base_amount >= 0 AND (gst_amount IS NULL OR gst_amount >= 0)),
  ADD CONSTRAINT quotation_ec_approval CHECK (ec_approval IS NULL OR ec_approval IN ('Pending', 'Approved', 'Rejected')),
  ADD CONSTRAINT quotation_final_approval CHECK (final_approval IS NULL OR final_approval IN ('Pending', 'Approved', 'Rejected')),
  ADD CONSTRAINT quotation_vendor CHECK (vendor IS NULL OR length(vendor) <= 200),
  ADD CONSTRAINT quotation_note CHECK (note IS NULL OR length(note) <= 4000);
CREATE INDEX IF NOT EXISTS quotation_by_ticket ON maintenance.quotation (community_id, ticket_id, created_at);
COMMENT ON COLUMN maintenance.quotation.plan IS 'approval plan (JSON): the steps the approval rules asked for and the decisions on them - written only by the API';

ALTER TABLE maintenance.ticket
  ADD CONSTRAINT ticket_quotation_status CHECK (quotation_status IS NULL OR quotation_status IN ('None', 'Received', 'Pending approval', 'Approved', 'Rejected')),
  ADD CONSTRAINT ticket_invoice_status CHECK (invoice_status IS NULL OR invoice_status IN ('None', 'Received', 'Pending approval', 'Approved', 'Rejected', 'Sent back')),
  ADD CONSTRAINT ticket_ec_approval CHECK (ec_approval IS NULL OR ec_approval IN ('Pending', 'Approved', 'Rejected')),
  ADD CONSTRAINT ticket_treasurer_approval CHECK (treasurer_approval IS NULL OR treasurer_approval IN ('Pending', 'Approved', 'Rejected')),
  ADD CONSTRAINT ticket_approved_amount CHECK (approved_amount IS NULL OR approved_amount >= 0);

-- ---- releases (money released on a task or an expense) -------------------------------------------------------------------------------------
UPDATE finance.release SET status = 'Waiting approval' WHERE status IS NULL;
ALTER TABLE finance.release
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Waiting approval',
  ADD CONSTRAINT release_status CHECK (status IN ('Waiting approval', 'Approved', 'Paid', 'Rejected', 'Cancelled')),
  ADD CONSTRAINT release_amount CHECK (amount IS NULL OR amount > 0),
  ADD CONSTRAINT release_cancel_reason CHECK (status <> 'Cancelled' OR coalesce(btrim(cancel_reason), '') <> '');
CREATE INDEX IF NOT EXISTS release_by_ticket ON finance.release (community_id, ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_book_by_source ON finance.cash_book_entry (community_id, source_id) WHERE source_id IS NOT NULL;

-- ---- approval rules and settings ----------------------------------------------------------------------------------------------------------
UPDATE finance.approval_policy SET name = 'Rule ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE finance.approval_policy
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT approval_policy_name UNIQUE (community_id, name),
  ADD CONSTRAINT approval_policy_range CHECK (min_amount IS NULL OR max_amount IS NULL OR max_amount = 0 OR min_amount <= max_amount),
  ADD CONSTRAINT approval_policy_flag CHECK (require_flag IS NULL OR require_flag IN ('', 'overBudget', 'eventFinal'));
CREATE UNIQUE INDEX IF NOT EXISTS finance_setting_one_per_community ON finance.finance_setting (community_id);
ALTER TABLE finance.finance_setting
  ADD CONSTRAINT finance_setting_late_fee_kind CHECK (late_fee_kind IS NULL OR late_fee_kind IN ('Percent per month', 'Fixed per month')),
  ADD CONSTRAINT finance_setting_tolerance CHECK (invoice_tolerance_pct IS NULL OR (invoice_tolerance_pct >= 0 AND invoice_tolerance_pct <= 100));
CREATE UNIQUE INDEX IF NOT EXISTS approver_setting_name ON maintenance.approver_setting (community_id, name);

-- ---- registers -------------------------------------------------------------------------------------------------------------------------------
UPDATE maintenance.wish SET status = 'Submitted' WHERE status IS NULL;
UPDATE maintenance.wish SET title = 'Wish ' || short_id WHERE title IS NULL OR btrim(title) = '';
ALTER TABLE maintenance.wish
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Submitted',
  ADD CONSTRAINT wish_status CHECK (status IN ('Submitted', 'Under review', 'Planned', 'Done', 'Declined', 'Withdrawn')),
  ADD CONSTRAINT wish_estimate CHECK (estimate IS NULL OR estimate >= 0);
UPDATE maintenance.service_notice SET status = 'Active' WHERE status IS NULL;
ALTER TABLE maintenance.service_notice
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Active',
  ADD CONSTRAINT service_notice_status CHECK (status IN ('Active', 'Resolved')),
  ADD CONSTRAINT service_notice_scope CHECK (scope IS NULL OR scope IN ('Whole community', 'Selected blocks'));
UPDATE maintenance.event_work SET status = 'Not started' WHERE status IS NULL;
ALTER TABLE maintenance.event_work
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Not started',
  ADD CONSTRAINT event_work_status CHECK (status IN ('Not started', 'In progress', 'Blocked', 'Done', 'Cancelled')),
  ADD CONSTRAINT event_work_times CHECK (start_time IS NULL OR end_time IS NULL OR start_time <= end_time);
ALTER TABLE maintenance.trade_availability
  ADD CONSTRAINT trade_availability_counts CHECK (coalesce(available, 0) >= 0 AND coalesce(assigned, 0) >= 0 AND coalesce(off_shift, 0) >= 0);

-- ---- defaults for every community -----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.provision_finance(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance.finance_setting (community_id, reminder_enabled, reminder_every_days, reminder_lead_days, reminder_max, late_fee_enabled, late_fee_kind, late_fee_value,
                                       late_fee_grace_days, late_fee_max_months, block_overdue_days, approval_separate, allow_override, final_can_decide_ec,
                                       invoice_skip_within_quote, invoice_tolerance_pct)
  VALUES (p_community, true, 7, 3, 3, false, 'Percent per month', 2, 15, 6, 60, false, true, true, false, 5)
  ON CONFLICT (community_id) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION platform.provision_community(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform.provision_core(p_community);
  PERFORM platform.provision_maintenance(p_community);
  PERFORM platform.provision_finance(p_community);
END $$;

SELECT platform.provision_finance(id) FROM platform.community;

SELECT platform.apply_security();

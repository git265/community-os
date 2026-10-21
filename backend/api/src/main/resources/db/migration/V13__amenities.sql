-- =====================================================================================================================================
-- V13 amenities and bookings, and the payment kernel opened to things other than bills.
--   * an amenity type has a unique name, checked modes, rates and limits; its cancellation tiers are JSON; it may list its own time slots
--   * add-on items and bookings point at their amenity by id (the name moves; the id does not)
--   * a booking carries everything its workflow decides: price, GST, deposit, the policy it was booked under, payment, refund and deposit
--     settlement - each state checked; the server alone writes them
--   * payment orders and allocations can target a booking (or later a donation); a prepayment is claimed once
--   * two ledger accounts: 2200 Security deposits held, 2400 Refunds payable; journal entries may come from bookings and credit use
-- =====================================================================================================================================

CREATE OR REPLACE FUNCTION platform.try_jsonb(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF t IS NULL OR btrim(t) = '' THEN RETURN NULL; END IF;
  RETURN t::jsonb;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- ---- amenity types ---------------------------------------------------------------------------------------------------------------------------
UPDATE amenity.amenity_type SET name = 'Amenity ' || short_id WHERE name IS NULL OR btrim(name) = '';
UPDATE amenity.amenity_type SET capacity = 1 WHERE capacity IS NULL OR capacity < 1;
ALTER TABLE amenity.amenity_type
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN capacity SET NOT NULL,
  ALTER COLUMN capacity SET DEFAULT 1,
  ALTER COLUMN active SET DEFAULT true,
  ALTER COLUMN rate_unit SET DEFAULT 'Per day / event',
  ALTER COLUMN gst_mode SET DEFAULT 'Exclusive',
  ALTER COLUMN booking_mode SET DEFAULT 'Time slot',
  ALTER COLUMN reservation SET DEFAULT 'Reservation required',
  ALTER COLUMN cancellation_rules TYPE jsonb USING platform.try_jsonb(cancellation_rules),
  ADD COLUMN IF NOT EXISTS slots text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT amenity_type_name UNIQUE (community_id, name),
  ADD CONSTRAINT amenity_type_name_len CHECK (length(btrim(name)) BETWEEN 2 AND 60),
  ADD CONSTRAINT amenity_type_rate_unit CHECK (rate_unit IS NULL OR rate_unit IN ('Per hour', 'Per day / event', 'Free')),
  ADD CONSTRAINT amenity_type_gst_mode CHECK (gst_mode IS NULL OR gst_mode IN ('Exclusive', 'Inclusive')),
  ADD CONSTRAINT amenity_type_booking_mode CHECK (booking_mode IS NULL OR booking_mode IN ('Time slot', 'Full day')),
  ADD CONSTRAINT amenity_type_reservation CHECK (reservation IS NULL OR reservation IN ('Reservation required', 'Walk-in (no reservation)')),
  ADD CONSTRAINT amenity_type_money CHECK (coalesce(rate, 0) >= 0 AND coalesce(weekend_rate, 0) >= 0 AND coalesce(deposit_amount, 0) >= 0
                                           AND coalesce(gst_rate, 0) BETWEEN 0 AND 40),
  ADD CONSTRAINT amenity_type_limits CHECK (capacity BETWEEN 1 AND 1000 AND coalesce(min_notice_hours, 0) >= 0 AND coalesce(max_advance_days, 0) >= 0
                                            AND coalesce(max_per_day, 0) >= 0 AND coalesce(max_per_month, 0) >= 0 AND coalesce(max_upcoming, 0) >= 0),
  ADD CONSTRAINT amenity_type_tiers CHECK (cancellation_rules IS NULL OR jsonb_typeof(cancellation_rules) = 'array');
COMMENT ON COLUMN amenity.amenity_type.cancellation_rules IS 'cancellation tiers [{hoursBefore, refundPct}] - longest notice first; null = the community default (72 h 100%, 24 h 50%)';
COMMENT ON COLUMN amenity.amenity_type.slots IS 'this amenity''s time slots ("08:00–09:00"); empty = the community''s slot list';

-- ---- add-on items ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE amenity.item ADD COLUMN IF NOT EXISTS amenity_type_id uuid;
UPDATE amenity.item i SET amenity_type_id = t.id FROM amenity.amenity_type t WHERE t.community_id = i.community_id AND t.name = i.amenity AND i.amenity_type_id IS NULL;
UPDATE amenity.item SET name = 'Item ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE amenity.item
  DROP COLUMN amenity,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN active SET DEFAULT true,
  ADD FOREIGN KEY (community_id, amenity_type_id) REFERENCES amenity.amenity_type (community_id, id),
  ADD CONSTRAINT item_numbers CHECK (coalesce(stock, 0) >= 0 AND coalesce(price, 0) >= 0 AND coalesce(max_per_booking, 0) >= 0);
COMMENT ON COLUMN amenity.item.amenity_type_id IS 'offered with this amenity only; null = with every amenity';

-- ---- bookings ----------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE amenity.booking ADD COLUMN IF NOT EXISTS amenity_type_id uuid;
UPDATE amenity.booking b SET amenity_type_id = t.id FROM amenity.amenity_type t WHERE t.community_id = b.community_id AND t.name = b.amenity AND b.amenity_type_id IS NULL;
DELETE FROM amenity.booking WHERE amenity_type_id IS NULL OR date IS NULL;
ALTER TABLE amenity.booking
  DROP COLUMN amenity,
  ALTER COLUMN extras TYPE jsonb USING coalesce(platform.try_jsonb(extras), '[]'::jsonb),
  ALTER COLUMN extras SET DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS start_at timestamptz,
  ADD COLUMN IF NOT EXISTS rate numeric(14,2),
  ADD COLUMN IF NOT EXISTS rate_unit text,
  ADD COLUMN IF NOT EXISTS gst_mode text,
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS booked_by_id uuid,
  ADD COLUMN IF NOT EXISTS credit_applied numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_ref text,
  ADD COLUMN IF NOT EXISTS payment_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_id uuid,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_pct numeric(5,2),
  ADD COLUMN IF NOT EXISTS refund_fee_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS deposit_returned numeric(14,2),
  ADD COLUMN IF NOT EXISTS retained_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS refund_to text,
  ADD COLUMN IF NOT EXISTS refund_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_paid_by_id uuid,
  ADD COLUMN IF NOT EXISTS refund_payout_mode text,
  ADD COLUMN IF NOT EXISTS refund_ref text,
  ADD COLUMN IF NOT EXISTS deposit_deduction numeric(14,2),
  ADD COLUMN IF NOT EXISTS deposit_deduction_reason text,
  ADD COLUMN IF NOT EXISTS deposit_photos jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS deposit_settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_refund_mode text,
  ADD COLUMN IF NOT EXISTS deposit_refund_status text,
  ADD COLUMN IF NOT EXISTS deposit_refund_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_refund_ref text,
  ADD COLUMN IF NOT EXISTS fee_corrected_from numeric(14,2),
  ADD COLUMN IF NOT EXISTS fee_correction_reason text;
UPDATE amenity.booking SET start_at = (date + time '00:00') AT TIME ZONE 'Asia/Kolkata' WHERE start_at IS NULL;
UPDATE amenity.booking SET status = 'Confirmed' WHERE status IS NULL;
UPDATE amenity.booking SET payment_status = 'Not required' WHERE payment_status IS NULL;
UPDATE amenity.booking SET deposit_status = 'None' WHERE deposit_status IS NULL;
UPDATE amenity.booking SET refund_status = 'None' WHERE refund_status IS NULL;
UPDATE amenity.booking SET booked_for = CASE WHEN unit_id IS NULL THEN 'Association' ELSE 'Unit' END WHERE booked_for IS NULL;
UPDATE amenity.booking SET association = 'Association' WHERE booked_for = 'Association' AND coalesce(btrim(association), '') = '';
UPDATE amenity.booking SET slot = 'Full day' WHERE slot IS NULL;
ALTER TABLE amenity.booking
  ALTER COLUMN amenity_type_id SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN slot SET NOT NULL,
  ALTER COLUMN start_at SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN payment_status SET NOT NULL,
  ALTER COLUMN deposit_status SET NOT NULL,
  ALTER COLUMN refund_status SET NOT NULL,
  ALTER COLUMN booked_for SET NOT NULL,
  ALTER COLUMN refund_status SET DEFAULT 'None',
  ALTER COLUMN deposit_status SET DEFAULT 'None',
  ADD FOREIGN KEY (community_id, amenity_type_id) REFERENCES amenity.amenity_type (community_id, id),
  ADD FOREIGN KEY (community_id, booked_by_id) REFERENCES identity.membership (community_id, id),
  ADD FOREIGN KEY (community_id, cancelled_by_id) REFERENCES identity.membership (community_id, id),
  ADD FOREIGN KEY (community_id, refund_paid_by_id) REFERENCES identity.membership (community_id, id),
  ADD FOREIGN KEY (community_id, payment_id) REFERENCES billing.payment (community_id, id),
  ADD CONSTRAINT booking_status CHECK (status IN ('Pending payment', 'Confirmed', 'Completed', 'Cancelled')),
  ADD CONSTRAINT booking_payment_status CHECK (payment_status IN ('Not required', 'Pending', 'Paid', 'Cancelled', 'Refund due', 'Refunded', 'Partially refunded')),
  ADD CONSTRAINT booking_deposit_status CHECK (deposit_status IN ('None', 'Awaiting payment', 'Held', 'Returned', 'Released', 'Partly forfeited', 'Forfeited')),
  ADD CONSTRAINT booking_refund_status CHECK (refund_status IN ('None', 'Refund due', 'Refunded', 'Credited to unit account')),
  ADD CONSTRAINT booking_deposit_refund_status CHECK (deposit_refund_status IS NULL OR deposit_refund_status IN ('None', 'Due', 'Paid', 'Credited to unit account')),
  ADD CONSTRAINT booking_booked_for CHECK ((booked_for = 'Unit' AND unit_id IS NOT NULL) OR (booked_for = 'Association' AND coalesce(btrim(association), '') <> '')),
  ADD CONSTRAINT booking_money CHECK (coalesce(base_amount, 0) >= 0 AND coalesce(gst_amount, 0) >= 0 AND coalesce(fee_total, 0) >= 0 AND coalesce(deposit_amount, 0) >= 0
                                      AND coalesce(total_payable, 0) >= 0 AND credit_applied >= 0 AND paid_amount >= 0 AND coalesce(refund_amount, 0) >= 0
                                      AND coalesce(extras_total, 0) >= 0 AND coalesce(waived_amount, 0) >= 0 AND coalesce(deposit_deduction, 0) >= 0),
  ADD CONSTRAINT booking_refund_pct CHECK (refund_pct IS NULL OR refund_pct BETWEEN 0 AND 100),
  ADD CONSTRAINT booking_cancelled CHECK (status <> 'Cancelled' OR cancelled_at IS NOT NULL),
  ADD CONSTRAINT booking_waived CHECK (NOT charge_waived OR coalesce(btrim(waive_reason), '') <> ''),
  ADD CONSTRAINT booking_extras CHECK (jsonb_typeof(extras) = 'array');
CREATE INDEX IF NOT EXISTS booking_by_amenity_day ON amenity.booking (community_id, amenity_type_id, date) WHERE status <> 'Cancelled';
CREATE INDEX IF NOT EXISTS booking_by_unit ON amenity.booking (community_id, unit_id, date);
CREATE INDEX IF NOT EXISTS booking_open_money ON amenity.booking (community_id) WHERE refund_status = 'Refund due' OR deposit_refund_status = 'Due' OR payment_status = 'Pending';

-- ---- amenity settings: one row ------------------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS amenity_setting_one_per_community ON amenity.setting (community_id);
ALTER TABLE amenity.setting
  ADD CONSTRAINT amenity_setting_refund_mode CHECK (refund_mode IS NULL OR refund_mode IN ('Credit to unit account', 'Original payment mode (manual)')),
  ADD CONSTRAINT amenity_setting_summary CHECK (summary_report IS NULL OR summary_report IN ('Off', 'Weekly', 'Monthly')),
  ADD CONSTRAINT amenity_setting_numbers CHECK (coalesce(default_gst_rate, 18) BETWEEN 0 AND 40 AND coalesce(payment_due_hours, 0) >= 0);

-- ---- payments for things other than bills -------------------------------------------------------------------------------------------------------
ALTER TABLE billing.payment_allocation
  ADD COLUMN IF NOT EXISTS target_type text NOT NULL DEFAULT 'due',
  ADD COLUMN IF NOT EXISTS target_id uuid;
UPDATE billing.payment_allocation SET target_id = due_id WHERE target_type = 'due' AND target_id IS NULL;
ALTER TABLE billing.payment_allocation
  DROP CONSTRAINT payment_allocation_pkey,
  ALTER COLUMN target_id SET NOT NULL,
  ALTER COLUMN due_id DROP NOT NULL,
  ADD PRIMARY KEY (community_id, payment_id, target_type, target_id),
  ADD CONSTRAINT payment_allocation_target CHECK ((target_type = 'due' AND due_id = target_id) OR (target_type IN ('booking', 'donation') AND due_id IS NULL));
CREATE INDEX IF NOT EXISTS payment_allocation_target ON billing.payment_allocation (community_id, target_type, target_id);
ALTER TABLE billing.payment
  ADD COLUMN IF NOT EXISTS claimed_type text,
  ADD COLUMN IF NOT EXISTS claimed_id uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD CONSTRAINT payment_claim CHECK ((claimed_type IS NULL) = (claimed_id IS NULL) AND (claimed_type IS NULL OR claimed_type IN ('booking', 'donation')));
COMMENT ON COLUMN billing.payment.claimed_id IS 'a prepayment (order for a booking / donation) is claimed by exactly one record; until then its money is the unit''s credit';
ALTER TABLE billing.unit_credit DROP CONSTRAINT unit_credit_source_type_check;
ALTER TABLE billing.unit_credit ADD CONSTRAINT unit_credit_source_type_check
  CHECK (source_type IN ('booking-refund', 'overpayment', 'adjustment', 'applied-to-due', 'prepayment', 'applied-to-booking', 'deposit-refund'));
ALTER TABLE finance.journal_entry DROP CONSTRAINT journal_entry_source_type_check;
ALTER TABLE finance.journal_entry ADD CONSTRAINT journal_entry_source_type_check
  CHECK (source_type IN ('due', 'payment', 'refund', 'expense', 'release', 'bank', 'manual', 'reversal', 'opening', 'booking', 'credit', 'donation'));

-- ---- defaults for every community -----------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.provision_amenities(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance.account (community_id, code, name, kind, is_bank) VALUES
    (p_community, '2200', 'Security deposits held', 'Liability', false),
    (p_community, '2400', 'Refunds payable', 'Liability', false)
  ON CONFLICT (community_id, code) DO NOTHING;
  INSERT INTO amenity.setting (community_id, default_gst_rate, refund_mode, payment_due_hours, notify_owner, notify_admin, daily_report, summary_report, reminder_on)
  VALUES (p_community, 18, 'Original payment mode (manual)', 24, true, true, false, 'Off', true)
  ON CONFLICT (community_id) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION platform.provision_community(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform.provision_core(p_community);
  PERFORM platform.provision_maintenance(p_community);
  PERFORM platform.provision_finance(p_community);
  PERFORM platform.provision_amenities(p_community);
END $$;

SELECT platform.provision_amenities(id) FROM platform.community;

SELECT platform.apply_security();

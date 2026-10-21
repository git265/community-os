-- =====================================================================================================================================
-- V17 cultural events and donations.
--   * an event, its programme, seva slots, offerings, brochure pages and photos are checked registers; sign-up lists are JSON the server writes
--   * a donation is pledged (by a unit, or recorded by the committee) and becomes Received once with a receipt number unique in the community;
--     money received is in the books (Dr receivable / Cr 4400 Donations, then the payment); an online payment is a prepayment the donation claims
--   * an event expense carries its approval plan; paid, it is in the books (Dr 5100 Event expenses / Cr bank)
--   * the event's totals (collected, pledged, households, spent) are worked out from the rows when read - never stored by a client
-- =====================================================================================================================================

-- ---- events ----------------------------------------------------------------------------------------------------------------------------------
UPDATE cultural.event SET name = 'Event ' || short_id WHERE name IS NULL OR btrim(name) = '';
UPDATE cultural.event SET status = 'Planning' WHERE status IS NULL;
UPDATE cultural.event SET visibility = 'Internal' WHERE visibility IS NULL;
ALTER TABLE cultural.event
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'Planning',
  ALTER COLUMN visibility SET NOT NULL, ALTER COLUMN visibility SET DEFAULT 'Internal',
  ADD CONSTRAINT event_name CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  ADD CONSTRAINT event_status CHECK (status IN ('Planning', 'Open', 'Completed', 'Cancelled')),
  ADD CONSTRAINT event_visibility CHECK (visibility IN ('Internal', 'Published')),
  ADD CONSTRAINT event_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  ADD CONSTRAINT event_money CHECK (coalesce(budget, 0) >= 0 AND coalesce(target_collection, 0) >= 0 AND coalesce(final_over, 0) >= 0 AND coalesce(credited_amount, 0) >= 0
                                    AND coalesce(historical_actual, 0) >= 0),
  ADD CONSTRAINT event_credit CHECK (credited_amount IS NULL OR (credited_at IS NOT NULL AND status = 'Completed')),
  ADD CONSTRAINT event_brochure CHECK (brochure_status IS NULL OR brochure_status IN ('Draft', 'Published')),
  ADD CONSTRAINT event_programme CHECK (programme_status IS NULL OR programme_status IN ('Draft', 'Published'));

-- ---- programme and seva: who signed up is JSON the server writes ------------------------------------------------------------------------------
ALTER TABLE cultural.program
  ALTER COLUMN participants TYPE jsonb USING coalesce(platform.try_jsonb(participants), '[]'::jsonb),
  ALTER COLUMN participants SET DEFAULT '[]'::jsonb;
UPDATE cultural.program SET participants = '[]'::jsonb WHERE participants IS NULL OR jsonb_typeof(participants) <> 'array';
DELETE FROM cultural.program WHERE event_id IS NULL;
ALTER TABLE cultural.program
  ALTER COLUMN participants SET NOT NULL, ALTER COLUMN event_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS program_community_id_event_id_fkey,
  ADD CONSTRAINT program_event_fkey FOREIGN KEY (community_id, event_id) REFERENCES cultural.event (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT program_title CHECK (length(btrim(coalesce(title, ''))) >= 1),
  ADD CONSTRAINT program_counts CHECK (coalesce(capacity, 0) >= 0 AND coalesce(people_per_unit, 0) >= 0),
  ADD CONSTRAINT program_times CHECK (end_time IS NULL OR start_time IS NULL OR end_time >= start_time),
  ADD CONSTRAINT program_list CHECK (jsonb_typeof(participants) = 'array');
ALTER TABLE cultural.seva
  ALTER COLUMN volunteers TYPE jsonb USING coalesce(platform.try_jsonb(volunteers), '[]'::jsonb),
  ALTER COLUMN volunteers SET DEFAULT '[]'::jsonb;
UPDATE cultural.seva SET volunteers = '[]'::jsonb WHERE volunteers IS NULL OR jsonb_typeof(volunteers) <> 'array';
DELETE FROM cultural.seva WHERE event_id IS NULL;
ALTER TABLE cultural.seva
  ALTER COLUMN volunteers SET NOT NULL, ALTER COLUMN event_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS seva_community_id_event_id_fkey,
  ADD CONSTRAINT seva_event_fkey FOREIGN KEY (community_id, event_id) REFERENCES cultural.event (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT seva_title CHECK (length(btrim(coalesce(title, ''))) >= 1),
  ADD CONSTRAINT seva_needed CHECK (coalesce(needed, 0) >= 0),
  ADD CONSTRAINT seva_list CHECK (jsonb_typeof(volunteers) = 'array');

-- ---- offerings: a fixed slot is reserved by one pledge at a time ---------------------------------------------------------------------------------
UPDATE cultural.offering SET kind = 'Community pool' WHERE kind IS NULL;
DELETE FROM cultural.offering WHERE event_id IS NULL;
ALTER TABLE cultural.offering
  ADD COLUMN IF NOT EXISTS reserved_unit_id uuid,
  ALTER COLUMN event_id SET NOT NULL, ALTER COLUMN kind SET NOT NULL,
  DROP CONSTRAINT IF EXISTS offering_community_id_event_id_fkey,
  ADD CONSTRAINT offering_event_fkey FOREIGN KEY (community_id, event_id) REFERENCES cultural.event (community_id, id) ON DELETE CASCADE,
  ADD FOREIGN KEY (community_id, reserved_unit_id) REFERENCES property.unit (community_id, id),
  ADD CONSTRAINT offering_kind CHECK (kind IN ('Fixed slot', 'Community pool')),
  ADD CONSTRAINT offering_value CHECK (coalesce(pledge_value, 0) >= 0),
  ADD CONSTRAINT offering_reserved CHECK (donation_id IS NULL OR kind = 'Fixed slot');
CREATE UNIQUE INDEX IF NOT EXISTS offering_one_pledge ON cultural.offering (community_id, donation_id) WHERE donation_id IS NOT NULL;

-- ---- donations -----------------------------------------------------------------------------------------------------------------------------------
UPDATE cultural.donation SET status = 'Pledged' WHERE status IS NULL;
UPDATE cultural.donation SET kind = 'Donation' WHERE kind IS NULL;
DELETE FROM cultural.donation WHERE event_id IS NULL OR amount IS NULL OR amount <= 0;
ALTER TABLE cultural.donation
  ADD COLUMN IF NOT EXISTS pledged_by_id uuid,
  ADD COLUMN IF NOT EXISTS received_by_id uuid,
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_id uuid,
  ALTER COLUMN event_id SET NOT NULL, ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'Pledged', ALTER COLUMN kind SET NOT NULL, ALTER COLUMN kind SET DEFAULT 'Donation',
  ALTER COLUMN amount SET NOT NULL,
  DROP CONSTRAINT IF EXISTS donation_community_id_event_id_fkey,
  ADD CONSTRAINT donation_event_fkey FOREIGN KEY (community_id, event_id) REFERENCES cultural.event (community_id, id),
  ADD FOREIGN KEY (community_id, pledged_by_id) REFERENCES identity.membership (community_id, id),
  ADD FOREIGN KEY (community_id, received_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT donation_status CHECK (status IN ('Pledged', 'Received')),
  ADD CONSTRAINT donation_kind CHECK (kind IN ('Donation', 'Sponsorship', 'In-kind')),
  ADD CONSTRAINT donation_amount CHECK (amount > 0 AND amount <= 10000000),
  ADD CONSTRAINT donation_received CHECK ((status = 'Received') = (receipt_no IS NOT NULL AND received_at IS NOT NULL)),
  ADD CONSTRAINT donation_donor CHECK (length(btrim(coalesce(donor, ''))) BETWEEN 1 AND 120);
CREATE UNIQUE INDEX IF NOT EXISTS donation_receipt_no ON cultural.donation (community_id, receipt_no) WHERE receipt_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS donation_payment ON cultural.donation (community_id, payment_id) WHERE payment_id IS NOT NULL;

-- ---- expenses ---------------------------------------------------------------------------------------------------------------------------------------
UPDATE cultural.expense SET status = 'Pending approval' WHERE status IS NULL;
DELETE FROM cultural.expense WHERE event_id IS NULL;
ALTER TABLE cultural.expense
  ADD COLUMN IF NOT EXISTS raised_by_id uuid,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_mode text,
  ALTER COLUMN event_id SET NOT NULL, ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'Pending approval',
  DROP CONSTRAINT IF EXISTS expense_community_id_event_id_fkey,
  ADD CONSTRAINT expense_event_fkey FOREIGN KEY (community_id, event_id) REFERENCES cultural.event (community_id, id),
  ADD FOREIGN KEY (community_id, raised_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT expense_status CHECK (status IN ('Pending approval', 'Approved', 'Paid', 'Rejected')),
  ADD CONSTRAINT expense_item CHECK (length(btrim(coalesce(item, ''))) BETWEEN 1 AND 200),
  ADD CONSTRAINT expense_money CHECK (coalesce(amount, 0) >= 0 AND coalesce(estimate, 0) >= 0 AND (coalesce(amount, 0) > 0 OR coalesce(estimate, 0) > 0)),
  ADD CONSTRAINT expense_amount_decided CHECK (status NOT IN ('Approved', 'Paid') OR amount > 0),
  ADD CONSTRAINT expense_paid CHECK ((status = 'Paid') = (paid_at IS NOT NULL)),
  ADD CONSTRAINT expense_ec_approval CHECK (ec_approval IS NULL OR ec_approval IN ('Pending', 'Approved', 'Rejected'));
CREATE INDEX IF NOT EXISTS expense_by_event ON cultural.expense (community_id, event_id);

-- ---- brochure pages and photos ------------------------------------------------------------------------------------------------------------------------
DELETE FROM cultural.brochure_page WHERE event_id IS NULL;
ALTER TABLE cultural.brochure_page
  ALTER COLUMN event_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS brochure_page_community_id_event_id_fkey,
  ADD CONSTRAINT brochure_page_event_fkey FOREIGN KEY (community_id, event_id) REFERENCES cultural.event (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT brochure_page_kind CHECK (kind IS NULL OR kind IN ('Cover', 'Text', 'Programme', 'Offerings', 'Photos', 'Contact')),
  ADD CONSTRAINT brochure_page_layout CHECK (layout IS NULL OR layout IN ('Picture on top', 'Picture left', 'Picture right'));
DELETE FROM cultural.photo WHERE event_id IS NULL;
ALTER TABLE cultural.photo
  ADD COLUMN IF NOT EXISTS file_id uuid,
  ADD COLUMN IF NOT EXISTS thumb text,
  ALTER COLUMN event_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS photo_community_id_event_id_fkey,
  ADD CONSTRAINT photo_thumb CHECK (thumb IS NULL OR length(thumb) <= 200000),
  ADD CONSTRAINT photo_event_fkey FOREIGN KEY (community_id, event_id) REFERENCES cultural.event (community_id, id) ON DELETE CASCADE,
  ADD FOREIGN KEY (community_id, file_id) REFERENCES docs.file_object (community_id, id);

-- ---- files may belong to an event photo or a brochure page; money on donations ----------------------------------------------------------------------
ALTER TABLE docs.file_object DROP CONSTRAINT file_object_owner_kind,
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document',
                                                              'cultural.photo', 'cultural.brochure'));
ALTER TABLE billing.unit_credit DROP CONSTRAINT unit_credit_source_type_check,
  ADD CONSTRAINT unit_credit_source_type_check CHECK (source_type IN ('booking-refund', 'overpayment', 'adjustment', 'applied-to-due', 'prepayment', 'applied-to-booking',
                                                                      'deposit-refund', 'applied-to-donation'));

CREATE OR REPLACE FUNCTION platform.provision_cultural(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance.account (community_id, code, name, kind, is_bank) VALUES
    (p_community, '4400', 'Donations', 'Income', false),
    (p_community, '5100', 'Event expenses', 'Expense', false)
  ON CONFLICT (community_id, code) DO NOTHING;
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
END $$;

SELECT platform.provision_cultural(id) FROM platform.community;

SELECT platform.apply_security();

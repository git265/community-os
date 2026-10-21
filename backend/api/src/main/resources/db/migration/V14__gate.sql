-- =====================================================================================================================================
-- V14 gate: visitors, passes, approvals, the vetted registry, household staff, crews, patrols and flags in their typed shape.
--   * every state is checked (visit, approval, pass, person, flag, link, work order, vehicle, incident)
--   * times that were text are timestamps; settings' durations and notification switches are JSON
--   * a pass code is unique among a community's live passes; one gate rule per unit; one settings row per community
--   * who answered, who resolved, who scanned, who invited are members / units by id, written by the server
-- =====================================================================================================================================

-- ---- the vetted registry -----------------------------------------------------------------------------------------------------------------------
UPDATE gate.person SET name = 'Person ' || short_id WHERE name IS NULL OR btrim(name) = '';
UPDATE gate.person SET status = 'Invited' WHERE status IS NULL;
UPDATE gate.person SET person_class = 'Other' WHERE person_class IS NULL;
ALTER TABLE gate.person
  ADD COLUMN IF NOT EXISTS invited_by_unit_id uuid,
  ADD COLUMN IF NOT EXISTS verified_by_id uuid;
UPDATE gate.person p SET invited_by_unit_id = u.id FROM property.unit u WHERE u.community_id = p.community_id AND u.unit_no = p.invited_by_unit AND p.invited_by_unit_id IS NULL;
ALTER TABLE gate.person
  DROP COLUMN invited_by_unit,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Invited',
  ALTER COLUMN person_class SET NOT NULL,
  ADD FOREIGN KEY (community_id, invited_by_unit_id) REFERENCES property.unit (community_id, id),
  ADD FOREIGN KEY (community_id, verified_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT person_status CHECK (status IN ('Invited', 'Documents pending', 'Under review', 'Active', 'Suspended', 'Blocked')),
  ADD CONSTRAINT person_class CHECK (person_class IN ('Maid / cook', 'Nanny / caretaker', 'Driver', 'Delivery rider', 'Daily worker', 'Landscaper', 'Vendor staff', 'Contractor', 'Other')),
  ADD CONSTRAINT person_id_type CHECK (id_type IS NULL OR id_type IN ('Aadhaar', 'Voter ID', 'Passport', 'Driving licence', 'Other')),
  ADD CONSTRAINT person_id_last4 CHECK (id_last4 IS NULL OR id_last4 ~ '^[0-9A-Z]{1,4}$'),
  ADD CONSTRAINT person_photo CHECK (photo IS NULL OR length(photo) <= 400000);
CREATE INDEX IF NOT EXISTS person_by_name ON gate.person (community_id, lower(name));
COMMENT ON COLUMN gate.person.id_hash IS 'SHA-256 of the community and the ID number - the number itself is never stored, only its last 4 characters';

-- ---- household staff ---------------------------------------------------------------------------------------------------------------------------
UPDATE gate.household_link SET status = 'Active' WHERE status IS NULL;
DELETE FROM gate.household_link WHERE person_id IS NULL OR unit_id IS NULL;
ALTER TABLE gate.household_link
  ALTER COLUMN person_id SET NOT NULL,
  ALTER COLUMN unit_id SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Active',
  ADD CONSTRAINT household_link_status CHECK (status IN ('Active', 'Ended')),
  ADD CONSTRAINT household_link_days CHECK (days <@ ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
CREATE UNIQUE INDEX IF NOT EXISTS household_link_live ON gate.household_link (community_id, person_id, unit_id) WHERE status = 'Active';

-- ---- passes ------------------------------------------------------------------------------------------------------------------------------------
UPDATE gate.pass SET status = 'Active' WHERE status IS NULL;
UPDATE gate.pass SET type = 'One-time' WHERE type IS NULL;
UPDATE gate.pass SET used_count = 0 WHERE used_count IS NULL;
UPDATE gate.pass SET visitor_name = 'Guest' WHERE visitor_name IS NULL OR btrim(visitor_name) = '';
ALTER TABLE gate.pass
  ADD COLUMN IF NOT EXISTS created_by_id uuid,
  ALTER COLUMN visitor_name SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Active',
  ALTER COLUMN used_count SET NOT NULL,
  ALTER COLUMN used_count SET DEFAULT 0,
  ALTER COLUMN code SET NOT NULL,
  ADD FOREIGN KEY (community_id, created_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT pass_type CHECK (type IN ('One-time', 'Recurring', 'Event', 'Goods')),
  ADD CONSTRAINT pass_status CHECK (status IN ('Active', 'Used', 'Expired', 'Cancelled')),
  ADD CONSTRAINT pass_code CHECK (code ~ '^[0-9]{6}$'),
  ADD CONSTRAINT pass_dates CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
  ADD CONSTRAINT pass_counts CHECK (used_count >= 0 AND coalesce(guest_cap, 0) >= 0 AND coalesce(people_count, 0) >= 0),
  ADD CONSTRAINT pass_days CHECK (days <@ ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
  ADD CONSTRAINT pass_goods_kind CHECK (goods_kind IS NULL OR goods_kind IN ('Move in', 'Move out', 'Goods delivery', 'Contractor / materials', 'Waste / tanker', 'Other')),
  ADD CONSTRAINT pass_photo CHECK (photo IS NULL OR length(photo) <= 400000);
CREATE UNIQUE INDEX IF NOT EXISTS pass_live_code ON gate.pass (community_id, code) WHERE status = 'Active';
CREATE INDEX IF NOT EXISTS pass_by_unit ON gate.pass (community_id, unit_id, status);

-- ---- approvals ---------------------------------------------------------------------------------------------------------------------------------
UPDATE gate.approval SET status = 'Pending' WHERE status IS NULL;
ALTER TABLE gate.approval
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Pending',
  ALTER COLUMN requested_at SET DEFAULT now(),
  ADD CONSTRAINT approval_status CHECK (status IN ('Pending', 'Approved', 'Denied', 'No answer')),
  ADD CONSTRAINT approval_fallback CHECK (fallback IS NULL OR fallback IN ('Hold at gate', 'Deny')),
  ADD CONSTRAINT approval_answered CHECK (status IN ('Pending', 'No answer') OR answered_at IS NOT NULL),
  ADD CONSTRAINT approval_photo CHECK (photo IS NULL OR length(photo) <= 400000);
CREATE INDEX IF NOT EXISTS approval_open ON gate.approval (community_id, expires_at) WHERE status = 'Pending';
CREATE INDEX IF NOT EXISTS approval_by_unit ON gate.approval (community_id, unit_id, requested_at DESC);

-- ---- visits (partitioned by month) --------------------------------------------------------------------------------------------------------------
ALTER TABLE gate.visit
  ALTER COLUMN expected_until TYPE timestamptz USING (CASE WHEN expected_until ~ '^\d{4}-\d{2}-\d{2}' THEN expected_until::timestamptz END),
  ADD COLUMN IF NOT EXISTS out_method text,
  ADD COLUMN IF NOT EXISTS verified_by_id uuid;
UPDATE gate.visit SET state = 'Inside' WHERE state IS NULL;
UPDATE gate.visit SET kind = 'Other' WHERE kind IS NULL;
UPDATE gate.visit SET name = 'Visitor' WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE gate.visit
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT visit_state CHECK (state IN ('Awaiting approval', 'Approved', 'Denied', 'No answer', 'Inside', 'Exited', 'Auto-closed', 'Left at gate', 'Refused')),
  ADD CONSTRAINT visit_kind CHECK (kind IN ('Guest', 'Delivery', 'Cab', 'Maid / cook', 'Driver', 'Crew', 'Resident vehicle', 'Goods vehicle', 'Emergency', 'Other')),
  ADD CONSTRAINT visit_inside CHECK (state <> 'Inside' OR in_at IS NOT NULL),
  ADD CONSTRAINT visit_out CHECK (state NOT IN ('Exited', 'Auto-closed') OR out_at IS NOT NULL),
  ADD CONSTRAINT visit_headcount CHECK (coalesce(headcount_in, 0) >= 0 AND coalesce(headcount_out, 0) >= 0 AND coalesce(headcount_expected, 0) >= 0),
  ADD CONSTRAINT visit_photo CHECK (photo IS NULL OR length(photo) <= 400000);
CREATE INDEX IF NOT EXISTS visit_by_id ON gate.visit (community_id, id);
CREATE INDEX IF NOT EXISTS visit_inside ON gate.visit (community_id, expected_until) WHERE state = 'Inside';
CREATE INDEX IF NOT EXISTS visit_by_person ON gate.visit (community_id, person_id) WHERE state = 'Inside';
CREATE INDEX IF NOT EXISTS visit_by_unit ON gate.visit (community_id, unit_id, in_at DESC);

-- ---- flags -------------------------------------------------------------------------------------------------------------------------------------
UPDATE gate.flag SET state = 'Open' WHERE state IS NULL;
ALTER TABLE gate.flag
  ALTER COLUMN grace_until TYPE timestamptz USING (CASE WHEN grace_until ~ '^\d{4}-\d{2}-\d{2}' THEN grace_until::timestamptz END),
  ALTER COLUMN day TYPE date USING (CASE WHEN day ~ '^\d{4}-\d{2}-\d{2}$' THEN day::date END),
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN state SET DEFAULT 'Open',
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN raised_at SET DEFAULT now(),
  ADD CONSTRAINT flag_type CHECK (type IN ('Unrecorded entry', 'Tailgate', 'Override entry', 'Identity mismatch', 'Wrong destination', 'Overstay', 'Blocked person attempt',
                                           'Guard silence', 'Headcount mismatch', 'Manual open', 'Missed patrol')),
  ADD CONSTRAINT flag_state CHECK (state IN ('Watching', 'Open', 'Closed')),
  ADD CONSTRAINT flag_resolution CHECK (resolution IS NULL OR resolution IN ('Registered late', 'False alarm', 'Escorted out', 'Escalated to manager')),
  ADD CONSTRAINT flag_closed CHECK (state <> 'Closed' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)),
  ADD CONSTRAINT flag_photo CHECK (photo IS NULL OR length(photo) <= 400000);
CREATE INDEX IF NOT EXISTS flag_open ON gate.flag (community_id, raised_at DESC) WHERE state <> 'Closed';
CREATE UNIQUE INDEX IF NOT EXISTS flag_one_overstay ON gate.flag (community_id, visit_id) WHERE type = 'Overstay';
CREATE UNIQUE INDEX IF NOT EXISTS flag_one_missed_round ON gate.flag (community_id, round_id, day) WHERE type = 'Missed patrol';

-- ---- patrols -----------------------------------------------------------------------------------------------------------------------------------
UPDATE gate.checkpoint SET name = 'Checkpoint ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE gate.checkpoint
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN active SET DEFAULT true,
  ADD CONSTRAINT checkpoint_code CHECK (code IS NULL OR code ~ '^[A-Za-z0-9]{6,40}$');
UPDATE gate.round SET name = 'Round ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE gate.round
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN active SET DEFAULT true,
  ADD CONSTRAINT round_window CHECK (window_min IS NULL OR window_min BETWEEN 5 AND 720),
  ADD CONSTRAINT round_days CHECK (days <@ ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
ALTER TABLE gate.scan
  ALTER COLUMN at TYPE timestamptz USING (CASE WHEN at ~ '^\d{4}-\d{2}-\d{2}' THEN at::timestamptz END),
  ALTER COLUMN day TYPE date USING (CASE WHEN day ~ '^\d{4}-\d{2}-\d{2}$' THEN day::date END),
  ALTER COLUMN at SET DEFAULT now(),
  ADD COLUMN IF NOT EXISTS guard_id uuid;
CREATE INDEX IF NOT EXISTS scan_by_guard ON gate.scan (community_id, guard_id, at DESC);
CREATE INDEX IF NOT EXISTS scan_by_round ON gate.scan (community_id, round_id, day);

-- ---- the other registers -----------------------------------------------------------------------------------------------------------------------
UPDATE gate.vehicle SET status = 'Active' WHERE status IS NULL;
ALTER TABLE gate.vehicle
  ALTER COLUMN plate SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Active',
  ADD CONSTRAINT vehicle_status CHECK (status IN ('Active', 'Blocked')),
  ADD CONSTRAINT vehicle_class CHECK (vehicle_class IS NULL OR vehicle_class IN ('Resident', 'Tenant', 'Staff', 'Vendor', 'Driver'));
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_plate ON gate.vehicle (community_id, upper(regexp_replace(plate, '\s', '', 'g')));
UPDATE gate.work_order SET status = 'Active' WHERE status IS NULL;
ALTER TABLE gate.work_order
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Active',
  ADD CONSTRAINT work_order_status CHECK (status IN ('Active', 'Closed')),
  ADD CONSTRAINT work_order_days CHECK (days <@ ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
DELETE FROM gate.unit_rule WHERE unit_id IS NULL;
ALTER TABLE gate.unit_rule
  ALTER COLUMN unit_id SET NOT NULL,
  ALTER COLUMN expecting_until TYPE timestamptz USING (CASE WHEN expecting_until ~ '^\d{4}-\d{2}-\d{2}' THEN expecting_until::timestamptz END),
  ADD CONSTRAINT unit_rule_one UNIQUE (community_id, unit_id),
  ADD CONSTRAINT unit_rule_delivery CHECK (delivery_mode IS NULL OR delivery_mode IN ('Allow listed', 'Allow all', 'Ask me each time', 'Leave at gate')),
  ADD CONSTRAINT unit_rule_fallback CHECK (fallback IS NULL OR fallback IN ('Community default', 'Hold at gate', 'Deny'));
UPDATE gate.incident SET status = 'Open' WHERE status IS NULL;
ALTER TABLE gate.incident
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Open',
  ADD COLUMN IF NOT EXISTS reported_by_id uuid,
  ADD CONSTRAINT incident_status CHECK (status IN ('Open', 'EC review', 'Resolved'));
ALTER TABLE gate.pass_template
  ADD CONSTRAINT pass_template_type CHECK (pass_type IS NULL OR pass_type IN ('One-time', 'Recurring', 'Event', 'Goods'));
DELETE FROM gate.console_pulse WHERE guard_id IS NULL;
ALTER TABLE gate.console_pulse
  ALTER COLUMN guard_id SET NOT NULL,
  ADD CONSTRAINT console_pulse_one UNIQUE (community_id, guard_id);
ALTER TABLE gate.setting
  ALTER COLUMN durations TYPE jsonb USING coalesce(platform.try_jsonb(durations), '{}'::jsonb),
  ALTER COLUMN events TYPE jsonb USING coalesce(platform.try_jsonb(events), '{}'::jsonb),
  ALTER COLUMN durations SET DEFAULT '{}',
  ALTER COLUMN events SET DEFAULT '{}',
  ADD CONSTRAINT gate_setting_fallback CHECK (coalesce(fallback, 'Hold at gate') IN ('Hold at gate', 'Deny') AND coalesce(quiet_fallback, 'Hold at gate') IN ('Hold at gate', 'Deny')),
  ADD CONSTRAINT gate_setting_goods CHECK (goods_extra_people IS NULL OR goods_extra_people IN ('Block until the guard confirms', 'Let in and flag')),
  ADD CONSTRAINT gate_setting_numbers CHECK (coalesce(wait_seconds, 60) BETWEEN 10 AND 600 AND coalesce(grace_seconds, 30) >= 0 AND coalesce(overstay_grace_minutes, 10) >= 0
                                             AND coalesce(auto_close_hours, 2) >= 0 AND coalesce(guard_silence_minutes, 0) >= 0 AND coalesce(patrol_min_seconds, 0) >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS gate_setting_one_per_community ON gate.setting (community_id);
COMMENT ON COLUMN gate.setting.badge_salt IS 'secret for the rotating staff badge codes - never sent to the app';

-- ---- defaults for every community ----------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.provision_gate(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gate.setting (community_id, wait_seconds, fallback, grace_seconds, overstay_grace_minutes, auto_close_hours, guard_silence_minutes, quiet_from, quiet_to,
                            quiet_fallback, photo_retention_days, kiosk_on, goods_extra_people, patrol_min_seconds, pass_message, badge_salt, durations, approved_companies, events)
  VALUES (p_community, 60, 'Hold at gate', 30, 10, 2, 45, '22:00', '06:00', 'Hold at gate', 90, false, 'Block until the guard confirms', 20,
          E'Hi {guest}, {host} ({unit}) has made you a pass for {community}.\nCode: {pin}\nValid: {date}{time}\n{vehicle}Show the QR or tell the guard the code at the gate.',
          encode(gen_random_bytes(24), 'hex'),
          '{"Guest": 240, "Delivery": 20, "Cab": 15, "Maid / cook": 480, "Driver": 600, "Crew": 480, "Goods vehicle": 240, "Resident vehicle": 0, "Emergency": 120, "Other": 120}',
          ARRAY['Amazon', 'Flipkart', 'Blinkit', 'Zepto', 'Swiggy', 'Zomato', 'BigBasket', 'Courier / post'], '{}')
  ON CONFLICT (community_id) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION platform.provision_community(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform.provision_core(p_community);
  PERFORM platform.provision_maintenance(p_community);
  PERFORM platform.provision_finance(p_community);
  PERFORM platform.provision_amenities(p_community);
  PERFORM platform.provision_gate(p_community);
END $$;

SELECT platform.provision_gate(id) FROM platform.community;

SELECT platform.apply_security();

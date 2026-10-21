-- =====================================================================================================================================
-- V11 maintenance: the tickets module moves from the generated V6 shape to its typed v2 shape.
--   * a ticket points at its task type, unit, raiser and assignee by id (not by name), and its status / priority / scope are checked here
--   * comments belong to a ticket, have a visibility, and cannot be emptied
--   * field staff are members (membership_id), with the trade they work
--   * every community gets the default task types, quick phrases and category coverage (platform.provision_maintenance)
-- The V6 tables are empty in a v2 database, so columns are replaced rather than migrated.
-- =====================================================================================================================================

-- ---- task types ---------------------------------------------------------------------------------------------------------------------------
ALTER TABLE maintenance.task_type
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN creator_scope SET NOT NULL, ALTER COLUMN creator_scope SET DEFAULT 'Resident',
  ALTER COLUMN assignment_mode SET NOT NULL, ALTER COLUMN assignment_mode SET DEFAULT 'Role queue (staff accepts)',
  ALTER COLUMN resident_visible SET DEFAULT true,
  ALTER COLUMN resident_default SET DEFAULT false,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT task_type_name_len CHECK (length(trim(name)) BETWEEN 2 AND 60),
  ADD CONSTRAINT task_type_creator_scope CHECK (creator_scope IN ('Resident', 'EC / Staff', 'Anyone')),
  ADD CONSTRAINT task_type_assignment_mode CHECK (assignment_mode IN ('Role queue (staff accepts)', 'Direct assign')),
  ADD CONSTRAINT task_type_stages CHECK (COALESCE(quotation_stage, 'No') IN ('No', 'Optional', 'Yes') AND COALESCE(ec_approval_stage, 'No') IN ('No', 'Optional', 'Yes')
                                         AND COALESCE(treasurer_stage, 'No') IN ('No', 'Optional', 'Yes') AND COALESCE(invoice_stage, 'No') IN ('No', 'Optional', 'Yes')
                                         AND COALESCE(payment_stage, 'No') IN ('No', 'Optional', 'Yes')),
  ADD CONSTRAINT task_type_name_unique UNIQUE (community_id, name);
UPDATE maintenance.task_type SET resident_visible = true WHERE resident_visible IS NULL;
UPDATE maintenance.task_type SET resident_default = false WHERE resident_default IS NULL;
ALTER TABLE maintenance.task_type ALTER COLUMN resident_visible SET NOT NULL, ALTER COLUMN resident_default SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_type_one_resident_default ON maintenance.task_type (community_id) WHERE resident_default;

-- ---- tickets ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE maintenance.ticket
  DROP COLUMN IF EXISTS task_type,
  DROP COLUMN IF EXISTS assigned_to,
  DROP COLUMN IF EXISTS affected_units,
  DROP COLUMN IF EXISTS ticket_number,                                    -- short_id is the ticket number (TKT-1051)
  ADD COLUMN task_type_id     uuid,
  ADD COLUMN assignee_id      uuid,
  ADD COLUMN assigned_at      timestamptz,
  ADD COLUMN started_at       timestamptz,
  ADD COLUMN completed_at     timestamptz,
  ADD COLUMN closed_at        timestamptz,
  ADD COLUMN cancelled_at     timestamptz,
  ADD COLUMN cancel_reason    text,
  ADD COLUMN reopen_count     smallint NOT NULL DEFAULT 0,
  ADD COLUMN affected_unit_ids uuid[]  NOT NULL DEFAULT '{}',
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'Open',
  ALTER COLUMN priority SET NOT NULL, ALTER COLUMN priority SET DEFAULT 'Medium',
  ALTER COLUMN scope SET NOT NULL, ALTER COLUMN scope SET DEFAULT 'Unit',
  ALTER COLUMN category SET NOT NULL,
  ALTER COLUMN raised_by_id SET NOT NULL,
  ADD CONSTRAINT ticket_task_type_fk FOREIGN KEY (community_id, task_type_id) REFERENCES maintenance.task_type (community_id, id),
  ADD CONSTRAINT ticket_assignee_fk FOREIGN KEY (community_id, assignee_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT ticket_title_len CHECK (length(trim(title)) BETWEEN 3 AND 200),
  ADD CONSTRAINT ticket_description_len CHECK (description IS NULL OR length(description) <= 10000),
  ADD CONSTRAINT ticket_status CHECK (status IN ('Open', 'Assigned', 'In Progress', 'On Hold', 'Completed', 'Closed', 'Cancelled')),
  ADD CONSTRAINT ticket_priority CHECK (priority IN ('Low', 'Medium', 'High', 'Critical')),
  ADD CONSTRAINT ticket_scope CHECK (scope IN ('Unit', 'Community')),
  ADD CONSTRAINT ticket_unit_scope CHECK (scope = 'Community' OR unit_id IS NOT NULL),                    -- a unit request names its unit
  ADD CONSTRAINT ticket_community_location CHECK (scope = 'Unit' OR length(trim(COALESCE(location, ''))) > 0),   -- a community request says where
  ADD CONSTRAINT ticket_assigned_has_assignee CHECK (status NOT IN ('Assigned', 'In Progress') OR assignee_id IS NOT NULL),
  ADD CONSTRAINT ticket_cancel_reason CHECK (status <> 'Cancelled' OR length(trim(COALESCE(cancel_reason, ''))) > 0),
  ADD CONSTRAINT ticket_rating CHECK (resident_rating IS NULL OR resident_rating BETWEEN 1 AND 5),
  ADD CONSTRAINT ticket_materials_cost CHECK (materials_cost IS NULL OR materials_cost >= 0);
CREATE INDEX IF NOT EXISTS ticket_status_recent ON maintenance.ticket (community_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_unit ON maintenance.ticket (community_id, unit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_assignee ON maintenance.ticket (community_id, assignee_id, status) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_queue ON maintenance.ticket (community_id, category, status) WHERE status IN ('Open', 'Assigned', 'In Progress', 'On Hold');
CREATE INDEX IF NOT EXISTS ticket_community_scope ON maintenance.ticket (community_id, created_at DESC) WHERE scope = 'Community';

-- ---- comments -----------------------------------------------------------------------------------------------------------------------------
ALTER TABLE maintenance.ticket_comment
  DROP CONSTRAINT IF EXISTS ticket_comment_community_id_ticket_id_fkey,
  ALTER COLUMN ticket_id SET NOT NULL,
  ALTER COLUMN author_id SET NOT NULL,
  ALTER COLUMN body SET NOT NULL,
  ALTER COLUMN visibility SET NOT NULL, ALTER COLUMN visibility SET DEFAULT 'Public',
  ADD CONSTRAINT ticket_comment_ticket_fk FOREIGN KEY (community_id, ticket_id) REFERENCES maintenance.ticket (community_id, id),
  ADD CONSTRAINT ticket_comment_visibility CHECK (visibility IN ('Public', 'Internal')),
  ADD CONSTRAINT ticket_comment_body_len CHECK (length(trim(body)) BETWEEN 1 AND 5000);
CREATE INDEX IF NOT EXISTS ticket_comment_thread ON maintenance.ticket_comment (community_id, ticket_id, created_at);

-- ---- field staff, coverage, phrases, final approvers ---------------------------------------------------------------------------------------
ALTER TABLE maintenance.field_staff
  ADD COLUMN membership_id uuid,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN trade SET NOT NULL,
  ALTER COLUMN clocked_in SET DEFAULT false,
  ADD CONSTRAINT field_staff_membership_fk FOREIGN KEY (community_id, membership_id) REFERENCES identity.membership (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT field_staff_one_per_member UNIQUE (community_id, membership_id),
  ADD CONSTRAINT field_staff_shift CHECK (shift IS NULL OR shift IN ('Morning', 'Afternoon', 'Night'));
UPDATE maintenance.field_staff SET clocked_in = false WHERE clocked_in IS NULL;
ALTER TABLE maintenance.field_staff ALTER COLUMN clocked_in SET NOT NULL;
CREATE INDEX IF NOT EXISTS field_staff_trade ON maintenance.field_staff (community_id, trade);

ALTER TABLE maintenance.category_coverage
  ALTER COLUMN category SET NOT NULL,
  ADD CONSTRAINT category_coverage_unique UNIQUE (community_id, category);
ALTER TABLE maintenance.quick_phrase
  ALTER COLUMN phrase SET NOT NULL,
  ALTER COLUMN category SET NOT NULL;
ALTER TABLE maintenance.approver_setting
  ALTER COLUMN name SET NOT NULL;

-- ---- defaults for every community -----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.provision_maintenance(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO maintenance.task_type (community_id, name, icon, creator_scope, assignment_mode, quotation_stage, ec_approval_stage, treasurer_stage, invoice_stage, payment_stage, resident_visible, resident_default)
  VALUES (p_community, 'Resident Maintenance', '🔧', 'Resident',   'Role queue (staff accepts)', 'No',       'No',       'No',       'No',       'No',       true,  true),
         (p_community, 'EC Maintenance',       '🛠', 'EC / Staff', 'Direct assign',              'Optional', 'Optional', 'Optional', 'Optional', 'Optional', false, false),
         (p_community, 'Purchase',             '🧾', 'EC / Staff', 'Direct assign',              'Optional', 'Yes',      'Yes',      'Yes',      'Yes',      false, false),
         (p_community, 'Capital Project',      '🏗', 'EC / Staff', 'Direct assign',              'Optional', 'Yes',      'Yes',      'Yes',      'Yes',      false, false),
         (p_community, 'Emergency',            '🚨', 'EC / Staff', 'Direct assign',              'Optional', 'Optional', 'Optional', 'Optional', 'Optional', false, false),
         (p_community, 'Pest Control',         '🐜', 'Anyone',     'Role queue (staff accepts)', 'No',       'No',       'No',       'No',       'No',       true,  false)
  ON CONFLICT (community_id, name) DO NOTHING;
  INSERT INTO maintenance.quick_phrase (community_id, phrase, category)
  SELECT p_community, v.phrase, v.category FROM (VALUES ('Send a plumber', 'Plumbing'), ('No power in my villa', 'Electrical'), ('No water in my villa', 'Plumbing'),
    ('AC / MEP issue', 'MEP'), ('Broken lock / door', 'Carpentry'), ('Housekeeping request', 'Housekeeping'), ('Garden / landscaping issue', 'Gardening'),
    ('Security concern', 'Security'), ('General helpdesk query', 'Helpdesk')) AS v(phrase, category)
  WHERE NOT EXISTS (SELECT 1 FROM maintenance.quick_phrase q WHERE q.community_id = p_community);
  INSERT INTO maintenance.category_coverage (community_id, category, sub_categories, coordinator, notes)
  VALUES (p_community, 'Plumbing', ARRAY['Leakage', 'Tap / fixture', 'Drain blockage', 'Water tank / motor'], ARRAY['facility_manager', 'handyman_mep'], ''),
         (p_community, 'Electrical', ARRAY['Lighting', 'Switches / wiring', 'Power outage', 'Street lights'], ARRAY['facility_manager', 'handyman_mep'], ''),
         (p_community, 'MEP', ARRAY['DG set', 'Pumps / motors', 'STP / WTP', 'Lift'], ARRAY['handyman_mep'], 'DG, AHUs, pumps'),
         (p_community, 'Carpentry', '{}', ARRAY['facility_manager'], ''),
         (p_community, 'Housekeeping', ARRAY['Common area cleaning', 'Garbage / waste', 'Pest control'], ARRAY['facility_manager'], ''),
         (p_community, 'Gardening', '{}', ARRAY['facility_manager'], ''),
         (p_community, 'Landscape', '{}', ARRAY['facility_manager'], ''),
         (p_community, 'Amenities', '{}', ARRAY['facility_manager'], 'Clubhouse, pool, courts'),
         (p_community, 'Security', ARRAY['Gate / access', 'Patrolling', 'CCTV'], ARRAY['facility_manager'], ''),
         (p_community, 'General', '{}', ARRAY['facility_manager'], '')
  ON CONFLICT (community_id, category) DO NOTHING;
  INSERT INTO maintenance.approver_setting (community_id, name, roles)
  SELECT p_community, 'Final approval', ARRAY['treasurer', 'president']
  WHERE NOT EXISTS (SELECT 1 FROM maintenance.approver_setting a WHERE a.community_id = p_community);
END $$;

-- provision_community = the core (V10) + each module's defaults; later modules replace this function the same way
ALTER FUNCTION platform.provision_community(uuid) RENAME TO provision_core;
CREATE OR REPLACE FUNCTION platform.provision_community(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform.provision_core(p_community);
  PERFORM platform.provision_maintenance(p_community);
END $$;

-- communities that exist already get the maintenance defaults now
SELECT platform.provision_maintenance(id) FROM platform.community;

SELECT platform.apply_security();

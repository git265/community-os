-- Names people type: unit numbers follow the community's rules, names are unique whatever their case, e-mail addresses are stored in lower case.
--
-- 1. Unit numbers ("Villa 12", "A-1204", "T2/0101"): no spaces at either end and single spaces inside; letters, digits, space, '.', '/' and '-',
--    starting and ending with a letter or digit; unique ignoring case, so "Villa 12" and "villa 12" are the same unit.
--    A naming pattern (shared/naming, UnitNaming.java) may be set for the community (property.unit_setting) and for each block (property.block);
--    the API checks it. A block may also have a short code ("A", "T2") that the pattern's {block} stands for.
UPDATE property.unit SET unit_no = regexp_replace(btrim(unit_no), '\s+', ' ', 'g') WHERE unit_no <> regexp_replace(btrim(unit_no), '\s+', ' ', 'g');
ALTER TABLE property.unit DROP CONSTRAINT IF EXISTS unit_no_form;
ALTER TABLE property.unit ADD CONSTRAINT unit_no_form CHECK (unit_no ~ '^[A-Za-z0-9]([A-Za-z0-9 ./-]*[A-Za-z0-9])?$' AND unit_no !~ '  ') NOT VALID;
DO $$ BEGIN ALTER TABLE property.unit VALIDATE CONSTRAINT unit_no_form;   -- existing numbers that do not fit stay as they are until changed
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'some existing unit numbers do not follow the character rules; they are kept until renamed'; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS unit_no_any_case ON property.unit (community_id, lower(unit_no));

ALTER TABLE property.block ADD COLUMN IF NOT EXISTS code text CHECK (code IS NULL OR code ~ '^[A-Za-z0-9]{1,6}$');
ALTER TABLE property.block ADD COLUMN IF NOT EXISTS unit_pattern text CHECK (unit_pattern IS NULL OR length(unit_pattern) BETWEEN 1 AND 60);
CREATE UNIQUE INDEX IF NOT EXISTS block_code_any_case ON property.block (community_id, lower(code)) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS property.unit_setting (
  community_id  uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  unit_pattern  text        CHECK (unit_pattern IS NULL OR length(unit_pattern) BETWEEN 1 AND 60),   -- NULL: any number that follows the character rules
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id)
);

-- 2. Names that are unique in a community are unique whatever their case ("Plumbing" and "plumbing" are one category). The existing unique
--    constraints stay (the provisioning functions name them in ON CONFLICT); these add the case-blind rule beside them.
CREATE UNIQUE INDEX IF NOT EXISTS block_name_any_case            ON property.block (community_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS facility_name_any_case         ON property.facility (community_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS amenity_type_name_any_case     ON amenity.amenity_type (community_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS number_section_name_any_case   ON comms.number_section (community_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS approval_policy_name_any_case  ON finance.approval_policy (community_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS role_group_name_any_case       ON identity.role_group (community_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS approver_setting_name_any_case ON maintenance.approver_setting (community_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS category_any_case              ON maintenance.category_coverage (community_id, lower(category));
CREATE UNIQUE INDEX IF NOT EXISTS task_type_name_any_case        ON maintenance.task_type (community_id, lower(name));
-- (funds, vendors, equipment, bank accounts, folders and log types already were: V18-V21)

-- 3. E-mail addresses (the sign-in name when a person signs in by e-mail, and where mail goes) are stored in lower case, whoever writes them.
CREATE OR REPLACE FUNCTION platform.lower_email() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text := TG_ARGV[0]; v text;
BEGIN
  v := to_jsonb(NEW) ->> col;
  IF v IS NOT NULL AND v <> lower(btrim(v)) THEN NEW := jsonb_populate_record(NEW, jsonb_build_object(col, NULLIF(lower(btrim(v)), ''))); END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES ('identity', 'person', 'email'), ('property', 'occupant', 'email'), ('platform', 'community_settings', 'contact_email'),
                                 ('vendor', 'vendor', 'contact_email')) AS t(sch, tbl, col) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lower_email ON %I.%I', r.sch, r.tbl);
    EXECUTE format('CREATE TRIGGER lower_email BEFORE INSERT OR UPDATE OF %I ON %I.%I FOR EACH ROW EXECUTE FUNCTION platform.lower_email(%L)', r.col, r.sch, r.tbl, r.col);
    EXECUTE format('UPDATE %I.%I SET %I = lower(btrim(%I::text)) WHERE %I IS NOT NULL AND %I::text <> lower(btrim(%I::text))', r.sch, r.tbl, r.col, r.col, r.col, r.col, r.col);
  END LOOP;
END $$;

SELECT platform.apply_security();

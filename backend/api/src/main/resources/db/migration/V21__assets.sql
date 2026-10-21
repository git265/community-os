-- =====================================================================================================================================
-- V21 assets: the equipment register, stock, the plant and DG logs, electricity bills, villa electricity, audits, custom logs, the site map.
--   * equipment: a name (unique, the map and tasks quote it), a condition from the list, no negative counts; papers as attached files
--   * stock moves only through movements (received, issued, counted), kept for good; an item never goes below zero; its status is worked out
--   * readings: one plant log a day, meters that do not run backwards; a DG refill buys litres; a bill is for one service and period,
--     paid with a date; a villa's month is one row; an audit's result and visibility from the lists
--   * the condition log and the map history are written once and kept (who and when are the server's)
-- =====================================================================================================================================

-- ---- equipment ---------------------------------------------------------------------------------------------------------------------------
UPDATE assets.equipment SET name = '(unnamed asset ' || short_id || ')' WHERE name IS NULL OR btrim(name) = '';
UPDATE assets.equipment SET status = 'Working' WHERE status IS NULL OR status NOT IN ('Working', 'Needs attention', 'Under repair', 'Out of service', 'Standby', 'Retired');
ALTER TABLE assets.equipment
  DROP COLUMN IF EXISTS files,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Working',
  ALTER COLUMN faulty TYPE integer USING round(faulty)::integer,
  ADD CONSTRAINT equipment_name CHECK (length(name) BETWEEN 1 AND 200),
  ADD CONSTRAINT equipment_status CHECK (status IN ('Working', 'Needs attention', 'Under repair', 'Out of service', 'Standby', 'Retired')),
  ADD CONSTRAINT equipment_counts CHECK ((quantity IS NULL OR quantity >= 0) AND (faulty IS NULL OR faulty >= 0) AND (faulty IS NULL OR quantity IS NULL OR faulty <= quantity)),
  ADD CONSTRAINT equipment_dates CHECK (next_service IS NULL OR last_service IS NULL OR next_service >= last_service),
  ADD CONSTRAINT equipment_plan FOREIGN KEY (community_id, plan_id) REFERENCES assets.site_plan (community_id, id) ON DELETE SET NULL (plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_name_once ON assets.equipment (community_id, lower(name));

-- ---- stock -------------------------------------------------------------------------------------------------------------------------------
UPDATE assets.inventory_item SET item = '(unnamed item)' WHERE item IS NULL OR btrim(item) = '';
UPDATE assets.inventory_item SET quantity = 0 WHERE quantity IS NULL OR quantity < 0;
UPDATE assets.inventory_item SET uom = 'Nos' WHERE uom IS NULL OR uom NOT IN ('Nos', 'Kg', 'Litres', 'Metres', 'Boxes', 'Sets');
ALTER TABLE assets.inventory_item
  DROP COLUMN IF EXISTS attachments,
  DROP COLUMN IF EXISTS stock_status,
  ALTER COLUMN item SET NOT NULL,
  ALTER COLUMN quantity TYPE numeric(12,3) USING quantity::numeric,
  ALTER COLUMN quantity SET NOT NULL,
  ALTER COLUMN quantity SET DEFAULT 0,
  ALTER COLUMN uom SET NOT NULL,
  ALTER COLUMN uom SET DEFAULT 'Nos',
  ADD CONSTRAINT inventory_item_name CHECK (length(item) BETWEEN 1 AND 200),
  ADD CONSTRAINT inventory_quantity CHECK (quantity >= 0 AND (min_stock IS NULL OR min_stock >= 0)),
  ADD CONSTRAINT inventory_uom CHECK (uom IN ('Nos', 'Kg', 'Litres', 'Metres', 'Boxes', 'Sets'));
CREATE UNIQUE INDEX IF NOT EXISTS inventory_item_once ON assets.inventory_item (community_id, lower(item), coalesce(location, ''));

CREATE TABLE IF NOT EXISTS assets.inventory_movement (
  community_id uuid          NOT NULL REFERENCES platform.community (id),
  id           uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id     text,
  item_id      uuid          NOT NULL,
  kind         text          NOT NULL CHECK (kind IN ('Received', 'Issued', 'Counted')),
  quantity     numeric(12,3) NOT NULL CHECK (quantity >= 0),
  balance      numeric(12,3) NOT NULL CHECK (balance >= 0),
  on_date      date          NOT NULL,
  ticket_id    uuid,
  vendor       text,
  note         text          CHECK (note IS NULL OR length(note) <= 1000),
  version      bigint        NOT NULL DEFAULT 1,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  updated_by   uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  FOREIGN KEY (community_id, item_id) REFERENCES assets.inventory_item (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, ticket_id) REFERENCES maintenance.ticket (community_id, id),
  CHECK (kind = 'Counted' OR quantity > 0)
);
CREATE INDEX IF NOT EXISTS inventory_movement_item ON assets.inventory_movement (community_id, item_id, created_at DESC);
DROP TRIGGER IF EXISTS short_id ON assets.inventory_movement;
CREATE TRIGGER short_id BEFORE INSERT ON assets.inventory_movement FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('STK', '0', '4');

-- ---- readings and bills --------------------------------------------------------------------------------------------------------------------
DELETE FROM assets.plant_log p USING assets.plant_log o WHERE o.community_id = p.community_id AND o.date = p.date AND o.created_at > p.created_at;
ALTER TABLE assets.plant_log
  ALTER COLUMN date SET NOT NULL,
  ADD CONSTRAINT plant_meters CHECK ((bh_close IS NULL OR bh_open IS NULL OR bh_close >= bh_open) AND (wtp_close IS NULL OR wtp_open IS NULL OR wtp_close >= wtp_open)
                                     AND (stp_close IS NULL OR stp_open IS NULL OR stp_close >= stp_open)),
  ADD CONSTRAINT plant_stock CHECK ((salt_stock IS NULL OR salt_stock >= 0) AND (salt_used IS NULL OR salt_used >= 0) AND (chlorine_stock IS NULL OR chlorine_stock >= 0)
                                    AND (chlorine_used IS NULL OR chlorine_used >= 0));
CREATE UNIQUE INDEX IF NOT EXISTS plant_log_one_a_day ON assets.plant_log (community_id, date);

ALTER TABLE assets.dg_fuel_log
  DROP COLUMN IF EXISTS bill,
  ALTER COLUMN date SET NOT NULL,
  ADD CONSTRAINT dg_litres CHECK (litres IS NOT NULL AND litres > 0),
  ADD CONSTRAINT dg_money CHECK ((rate IS NULL OR rate >= 0) AND (amount IS NULL OR amount >= 0) AND (hours_reading IS NULL OR hours_reading >= 0) AND (kwh_reading IS NULL OR kwh_reading >= 0));

UPDATE assets.electricity_bill SET status = 'Unpaid' WHERE status IS NULL OR status NOT IN ('Unpaid', 'Paid');
UPDATE assets.electricity_bill SET paid_on = coalesce(bill_date, created_at::date) WHERE status = 'Paid' AND paid_on IS NULL;
ALTER TABLE assets.electricity_bill
  DROP COLUMN IF EXISTS bill_file,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Unpaid',
  ADD CONSTRAINT electricity_status CHECK (status IN ('Unpaid', 'Paid') AND (status = 'Unpaid') = (paid_on IS NULL)),
  ADD CONSTRAINT electricity_dates CHECK (due_date IS NULL OR bill_date IS NULL OR due_date >= bill_date),
  ADD CONSTRAINT electricity_money CHECK ((amount IS NULL OR amount >= 0) AND (units IS NULL OR units >= 0) AND (export_units IS NULL OR export_units >= 0)
                                         AND (credit_units IS NULL OR credit_units >= 0) AND (credit_amount IS NULL OR credit_amount >= 0));
CREATE UNIQUE INDEX IF NOT EXISTS electricity_bill_once ON assets.electricity_bill (community_id, service_no, period) WHERE service_no IS NOT NULL AND period IS NOT NULL;

DELETE FROM assets.unit_electricity WHERE unit_id IS NULL OR month IS NULL OR month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$';
DELETE FROM assets.unit_electricity e USING assets.unit_electricity o WHERE o.community_id = e.community_id AND o.unit_id = e.unit_id AND o.month = e.month AND o.created_at > e.created_at;
ALTER TABLE assets.unit_electricity
  ALTER COLUMN unit_id SET NOT NULL,
  ALTER COLUMN month SET NOT NULL,
  ADD CONSTRAINT unit_electricity_unit FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT unit_electricity_month CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT unit_electricity_values CHECK ((units IS NULL OR units >= 0) AND (amount IS NULL OR amount >= 0) AND (md_kw IS NULL OR md_kw >= 0) AND (sanctioned_kw IS NULL OR sanctioned_kw >= 0));
CREATE UNIQUE INDEX IF NOT EXISTS unit_electricity_once ON assets.unit_electricity (community_id, unit_id, month);

-- ---- audits and custom logs ------------------------------------------------------------------------------------------------------------------
UPDATE assets.facility_audit SET result = 'Pending' WHERE result IS NULL OR result NOT IN ('Pass', 'Pass with observations', 'Fail', 'Pending');
UPDATE assets.facility_audit SET visibility = 'Internal' WHERE visibility IS NULL OR visibility NOT IN ('Internal', 'Published');
ALTER TABLE assets.facility_audit
  DROP COLUMN IF EXISTS report,
  ALTER COLUMN result SET NOT NULL,
  ALTER COLUMN result SET DEFAULT 'Pending',
  ALTER COLUMN visibility SET NOT NULL,
  ALTER COLUMN visibility SET DEFAULT 'Internal',
  ADD CONSTRAINT audit_result CHECK (result IN ('Pass', 'Pass with observations', 'Fail', 'Pending')),
  ADD CONSTRAINT audit_visibility CHECK (visibility IN ('Internal', 'Published')),
  ADD CONSTRAINT audit_score CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  ADD CONSTRAINT audit_frequency CHECK (frequency_months IS NULL OR frequency_months BETWEEN 0 AND 120),
  ADD CONSTRAINT audit_next CHECK (next_due IS NULL OR audit_date IS NULL OR next_due >= audit_date),
  ADD CONSTRAINT audit_vendor FOREIGN KEY (community_id, auditor_vendor_id) REFERENCES vendor.vendor (community_id, id) ON DELETE SET NULL (auditor_vendor_id);

UPDATE assets.log_type SET name = '(unnamed log)' WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE assets.log_type
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT log_type_frequency CHECK (frequency IS NULL OR frequency IN ('Daily', 'Weekly', 'Monthly', 'As needed'));
CREATE UNIQUE INDEX IF NOT EXISTS log_type_name_once ON assets.log_type (community_id, lower(name));
DELETE FROM assets.log_entry WHERE log_id IS NULL OR date IS NULL;
ALTER TABLE assets.log_entry
  DROP COLUMN IF EXISTS attachments,
  ALTER COLUMN log_id SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ADD CONSTRAINT log_entry_type FOREIGN KEY (community_id, log_id) REFERENCES assets.log_type (community_id, id) ON DELETE CASCADE;

-- ---- the condition log and the map history: written once ------------------------------------------------------------------------------------
DELETE FROM assets.condition_log WHERE date IS NULL OR condition IS NULL;
ALTER TABLE assets.condition_log
  DROP COLUMN IF EXISTS by,
  ADD COLUMN IF NOT EXISTS by_id uuid,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN condition SET NOT NULL,
  ADD CONSTRAINT condition_value CHECK (condition IN ('Working', 'Needs attention', 'Under repair', 'Out of service', 'Standby', 'Retired')),
  ADD CONSTRAINT condition_asset FOREIGN KEY (community_id, asset_id) REFERENCES assets.equipment (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT condition_ticket FOREIGN KEY (community_id, ticket_id) REFERENCES maintenance.ticket (community_id, id);
ALTER TABLE assets.map_version
  DROP COLUMN IF EXISTS by,
  DROP COLUMN IF EXISTS at,
  ADD COLUMN IF NOT EXISTS by_id uuid;

CREATE OR REPLACE FUNCTION assets.kept_as_written() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is a history: it is never changed or deleted', TG_TABLE_NAME USING ERRCODE = '42501'; END $$;
DROP TRIGGER IF EXISTS kept ON assets.inventory_movement;
CREATE TRIGGER kept BEFORE UPDATE OR DELETE ON assets.inventory_movement FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION assets.kept_as_written();
DROP TRIGGER IF EXISTS kept ON assets.map_version;
CREATE TRIGGER kept BEFORE UPDATE OR DELETE ON assets.map_version FOR EACH ROW EXECUTE FUNCTION assets.kept_as_written();
DROP TRIGGER IF EXISTS kept ON assets.condition_log;
CREATE TRIGGER kept BEFORE UPDATE ON assets.condition_log FOR EACH ROW EXECUTE FUNCTION assets.kept_as_written();

ALTER TABLE docs.file_object DROP CONSTRAINT IF EXISTS file_object_owner_kind,
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document',
                                                              'cultural.photo', 'cultural.brochure', 'governance.agenda', 'governance.minutes', 'vendor.vendor',
                                                              'assets.equipment', 'assets.inventory', 'assets.dg_fuel', 'assets.electricity_bill', 'assets.audit', 'assets.log_entry'));

SELECT platform.apply_security();

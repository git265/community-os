-- =====================================================================================================================================
-- V47 the people of a unit over time: a tenant moving out, a change of owner, and every other change to who lives there.
--   * occupant rows are never deleted: a person who leaves gets to_date (the day they left); from_date is when they came
--   * unit_change   one row per change (who left, who came, what the unit owed then, what the gate stopped), the unit's history
--   * unit.bill_to  who the unit's bills are addressed to (Owner / Tenant); a new bill takes it from its unit
--   * gate.vehicle  'Ended': the car of a household that left (kept, no longer known at the gate)
-- =====================================================================================================================================
ALTER TABLE property.unit ADD COLUMN IF NOT EXISTS bill_to text NOT NULL DEFAULT 'Owner';
ALTER TABLE property.unit DROP CONSTRAINT IF EXISTS unit_bill_to, ADD CONSTRAINT unit_bill_to CHECK (bill_to IN ('Owner', 'Tenant'));

-- a new bill is addressed as its unit says (the billing code never sets it itself)
CREATE OR REPLACE FUNCTION billing.due_bill_to() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unit_id IS NOT NULL THEN
    NEW.bill_to := coalesce((SELECT u.bill_to FROM property.unit u WHERE u.community_id = NEW.community_id AND u.id = NEW.unit_id), 'Owner');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS due_bill_to ON billing.due;
CREATE TRIGGER due_bill_to BEFORE INSERT ON billing.due FOR EACH ROW EXECUTE FUNCTION billing.due_bill_to();

-- an e-mail address on a unit's contact looks like one (rows already there are kept as they are)
ALTER TABLE property.occupant DROP CONSTRAINT IF EXISTS occupant_email;
ALTER TABLE property.occupant ADD CONSTRAINT occupant_email CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') NOT VALID;

CREATE TABLE IF NOT EXISTS property.unit_change (
  community_id     uuid          NOT NULL REFERENCES platform.community (id),
  id               uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id         text,
  unit_id          uuid          NOT NULL,
  kind             text          NOT NULL CHECK (kind IN ('Moved out', 'Owner changed', 'People changed')),
  on_date          date          NOT NULL,
  people_out       jsonb         NOT NULL DEFAULT '[]',     -- [{occupantId, name, relation}]
  people_in        jsonb         NOT NULL DEFAULT '[]',
  occupancy_before text,
  occupancy_after  text,
  dues_outstanding numeric(14,2) NOT NULL DEFAULT 0,        -- what the unit owed on the day (it stays with the unit)
  summary          jsonb         NOT NULL DEFAULT '{}',     -- accounts closed, gate links / passes / vehicles ended, bookings and tickets left open
  note             text          CHECK (note IS NULL OR length(note) <= 2000),
  version          bigint        NOT NULL DEFAULT 1,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  updated_by       uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id)
);
CREATE INDEX IF NOT EXISTS unit_change_unit ON property.unit_change (community_id, unit_id, on_date DESC, created_at DESC);
DROP TRIGGER IF EXISTS short_id ON property.unit_change;
CREATE TRIGGER short_id BEFORE INSERT ON property.unit_change FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('UCH', '0', '4');

ALTER TABLE gate.vehicle DROP CONSTRAINT IF EXISTS vehicle_status;
ALTER TABLE gate.vehicle ADD CONSTRAINT vehicle_status CHECK (status IN ('Active', 'Blocked', 'Ended'));

SELECT platform.apply_security();

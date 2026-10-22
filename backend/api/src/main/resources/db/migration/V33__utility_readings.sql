-- Meter readings, rate cards and utility types are kept on the back end (the resource kit: /billing/readings, /billing/rate-cards,
-- /billing/utility-types). A reading names its unit by id, one per unit, utility and month; a published one points at the bill it raised.
DELETE FROM billing.meter_reading WHERE unit_id IS NULL OR utility IS NULL OR month IS NULL;
ALTER TABLE billing.meter_reading
  ALTER COLUMN unit_id SET NOT NULL, ALTER COLUMN utility SET NOT NULL, ALTER COLUMN month SET NOT NULL,
  ALTER COLUMN extras TYPE jsonb USING (CASE WHEN extras IS NULL OR btrim(extras) = '' THEN NULL ELSE extras::jsonb END),
  ALTER COLUMN published_at TYPE date USING published_at::date;
ALTER TABLE billing.meter_reading DROP CONSTRAINT IF EXISTS meter_reading_unit;
ALTER TABLE billing.meter_reading ADD CONSTRAINT meter_reading_unit FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id);
ALTER TABLE billing.meter_reading DROP CONSTRAINT IF EXISTS meter_reading_due;
ALTER TABLE billing.meter_reading ADD CONSTRAINT meter_reading_due FOREIGN KEY (community_id, due_id) REFERENCES billing.due (community_id, id);
ALTER TABLE billing.meter_reading DROP CONSTRAINT IF EXISTS meter_reading_values;
ALTER TABLE billing.meter_reading ADD CONSTRAINT meter_reading_values CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$' AND status IN ('Draft', 'Published')
  AND (previous_reading IS NULL OR previous_reading >= 0) AND (current_reading IS NULL OR previous_reading IS NULL OR current_reading >= previous_reading)
  AND (status <> 'Published' OR due_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS meter_reading_once ON billing.meter_reading (community_id, unit_id, lower(utility), month);
CREATE INDEX IF NOT EXISTS meter_reading_by_due ON billing.meter_reading (community_id, due_id) WHERE due_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meter_reading_by_month ON billing.meter_reading (community_id, utility, month);

DELETE FROM billing.utility_rate_card WHERE type IS NULL;
ALTER TABLE billing.utility_rate_card ALTER COLUMN type SET NOT NULL;
ALTER TABLE billing.utility_rate_card DROP CONSTRAINT IF EXISTS rate_card_values;
ALTER TABLE billing.utility_rate_card ADD CONSTRAINT rate_card_values CHECK (coalesce(rate_per_unit, 0) >= 0 AND coalesce(fixed_charge, 0) >= 0 AND coalesce(tax, 0) >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS rate_card_once ON billing.utility_rate_card (community_id, lower(type));

DELETE FROM billing.utility_type WHERE name IS NULL;
ALTER TABLE billing.utility_type ALTER COLUMN name SET NOT NULL, ALTER COLUMN active SET DEFAULT true,
  ALTER COLUMN extra_inputs TYPE jsonb USING (CASE WHEN extra_inputs IS NULL OR btrim(extra_inputs) = '' THEN NULL ELSE extra_inputs::jsonb END);
CREATE UNIQUE INDEX IF NOT EXISTS utility_type_once ON billing.utility_type (community_id, lower(name));

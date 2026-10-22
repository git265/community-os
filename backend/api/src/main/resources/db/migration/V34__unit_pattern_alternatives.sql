-- A naming pattern may list alternatives ("Villa {n} or {block}-{floor}{n:2}"): up to 120 characters.
ALTER TABLE property.unit_setting DROP CONSTRAINT IF EXISTS unit_setting_unit_pattern_check;
ALTER TABLE property.unit_setting ADD CONSTRAINT unit_setting_unit_pattern_check CHECK (unit_pattern IS NULL OR length(unit_pattern) BETWEEN 1 AND 120);
ALTER TABLE property.block DROP CONSTRAINT IF EXISTS block_unit_pattern_check;
ALTER TABLE property.block ADD CONSTRAINT block_unit_pattern_check CHECK (unit_pattern IS NULL OR length(unit_pattern) BETWEEN 1 AND 120);

-- A unit's extra details the app's unit form has (bedrooms, parking, residents, vehicles, domestic staff, possession date) are custom fields
-- of property.unit: defined for every community, so a unit edit with them is no longer refused ("There is no field ...").
CREATE OR REPLACE FUNCTION platform.provision_unit_fields(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO config.field_definition (community_id, entity, field_key, label, data_type, is_custom, sort_order)
  SELECT p_community, 'property.unit', v.k, v.l, v.t, true, v.o
  FROM (VALUES ('bedrooms', 'Bedrooms', 'number', 10), ('parking', 'Parking slots', 'number', 20), ('residentsCount', 'Residents', 'number', 30),
               ('vehiclesCount', 'Vehicles', 'number', 40), ('domesticStaffCount', 'Domestic staff', 'number', 50), ('possessionDate', 'Possession date', 'date', 60)) AS v(k, l, t, o)
  ON CONFLICT (community_id, entity, field_key) DO NOTHING;
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
  PERFORM platform.provision_ledger(p_community);
  PERFORM platform.provision_workforce(p_community);
  PERFORM platform.provision_bill_categories(p_community);
  PERFORM platform.provision_unit_fields(p_community);
END $$;
SELECT platform.provision_unit_fields(id) FROM platform.community;

SELECT platform.apply_security();

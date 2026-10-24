-- Every bill category the app offers exists on the server, and a utility added later can be billed.
--   * Sinking fund, Amenity booking, Adjustment and Other join the six of V10 (the app's "Corpus fund" and "Special levy" are V10's Corpus / Levy).
--   * Adding a utility type (Gas, Solar ...) creates its charge category: a published reading raises a bill under the utility's name.

CREATE OR REPLACE FUNCTION platform.provision_bill_categories(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing.charge_category (community_id, code, name, is_utility, income_account_id)
    SELECT p_community, v.code, v.name, false, (SELECT id FROM finance.account a WHERE a.community_id = p_community AND a.code = v.acct)
    FROM (VALUES ('Sinking fund', 'Sinking fund', '4000'), ('Amenity booking', 'Amenity booking', '4200'), ('Adjustment', 'Adjustment', '4000'), ('Other', 'Other', '4000')) AS v(code, name, acct)
  ON CONFLICT (community_id, code) DO NOTHING;
  -- utilities that already exist without a category of their own
  INSERT INTO billing.charge_category (community_id, code, name, is_utility, income_account_id)
    SELECT u.community_id, u.name, u.name, true, (SELECT id FROM finance.account a WHERE a.community_id = u.community_id AND a.code = '4100')
    FROM billing.utility_type u
    WHERE u.community_id = p_community AND u.name ~ '^[A-Za-z][A-Za-z0-9 _-]{0,39}$'
      AND NOT EXISTS (SELECT 1 FROM billing.charge_category c WHERE c.community_id = u.community_id AND lower(c.code) = lower(u.name))
  ON CONFLICT (community_id, code) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION billing.utility_charge_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name ~ '^[A-Za-z][A-Za-z0-9 _-]{0,39}$'
     AND NOT EXISTS (SELECT 1 FROM billing.charge_category c WHERE c.community_id = NEW.community_id AND lower(c.code) = lower(NEW.name)) THEN
    INSERT INTO billing.charge_category (community_id, code, name, is_utility, income_account_id)
    VALUES (NEW.community_id, NEW.name, NEW.name, true, (SELECT id FROM finance.account a WHERE a.community_id = NEW.community_id AND a.code = '4100'))
    ON CONFLICT (community_id, code) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS utility_charge_category ON billing.utility_type;
CREATE TRIGGER utility_charge_category AFTER INSERT ON billing.utility_type FOR EACH ROW EXECUTE FUNCTION billing.utility_charge_category();

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
END $$;
SELECT platform.provision_bill_categories(id) FROM platform.community;

SELECT platform.apply_security();

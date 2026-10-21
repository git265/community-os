-- First community for a fresh stack (run by the `seed` service after the API has migrated the schema). Safe to run again.
--   psql -v slug=la-paloma -v name='La Paloma' -v phone=+919800000000 -v admin='Super Admin' -v villas=212 -f seed.sql
\set ON_ERROR_STOP 1
INSERT INTO platform.community (slug, name) VALUES (:'slug', :'name') ON CONFLICT (slug) DO NOTHING;
SELECT id AS cid FROM platform.community WHERE slug = :'slug' \gset
SELECT platform.provision_community(:'cid') WHERE NOT EXISTS (SELECT 1 FROM identity.role WHERE community_id = :'cid');

-- the first Super Admin: signs in with a one-time code to this phone (in the dev profile the code is printed in the api log)
INSERT INTO identity.person (phone_e164, full_name) VALUES (:'phone', :'admin') ON CONFLICT (phone_e164) DO NOTHING;
INSERT INTO identity.membership (community_id, person_id, display_name, joined_on)
  SELECT :'cid', p.id, :'admin', current_date FROM identity.person p WHERE p.phone_e164 = :'phone'
  ON CONFLICT (community_id, person_id) DO NOTHING;
INSERT INTO identity.membership_role (community_id, membership_id, role_id, is_primary)
  SELECT :'cid', m.id, r.id, true FROM identity.membership m JOIN identity.person p ON p.id = m.person_id
  JOIN identity.role r ON r.community_id = m.community_id AND r.code = 'super_admin'
  WHERE m.community_id = :'cid' AND p.phone_e164 = :'phone'
    AND NOT EXISTS (SELECT 1 FROM identity.membership_role x WHERE x.community_id = m.community_id AND x.membership_id = m.id);

-- the villas (Villa 1 ... Villa N), once
INSERT INTO property.unit (community_id, unit_no, unit_type)
  SELECT :'cid', 'Villa ' || g, 'Villa' FROM generate_series(1, :villas) g
  WHERE NOT EXISTS (SELECT 1 FROM property.unit u WHERE u.community_id = :'cid')
  ON CONFLICT (community_id, unit_no) DO NOTHING;

SELECT c.slug, c.name, (SELECT count(*) FROM property.unit u WHERE u.community_id = c.id) AS units,
       (SELECT count(*) FROM identity.membership m WHERE m.community_id = c.id) AS members
FROM platform.community c WHERE c.id = :'cid';

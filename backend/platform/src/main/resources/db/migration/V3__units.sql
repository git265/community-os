-- =====================================================================================================================================
-- The community's places: blocks / towers, units, who lives in or owns each unit, named facilities
-- =====================================================================================================================================

CREATE TABLE blocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  code          text,
  kind          text NOT NULL DEFAULT 'Tower' CHECK (kind IN ('Tower', 'Villa lane / cluster', 'Phase', 'Wing', 'Other')),
  planned_units integer CHECK (planned_units >= 0),
  active        boolean NOT NULL DEFAULT true,
  notes         text,
  custom        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, name)
);
SELECT use_row_stamps('blocks');

CREATE TABLE unit_types (
  community_id  uuid NOT NULL REFERENCES communities (id),
  code          text NOT NULL,                            -- 'Villa', 'Apartment', 'Shop' ... the community's own list
  active        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (community_id, code)
);

CREATE TABLE units (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  unit_no          text NOT NULL CHECK (length(btrim(unit_no)) BETWEEN 1 AND 40),   -- 'Villa 135', 'A-1204'
  block_id         uuid,
  unit_type        text NOT NULL,
  occupancy        text NOT NULL DEFAULT 'Owner occupied' CHECK (occupancy IN ('Owner occupied', 'Tenant occupied', 'Vacant')),
  bill_to          text NOT NULL DEFAULT 'Owner' CHECK (bill_to IN ('Owner', 'Tenant')),
  maintenance_plan text CHECK (maintenance_plan IN ('Monthly', 'Quarterly', 'Yearly')),
  area_sqft        numeric(10,2) CHECK (area_sqft > 0),
  bedrooms         smallint CHECK (bedrooms BETWEEN 0 AND 50),
  parking_slots    smallint CHECK (parking_slots BETWEEN 0 AND 50),
  residents_count  smallint CHECK (residents_count BETWEEN 0 AND 100),
  possession_date  date,
  contracted_kw    numeric(6,2) CHECK (contracted_kw >= 0),
  status           text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Merged', 'Demolished')),
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, unit_no),
  FOREIGN KEY (community_id, block_id) REFERENCES blocks (community_id, id),
  FOREIGN KEY (community_id, unit_type) REFERENCES unit_types (community_id, code)
);
CREATE INDEX units_block ON units (community_id, block_id);
CREATE INDEX units_no_trgm ON units USING gin (unit_no gin_trgm_ops);
SELECT use_row_stamps('units');

-- Who is connected to a unit, and how. Replaces the owner / tenant / secondary-owner text columns: a person can own two villas,
-- a villa can have co-owners, and history is kept (valid_to) when a tenant moves out.
CREATE TABLE unit_occupancies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  unit_id       uuid NOT NULL,
  person_id     uuid NOT NULL,
  relation      text NOT NULL CHECK (relation IN ('Owner', 'Co-owner', 'Tenant', 'Family member', 'Domestic staff')),
  is_primary    boolean NOT NULL DEFAULT false,               -- the primary owner / tenant: who bills and notices go to
  valid_from    date NOT NULL DEFAULT current_date,
  valid_to      date,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, person_id) REFERENCES people (community_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- at most one CURRENT primary owner and one current primary tenant per unit
CREATE UNIQUE INDEX unit_occupancies_primary ON unit_occupancies (community_id, unit_id, (CASE WHEN relation IN ('Owner', 'Co-owner') THEN 'Owner' ELSE relation END))
  WHERE is_primary AND valid_to IS NULL;
CREATE INDEX unit_occupancies_person ON unit_occupancies (community_id, person_id) WHERE valid_to IS NULL;
CREATE INDEX unit_occupancies_unit ON unit_occupancies (community_id, unit_id) WHERE valid_to IS NULL;
SELECT use_row_stamps('unit_occupancies');

-- A role grant limited to units / blocks (user_roles in V2): an owner acts for their units, a Block Secretary for a block.
CREATE TABLE user_role_scopes (
  community_id  uuid NOT NULL,
  user_role_id  uuid NOT NULL,
  unit_id       uuid,
  block_id      uuid,
  FOREIGN KEY (community_id, user_role_id) REFERENCES user_roles (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, block_id) REFERENCES blocks (community_id, id) ON DELETE CASCADE,
  CHECK ((unit_id IS NULL) <> (block_id IS NULL))
);
CREATE UNIQUE INDEX user_role_scopes_unit ON user_role_scopes (community_id, user_role_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE UNIQUE INDEX user_role_scopes_block ON user_role_scopes (community_id, user_role_id, block_id) WHERE block_id IS NOT NULL;
CREATE INDEX user_role_scopes_by_unit ON user_role_scopes (community_id, unit_id) WHERE unit_id IS NOT NULL;

CREATE TABLE facilities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'Common area' CHECK (kind IN ('Clubhouse', 'Pool', 'Gym', 'Court', 'Hall', 'Plant', 'Gate', 'Common area', 'Other')),
  block_id      uuid,
  active        boolean NOT NULL DEFAULT true,
  custom        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, name),
  FOREIGN KEY (community_id, block_id) REFERENCES blocks (community_id, id)
);
SELECT use_row_stamps('facilities');

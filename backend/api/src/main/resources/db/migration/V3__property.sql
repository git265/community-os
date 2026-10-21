-- =====================================================================================================================================
-- V3 property: blocks / towers, named places, units, and the people who own or live in them
-- (was blocks, facilities and properties; the owner / tenant columns of a property become occupant rows)
-- =====================================================================================================================================

CREATE TABLE IF NOT EXISTS property.block (
  community_id uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id     text,
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind         text        NOT NULL DEFAULT 'Block' CHECK (kind IN ('Block', 'Tower', 'Phase', 'Lane', 'Zone')),
  sort_order   integer     NOT NULL DEFAULT 0,
  custom       jsonb       NOT NULL DEFAULT '{}',
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, name)
);

CREATE TABLE IF NOT EXISTS property.facility (
  community_id uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id     text,
  name         text        NOT NULL,
  kind         text        NOT NULL,                     -- Clubhouse, Pool, STP, Gate ...
  block_id     uuid,
  active       boolean     NOT NULL DEFAULT true,
  custom       jsonb       NOT NULL DEFAULT '{}',
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, name),
  FOREIGN KEY (community_id, block_id) REFERENCES property.block (community_id, id)
);

CREATE TABLE IF NOT EXISTS property.unit (
  community_id     uuid          NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id               uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id         text,
  unit_no          text          NOT NULL CHECK (length(unit_no) BETWEEN 1 AND 40),   -- what people say: "Villa 135", "A-1204"
  block_id         uuid,
  unit_type        text          NOT NULL,                                              -- Villa, Apartment ... (community_settings.property_types)
  occupancy        text          NOT NULL DEFAULT 'Owner occupied' CHECK (occupancy IN ('Owner occupied', 'Tenant occupied', 'Vacant')),
  area_sqft        numeric(10,2) CHECK (area_sqft IS NULL OR area_sqft > 0),
  maintenance_plan text          CHECK (maintenance_plan IS NULL OR maintenance_plan IN ('Monthly', 'Quarterly', 'Yearly')),
  sanctioned_kw    numeric(8,2)  CHECK (sanctioned_kw IS NULL OR sanctioned_kw >= 0),
  status           text          NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Archived')),
  custom           jsonb         NOT NULL DEFAULT '{}',
  version          bigint        NOT NULL DEFAULT 1,
  created_at       timestamptz   NOT NULL DEFAULT now(), created_by uuid,
  updated_at       timestamptz   NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, unit_no),
  FOREIGN KEY (community_id, block_id) REFERENCES property.block (community_id, id)
);
CREATE INDEX IF NOT EXISTS unit_block ON property.unit (community_id, block_id);

-- who owns / lives in a unit. A row may name someone who has no sign-in yet (person_id NULL); linking the phone to a person gives access.
CREATE TABLE IF NOT EXISTS property.occupant (
  community_id uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  unit_id      uuid        NOT NULL,
  person_id    uuid        REFERENCES identity.person (id),
  relation     text        NOT NULL CHECK (relation IN ('Owner', 'Co-owner', 'Tenant', 'Family', 'Caretaker')),
  full_name    text        NOT NULL,
  phone_e164   text        CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email        citext,
  is_primary   boolean     NOT NULL DEFAULT false,
  portal_access boolean    NOT NULL DEFAULT true,
  from_date    date,
  to_date      date,
  custom       jsonb       NOT NULL DEFAULT '{}',
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id) ON DELETE CASCADE,
  CHECK (to_date IS NULL OR from_date IS NULL OR to_date >= from_date)
);
CREATE INDEX IF NOT EXISTS occupant_unit ON property.occupant (community_id, unit_id);
CREATE INDEX IF NOT EXISTS occupant_person ON property.occupant (person_id) WHERE person_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS occupant_one_primary_owner ON property.occupant (community_id, unit_id) WHERE is_primary AND relation = 'Owner' AND to_date IS NULL;
-- one phone number belongs to one person: two occupant rows of the same community with the same number must be the same person
CREATE UNIQUE INDEX IF NOT EXISTS occupant_phone_unit ON property.occupant (community_id, unit_id, phone_e164) WHERE phone_e164 IS NOT NULL AND to_date IS NULL;

-- block-limited staff (Block Admin of tower B): the blocks a membership is limited to; no rows = not limited
CREATE TABLE IF NOT EXISTS identity.membership_block (
  community_id  uuid NOT NULL,
  membership_id uuid NOT NULL,
  block_id      uuid NOT NULL,
  PRIMARY KEY (community_id, membership_id, block_id),
  FOREIGN KEY (community_id, membership_id) REFERENCES identity.membership (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, block_id) REFERENCES property.block (community_id, id) ON DELETE CASCADE
);

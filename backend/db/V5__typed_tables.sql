-- Round 71: hot, relational collections move out of the generic `documents` table into real tables.
--
-- Design: each record is still ONE JSON document in `data` (that stays the single source of truth, so community-defined fields, the browser
-- store and the REST contract do not change). The columns the database needs to filter, sort, join and constrain are GENERATED from `data`,
-- so they can never disagree with it and no application code has to keep them in step. Foreign keys only where the rule is absolute.
-- Configurable collections (forum, notices, settings, schemas, custom fields ...) stay in `documents`.
--
--   units       <- properties   dues <- dues   bookings <- amenities   tickets <- tickets   ledger_entries <- ledger   users <- users
--   audit_log   <- audit        (append-only, partitioned by month)

-- ---- tolerant casts for the generated columns: bad text becomes NULL, never an error that would block a save ----------------------------
CREATE OR REPLACE FUNCTION cos_num(t text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN IF t ~ '^-?[0-9]{1,15}(\.[0-9]+)?$' THEN RETURN t::numeric; END IF; RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION cos_date(t text) RETURNS date LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN IF t ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN RETURN to_date(left(t, 10), 'YYYY-MM-DD'); END IF; RETURN NULL; EXCEPTION WHEN others THEN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION cos_ts(t text) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF t ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN RETURN t::timestamptz; END IF;           -- explicit offset: deterministic
  IF t ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+)?$' THEN RETURN (replace(t, 'T', ' ')::timestamp) AT TIME ZONE 'UTC'; END IF;   -- no offset: read as UTC
  RETURN NULL;
EXCEPTION WHEN others THEN RETURN NULL; END $$;

-- ---- units (collection: properties) ----------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS units (
  tenant     text   NOT NULL,
  id         text   NOT NULL,
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  data       jsonb  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  short_id   text GENERATED ALWAYS AS (NULLIF(data->>'shortId', '')) STORED,                       -- the number people quote (TKT-1058)
  unit       text GENERATED ALWAYS AS (NULLIF(data->>'unit', '')) STORED,
  zone       text GENERATED ALWAYS AS (NULLIF(data->>'zone', '')) STORED,          -- the block / tower
  unit_type  text GENERATED ALWAYS AS (data->>'type') STORED,
  occupancy  text GENERATED ALWAYS AS (data->>'occupancy') STORED,
  owner_name text GENERATED ALWAYS AS (data->>'owner') STORED,
  PRIMARY KEY (tenant, id),
  UNIQUE (tenant, unit)                                                             -- one record per unit; also what the foreign keys below point at
);
CREATE INDEX IF NOT EXISTS units_short ON units (tenant, short_id) WHERE short_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS units_zone ON units (tenant, zone);

-- ---- users -----------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  tenant     text   NOT NULL,
  id         text   NOT NULL,
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  data       jsonb  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  short_id   text GENERATED ALWAYS AS (NULLIF(data->>'shortId', '')) STORED,                       -- the number people quote (TKT-1058)
  full_name  text GENERATED ALWAYS AS (data->>'name') STORED,
  phone      text GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(data->>'phone', ''), '[^0-9]', '', 'g'), '')) STORED,   -- digits only: how sign-in matches a number
  email      text GENERATED ALWAYS AS (NULLIF(lower(data->>'email'), '')) STORED,
  role_id    text GENERATED ALWAYS AS (data->>'roleId') STORED,
  status     text GENERATED ALWAYS AS (data->>'status') STORED,
  auth_subject text GENERATED ALWAYS AS (NULLIF(data->>'authSubject', '')) STORED,        -- the identity provider's id (OIDC `sub`)
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS users_short ON users (tenant, short_id) WHERE short_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_phone ON users (tenant, phone);
CREATE INDEX IF NOT EXISTS users_email ON users (tenant, email);
CREATE INDEX IF NOT EXISTS users_subject ON users (tenant, auth_subject) WHERE auth_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_role ON users (tenant, role_id);

-- ---- dues -----------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dues (
  tenant     text   NOT NULL,
  id         text   NOT NULL,
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  data       jsonb  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  short_id   text GENERATED ALWAYS AS (NULLIF(data->>'shortId', '')) STORED,                       -- the number people quote (TKT-1058)
  unit         text    GENERATED ALWAYS AS (NULLIF(data->>'unit', '')) STORED,
  status       text    GENERATED ALWAYS AS (data->>'status') STORED,
  category     text    GENERATED ALWAYS AS (data->>'category') STORED,
  amount       numeric GENERATED ALWAYS AS (cos_num(data->>'amount')) STORED,
  due_date     date    GENERATED ALWAYS AS (cos_date(data->>'dueDate')) STORED,
  billed_month text    GENERATED ALWAYS AS (data->>'billedMonth') STORED,
  PRIMARY KEY (tenant, id),
  FOREIGN KEY (tenant, unit) REFERENCES units (tenant, unit)                       -- a bill always belongs to a real unit (NULL = a community-level charge)
);
CREATE INDEX IF NOT EXISTS dues_short ON dues (tenant, short_id) WHERE short_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dues_unit ON dues (tenant, unit, status);
CREATE INDEX IF NOT EXISTS dues_due ON dues (tenant, due_date);
CREATE INDEX IF NOT EXISTS dues_status ON dues (tenant, status, due_date);

-- ---- bookings (collection: amenities) -----------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  tenant     text   NOT NULL,
  id         text   NOT NULL,
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  data       jsonb  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  short_id   text GENERATED ALWAYS AS (NULLIF(data->>'shortId', '')) STORED,                       -- the number people quote (TKT-1058)
  amenity        text    GENERATED ALWAYS AS (data->>'amenity') STORED,
  unit           text    GENERATED ALWAYS AS (NULLIF(data->>'unit', '')) STORED,
  booking_date   date    GENERATED ALWAYS AS (cos_date(data->>'date')) STORED,
  slot           text    GENERATED ALWAYS AS (data->>'slot') STORED,
  status         text    GENERATED ALWAYS AS (data->>'status') STORED,
  payment_status text    GENERATED ALWAYS AS (data->>'paymentStatus') STORED,
  payment_ref    text    GENERATED ALWAYS AS (NULLIF(data->>'paymentRef', '')) STORED,
  total_payable  numeric GENERATED ALWAYS AS (cos_num(data->>'totalPayable')) STORED,
  PRIMARY KEY (tenant, id),
  FOREIGN KEY (tenant, unit) REFERENCES units (tenant, unit)
);
CREATE INDEX IF NOT EXISTS bookings_short ON bookings (tenant, short_id) WHERE short_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_slot ON bookings (tenant, amenity, booking_date);
CREATE INDEX IF NOT EXISTS bookings_unit ON bookings (tenant, unit, booking_date DESC);
CREATE INDEX IF NOT EXISTS bookings_ref ON bookings (tenant, payment_ref) WHERE payment_ref IS NOT NULL;

-- ---- tickets (no foreign key on unit: a ticket may be about a common area, a gate, "Clubhouse"...) --------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  tenant     text   NOT NULL,
  id         text   NOT NULL,
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  data       jsonb  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  short_id   text GENERATED ALWAYS AS (NULLIF(data->>'shortId', '')) STORED,                       -- the number people quote (TKT-1058)
  unit        text GENERATED ALWAYS AS (NULLIF(data->>'unit', '')) STORED,
  status      text GENERATED ALWAYS AS (data->>'status') STORED,
  scope       text GENERATED ALWAYS AS (data->>'scope') STORED,
  task_type   text GENERATED ALWAYS AS (data->>'taskType') STORED,
  category    text GENERATED ALWAYS AS (data->>'category') STORED,
  priority    text GENERATED ALWAYS AS (data->>'priority') STORED,
  assigned_to text GENERATED ALWAYS AS (NULLIF(data->>'assignedTo', '')) STORED,
  opened_at   timestamptz GENERATED ALWAYS AS (cos_ts(data->>'createdAt')) STORED,
  sla_due_at  timestamptz GENERATED ALWAYS AS (cos_ts(data->>'slaDueAt')) STORED,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS tickets_short ON tickets (tenant, short_id) WHERE short_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_unit ON tickets (tenant, unit, status);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets (tenant, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS tickets_type ON tickets (tenant, task_type);
CREATE INDEX IF NOT EXISTS tickets_assignee ON tickets (tenant, assigned_to) WHERE assigned_to IS NOT NULL;

-- ---- ledger_entries (collection: ledger; unit is optional and free: association-level entries have none) --------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  tenant     text   NOT NULL,
  id         text   NOT NULL,
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  data       jsonb  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  short_id   text GENERATED ALWAYS AS (NULLIF(data->>'shortId', '')) STORED,                       -- the number people quote (TKT-1058)
  entry_type   text    GENERATED ALWAYS AS (data->>'type') STORED,
  amount       numeric GENERATED ALWAYS AS (cos_num(data->>'amount')) STORED,
  entry_date   date    GENERATED ALWAYS AS (cos_date(data->>'date')) STORED,
  account      text    GENERATED ALWAYS AS (data->>'account') STORED,
  category     text    GENERATED ALWAYS AS (data->>'category') STORED,
  unit         text    GENERATED ALWAYS AS (NULLIF(data->>'unit', '')) STORED,
  recon_status text    GENERATED ALWAYS AS (data->>'reconStatus') STORED,
  source_type  text    GENERATED ALWAYS AS (NULLIF(data->>'sourceType', '')) STORED,
  source_id    text    GENERATED ALWAYS AS (NULLIF(data->>'sourceId', '')) STORED,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS ledger_entries_short ON ledger_entries (tenant, short_id) WHERE short_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_date ON ledger_entries (tenant, entry_date DESC);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger_entries (tenant, account, entry_date DESC);
CREATE INDEX IF NOT EXISTS ledger_unit ON ledger_entries (tenant, unit) WHERE unit IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_source ON ledger_entries (tenant, source_type, source_id) WHERE source_id IS NOT NULL;

-- ---- audit_log: append-only, partitioned by month ----------------------------------------------------------------------------------------
-- (a partition key cannot be a generated column, so these are plain columns filled by the repository from the same record)
CREATE SEQUENCE IF NOT EXISTS audit_log_seq;
CREATE TABLE IF NOT EXISTS audit_log (
  tenant          text        NOT NULL,
  id              text        NOT NULL,
  at              timestamptz NOT NULL,
  seq             bigint      NOT NULL DEFAULT nextval('audit_log_seq'),
  short_id        text,
  who             text,
  who_name        text,
  action          text,
  collection      text,
  record_id       text,
  record_short_id text,
  unit            text,
  summary         text,
  ip              text,
  request_id      text,
  data            jsonb       NOT NULL,
  PRIMARY KEY (tenant, at, id)
) PARTITION BY RANGE (at);
CREATE TABLE IF NOT EXISTS audit_log_default PARTITION OF audit_log DEFAULT;      -- anything outside the monthly partitions still lands somewhere
CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log (tenant, at DESC, id);
CREATE INDEX IF NOT EXISTS audit_log_record ON audit_log (tenant, record_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_unit ON audit_log (tenant, unit, at DESC) WHERE unit IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_coll ON audit_log (tenant, collection, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_id ON audit_log (tenant, id);

-- Creates the monthly partitions from `from_month` to `to_month` (inclusive). The server calls it at start and daily (so next month always exists).
CREATE OR REPLACE FUNCTION cos_audit_partitions(from_month date, to_month date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE m date := date_trunc('month', from_month)::date; made integer := 0; nm date;
BEGIN
  WHILE m <= date_trunc('month', to_month)::date LOOP
    nm := (m + interval '1 month')::date;
    IF to_regclass(format('audit_log_%s', to_char(m, 'YYYY_MM'))) IS NULL THEN
      BEGIN
        EXECUTE format('CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)', 'audit_log_' || to_char(m, 'YYYY_MM'), m, nm);
        made := made + 1;
      EXCEPTION WHEN others THEN NULL;   -- rows for that month already sit in the default partition: leave it (run cos_audit_split_default to move them)
      END;
    END IF;
    m := nm;
  END LOOP;
  RETURN made;
END $$;

-- Short ids (TKT-1058, DUE-0007 ...) come from a counter row per community and collection instead of reading the whole collection.
CREATE TABLE IF NOT EXISTS short_id_counters (
  tenant     text   NOT NULL,
  collection text   NOT NULL,
  last       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, collection)
);

-- ---- one-time move of existing rows out of `documents` (safe to run again: nothing is left to move) ----------------------------------------------
DO $$
DECLARE lo date; hi date;
BEGIN
  SELECT min(cos_date(data->>'when')), max(cos_date(data->>'when')) INTO lo, hi FROM documents WHERE collection = 'audit';
  PERFORM cos_audit_partitions(LEAST(COALESCE(lo, current_date), current_date), GREATEST(COALESCE(hi, current_date), current_date) + 62);
END $$;

INSERT INTO units (tenant, id, data, created_at, updated_at)
  SELECT tenant, id, data, updated_at, updated_at FROM documents WHERE collection = 'properties' ON CONFLICT DO NOTHING;
INSERT INTO users (tenant, id, data, created_at, updated_at)
  SELECT tenant, id, data, updated_at, updated_at FROM documents WHERE collection = 'users' ON CONFLICT DO NOTHING;
INSERT INTO dues (tenant, id, data, created_at, updated_at)
  SELECT tenant, id, data, updated_at, updated_at FROM documents WHERE collection = 'dues' ORDER BY seq ON CONFLICT DO NOTHING;
INSERT INTO bookings (tenant, id, data, created_at, updated_at)
  SELECT tenant, id, data, updated_at, updated_at FROM documents WHERE collection = 'amenities' ORDER BY seq ON CONFLICT DO NOTHING;
INSERT INTO tickets (tenant, id, data, created_at, updated_at)
  SELECT tenant, id, data, updated_at, updated_at FROM documents WHERE collection = 'tickets' ORDER BY seq ON CONFLICT DO NOTHING;
INSERT INTO ledger_entries (tenant, id, data, created_at, updated_at)
  SELECT tenant, id, data, updated_at, updated_at FROM documents WHERE collection = 'ledger' ORDER BY seq ON CONFLICT DO NOTHING;
INSERT INTO audit_log (tenant, id, at, short_id, who, who_name, action, collection, record_id, record_short_id, unit, summary, ip, request_id, data)
  SELECT tenant, id, COALESCE(cos_ts(data->>'when'), updated_at), data->>'shortId', data->>'who', data->>'whoName', data->>'action', data->>'collection',
         data->>'recordId', data->>'recordShortId', NULLIF(data->>'unit', ''), left(data->>'summary', 2000), data->>'ip', data->>'requestId', data
  FROM documents WHERE collection = 'audit' ORDER BY seq ON CONFLICT DO NOTHING;
DELETE FROM documents WHERE collection IN ('properties', 'users', 'dues', 'amenities', 'tickets', 'ledger', 'audit');

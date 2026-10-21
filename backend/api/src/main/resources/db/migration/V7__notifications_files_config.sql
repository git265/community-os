-- =====================================================================================================================================
-- V7 the in-app bell and what each community configures in Studio (stored files are in V5, as other tables point at them)
-- =====================================================================================================================================

-- ---- in-app notifications: the busiest table (an announcement to 1 000 units = 1 000 rows), partitioned by month, read by addressee -----------
CREATE TABLE IF NOT EXISTS comms.notification (
  community_id   uuid        NOT NULL REFERENCES platform.community (id),
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  to_membership_id uuid,                                  -- exactly one addressee kind
  to_unit_id     uuid,
  to_role_id     uuid,
  event          text        NOT NULL,                   -- bill, ticket.assigned, gate.approval ...
  title          text        NOT NULL CHECK (length(title) <= 200),
  body           text        NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
  link           text        CHECK (link IS NULL OR link ~ '^#/'),   -- in-app only: never a URL out of the app
  sender_id      uuid,                                   -- the membership that caused it (NULL = system)
  read_at        timestamptz,
  version        bigint      NOT NULL DEFAULT 1,
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  PRIMARY KEY (community_id, created_at, id),
  CHECK (num_nonnulls(to_membership_id, to_unit_id, to_role_id) = 1)
) PARTITION BY RANGE (created_at);
CREATE TABLE IF NOT EXISTS comms.notification_default PARTITION OF comms.notification DEFAULT;
CREATE INDEX IF NOT EXISTS notification_member ON comms.notification (community_id, to_membership_id, created_at DESC) WHERE to_membership_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_unit   ON comms.notification (community_id, to_unit_id, created_at DESC) WHERE to_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_role   ON comms.notification (community_id, to_role_id, created_at DESC) WHERE to_role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_unread ON comms.notification (community_id, to_membership_id) WHERE read_at IS NULL;

-- ---- Studio: per-community field definitions (labels, options, who may see / edit) and custom attributes -----------------------------------
CREATE TABLE IF NOT EXISTS config.field_definition (
  community_id  uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  entity        text        NOT NULL,                     -- maintenance.ticket ...
  field_key     text        NOT NULL CHECK (field_key ~ '^[a-z][a-zA-Z0-9]{0,62}$'),
  label         text        NOT NULL,
  data_type     text        NOT NULL CHECK (data_type IN ('text', 'textarea', 'richtext', 'number', 'money', 'boolean', 'date', 'time', 'select', 'multiselect', 'phone', 'email', 'files', 'lookup')),
  is_custom     boolean     NOT NULL DEFAULT false,       -- true: stored in the row's `custom` jsonb; false: a real column
  required      boolean     NOT NULL DEFAULT false,
  options       text[],
  lookup_entity text,
  view_roles    uuid[]      NOT NULL DEFAULT '{}',        -- empty = everyone who can open the record
  edit_roles    uuid[]      NOT NULL DEFAULT '{}',
  sort_order    integer     NOT NULL DEFAULT 0,
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, entity, field_key),
  CHECK (data_type NOT IN ('select', 'multiselect') OR cardinality(options) > 0)
);

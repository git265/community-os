-- =====================================================================================================================================
-- V2 identity: people, their memberships of communities, roles and permissions, sign-in (one-time codes, rotating refresh tokens)
--
-- A PERSON is global (one phone number = one person, who may belong to several communities). A MEMBERSHIP is that person in one
-- community, with roles. The access token names the person, the membership and the community; everything after sign-in is tenant-scoped.
-- Sign-in tables (otp_challenge, refresh_token, auth_attempt) are reached only by the auth service's platform connection, never by cos_app.
-- =====================================================================================================================================

CREATE TABLE IF NOT EXISTS identity.person (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164    text        UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email         citext      UNIQUE CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name     text        NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  auth_subject  text        UNIQUE,                                    -- the identity provider's `sub` when an OIDC provider is used
  status        text        NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Locked', 'Deleted')),
  preferred_language text,
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL OR auth_subject IS NOT NULL)
);

-- the permission catalogue is code-defined and global (MANAGE_DUES, VIEW_AUDIT_LOG ...)
CREATE TABLE IF NOT EXISTS identity.permission (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z_]{2,63}$'),
  label       text NOT NULL,
  description text
);

CREATE TABLE IF NOT EXISTS identity.role_group (
  community_id uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  category     text        NOT NULL CHECK (category IN ('EC', 'Staff', 'Resident', 'Vendor')),   -- the access level the members get
  description  text,
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, name)
);
CREATE TABLE IF NOT EXISTS identity.role_group_permission (
  community_id uuid NOT NULL,
  group_id     uuid NOT NULL,
  permission   text NOT NULL REFERENCES identity.permission (code),
  PRIMARY KEY (community_id, group_id, permission),
  FOREIGN KEY (community_id, group_id) REFERENCES identity.role_group (community_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS identity.role (
  community_id uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  code         text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$'),   -- treasurer, handyman_plumbing ... (stable, used in rules)
  name         text        NOT NULL,
  group_id     uuid        NOT NULL,
  built_in     boolean     NOT NULL DEFAULT false,
  trade        text,                                                          -- field staff: the queue they work (Plumbing, Electrical ...)
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, code),
  FOREIGN KEY (community_id, group_id) REFERENCES identity.role_group (community_id, id)
);
-- a role = its group's permissions + grants - revokes
CREATE TABLE IF NOT EXISTS identity.role_permission_override (
  community_id uuid NOT NULL,
  role_id      uuid NOT NULL,
  permission   text NOT NULL REFERENCES identity.permission (code),
  effect       text NOT NULL CHECK (effect IN ('grant', 'revoke')),
  PRIMARY KEY (community_id, role_id, permission),
  FOREIGN KEY (community_id, role_id) REFERENCES identity.role (community_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS identity.membership (
  community_id uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  person_id    uuid        NOT NULL REFERENCES identity.person (id),
  display_name text        NOT NULL,
  status       text        NOT NULL DEFAULT 'Active' CHECK (status IN ('Invited', 'Active', 'Inactive')),
  joined_on    date,
  left_on      date,
  version      bigint      NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, person_id),
  CHECK (left_on IS NULL OR joined_on IS NULL OR left_on >= joined_on)
);
CREATE INDEX IF NOT EXISTS membership_person ON identity.membership (person_id);
CREATE TABLE IF NOT EXISTS identity.membership_role (
  community_id  uuid    NOT NULL,
  membership_id uuid    NOT NULL,
  role_id       uuid    NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (community_id, membership_id, role_id),
  FOREIGN KEY (community_id, membership_id) REFERENCES identity.membership (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, role_id) REFERENCES identity.role (community_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_one_primary_role ON identity.membership_role (community_id, membership_id) WHERE is_primary;

-- the extra details a person keeps up to date themselves (was userProfiles)
CREATE TABLE IF NOT EXISTS identity.member_profile (
  community_id    uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  membership_id   uuid        NOT NULL,
  alt_phone       text,
  emergency_name  text,
  emergency_phone text,
  vehicles        text[]      NOT NULL DEFAULT '{}',
  language        text,
  custom          jsonb       NOT NULL DEFAULT '{}',
  version         bigint      NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, membership_id),
  FOREIGN KEY (community_id, membership_id) REFERENCES identity.membership (community_id, id) ON DELETE CASCADE
);

-- ---- sign-in ----------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.otp_challenge (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164   text        NOT NULL,
  purpose      text        NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'evote', 'step-up')),
  code_hash    bytea       NOT NULL,                 -- HMAC-SHA256(server pepper, challenge id + code); the code itself is never stored
  attempts     smallint    NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts smallint    NOT NULL DEFAULT 3,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS otp_by_phone ON identity.otp_challenge (phone_e164, created_at DESC);
CREATE INDEX IF NOT EXISTS otp_expired ON identity.otp_challenge (expires_at);

-- Refresh tokens rotate on every use. A family is one sign-in; presenting an already-used token revokes the whole family (theft detection).
CREATE TABLE IF NOT EXISTS identity.refresh_token (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid        NOT NULL,
  person_id     uuid        NOT NULL REFERENCES identity.person (id),
  community_id  uuid        NOT NULL REFERENCES platform.community (id),
  membership_id uuid        NOT NULL,
  token_hash    bytea       NOT NULL UNIQUE,         -- SHA-256 of the opaque token; the token itself is only ever in the client's cookie
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  revoked_at    timestamptz,
  revoke_reason text,
  user_agent    text,
  ip            inet,
  FOREIGN KEY (community_id, membership_id) REFERENCES identity.membership (community_id, id) ON DELETE CASCADE,
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS refresh_family ON identity.refresh_token (family_id);
CREATE INDEX IF NOT EXISTS refresh_person_active ON identity.refresh_token (person_id) WHERE revoked_at IS NULL;

-- sign-in throttling that holds across API instances (per phone, per IP)
CREATE TABLE IF NOT EXISTS identity.auth_attempt (
  id     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    text        NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_attempt_key ON identity.auth_attempt (key, at DESC);

-- sign-in links sent to registered numbers (was portalInvites)
CREATE TABLE IF NOT EXISTS identity.portal_invite (
  community_id  uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id      text,
  membership_id uuid        NOT NULL,
  token_hash    bytea       NOT NULL UNIQUE,
  channel       text        NOT NULL CHECK (channel IN ('SMS', 'WhatsApp', 'Email')),
  sent_to       text        NOT NULL,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  FOREIGN KEY (community_id, membership_id) REFERENCES identity.membership (community_id, id) ON DELETE CASCADE
);

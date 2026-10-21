-- =====================================================================================================================================
-- Identity and access: people, sign-in accounts, roles, permissions, field policies, tokens
--
-- A PERSON is somebody the community knows (owner, tenant, staff, vendor contact). A USER ACCOUNT is a person who may sign in.
-- Authorisation = role permissions (what) x role scope (which units / blocks) x field policies (which fields), all data, all per community.
-- =====================================================================================================================================

CREATE TABLE people (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  full_name     text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
  phone_e164    text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),         -- one format, so "98450 71234" and "+91-98450-71234" are the same person
  email         citext CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  alt_phone_e164 text CHECK (alt_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  emergency_name text,
  emergency_phone_e164 text CHECK (emergency_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  preferred_language text,
  custom        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id)
);
CREATE UNIQUE INDEX people_phone ON people (community_id, phone_e164) WHERE phone_e164 IS NOT NULL;   -- one number = one person
CREATE INDEX people_email ON people (community_id, email) WHERE email IS NOT NULL;
CREATE INDEX people_name_trgm ON people USING gin (full_name gin_trgm_ops);
SELECT use_row_stamps('people');

-- ---- permissions are platform-defined (the code checks them by name); roles are per community -----------------------------------
CREATE TABLE permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z_]{2,63}$'),
  label       text NOT NULL,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  code          text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$'),     -- 'treasurer', 'handyman_plumbing'
  name          text NOT NULL,
  category      text NOT NULL CHECK (category IN ('EC', 'Staff', 'Resident', 'Vendor')),   -- the access level: what data members can see
  trade         text,                                                       -- field-staff roles work one trade's queue ('Plumbing')
  is_system     boolean NOT NULL DEFAULT false,                             -- Super Admin and the built-in roles cannot be deleted
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, code)
);
SELECT use_row_stamps('roles');

CREATE TABLE role_permissions (
  community_id  uuid NOT NULL,
  role_id       uuid NOT NULL,
  permission    text NOT NULL REFERENCES permissions (code),
  PRIMARY KEY (community_id, role_id, permission),
  FOREIGN KEY (community_id, role_id) REFERENCES roles (community_id, id) ON DELETE CASCADE
);

CREATE TABLE user_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   uuid NOT NULL REFERENCES communities (id),
  person_id      uuid NOT NULL,
  login_phone    text CHECK (login_phone ~ '^\+[1-9][0-9]{6,14}$'),
  login_email    citext,
  password_hash  text,                                                      -- argon2id / bcrypt; NULL = one-time codes or SSO only
  auth_subject   text,                                                      -- the identity provider's `sub` (OIDC)
  status         text NOT NULL DEFAULT 'Active' CHECK (status IN ('Invited', 'Active', 'Locked', 'Inactive')),
  failed_logins  smallint NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until   timestamptz,
  last_login_at  timestamptz,
  mfa_secret_enc bytea,                                                     -- TOTP secret, encrypted with the field key
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, person_id),
  FOREIGN KEY (community_id, person_id) REFERENCES people (community_id, id),
  CHECK (login_phone IS NOT NULL OR login_email IS NOT NULL OR auth_subject IS NOT NULL)
);
CREATE UNIQUE INDEX user_accounts_phone ON user_accounts (community_id, login_phone) WHERE login_phone IS NOT NULL;
CREATE UNIQUE INDEX user_accounts_email ON user_accounts (community_id, login_email) WHERE login_email IS NOT NULL;
CREATE UNIQUE INDEX user_accounts_subject ON user_accounts (community_id, auth_subject) WHERE auth_subject IS NOT NULL;
SELECT use_row_stamps('user_accounts');

-- A user holds roles; a role grant can be limited to some units (an owner of two villas) or blocks (a Block Secretary).
CREATE TABLE user_roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  role_id       uuid NOT NULL,
  valid_from    date NOT NULL DEFAULT current_date,
  valid_to      date,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, user_id, role_id),
  FOREIGN KEY (community_id, user_id) REFERENCES user_accounts (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, role_id) REFERENCES roles (community_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX user_roles_user ON user_roles (community_id, user_id);
SELECT use_row_stamps('user_roles');

-- ---- field policies: who may SEE and who may EDIT each field of each resource (what Studio edits) --------------------------------
CREATE TABLE field_policies (
  community_id  uuid NOT NULL REFERENCES communities (id),
  resource      text NOT NULL,                 -- 'bills', 'tickets' ...
  field         text NOT NULL,                 -- the API field name
  view_roles    text[] NOT NULL DEFAULT '{}',  -- role codes; '*' = everyone signed in
  edit_roles    text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, resource, field)
);
SELECT use_row_stamps('field_policies');

-- ---- the community's own fields: validated by the application, stored in each table's `custom` column ----------------------------
CREATE TABLE custom_field_defs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  resource      text NOT NULL,
  field_key     text NOT NULL CHECK (field_key ~ '^[a-z][A-Za-z0-9]{1,62}$'),
  label         text NOT NULL,
  data_type     text NOT NULL CHECK (data_type IN ('text', 'number', 'boolean', 'date', 'time', 'select', 'tags', 'phone', 'email')),
  required      boolean NOT NULL DEFAULT false,
  options       text[],
  max_length    integer CHECK (max_length BETWEEN 1 AND 10000),
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, resource, field_key)
);
SELECT use_row_stamps('custom_field_defs');

-- ---- sign-in: one-time codes, refresh-token families (rotation + reuse detection), attempts for rate limits --------------------
CREATE TABLE login_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  channel       text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  destination   text NOT NULL,
  code_hash     bytea NOT NULL,                       -- HMAC-SHA256 of the code with a server key: never the code itself
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ip            inet
);
CREATE INDEX login_challenges_lookup ON login_challenges (community_id, destination, created_at DESC);

CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  family_id     uuid NOT NULL,                        -- one sign-in = one family; reuse of a rotated token revokes the whole family
  token_hash    bytea NOT NULL UNIQUE,                -- SHA-256 of the opaque token
  acting_role_id uuid,                                -- the role the session acts as (a person with several roles picks one)
  acting_unit_id uuid,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  revoked_at    timestamptz,
  revoked_reason text,
  ip            inet,
  user_agent    text,
  FOREIGN KEY (community_id, user_id) REFERENCES user_accounts (community_id, id) ON DELETE CASCADE,
  CHECK (expires_at > issued_at)
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user ON refresh_tokens (community_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket        text NOT NULL,                        -- 'login:phone:+9198...', 'login:ip:10.0.0.1'
  succeeded     boolean NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_bucket ON auth_attempts (bucket, at DESC);

-- signing keys for access tokens (rotation: the JWKS endpoint publishes every key not yet retired)
CREATE TABLE signing_keys (
  kid           text PRIMARY KEY,
  algorithm     text NOT NULL DEFAULT 'RS256' CHECK (algorithm IN ('RS256', 'ES256', 'EdDSA')),
  public_jwk    jsonb NOT NULL,
  private_key_ref text NOT NULL,                      -- a secret-manager reference (KMS / Vault), never the key material itself
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  retired_at    timestamptz
);

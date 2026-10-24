-- =====================================================================================================================================
-- V44 site devices: one generic layer for every entry device (face / QR / PIN terminals now, ANPR and FASTag later).
--   * bridge          a site bridge (the CommunityOS agent at the gate); it signs in with a token whose hash only is kept
--   * device          each terminal or camera: where it stands, which way it counts, what it can do, how the bridge reaches it
--   * device_key      the community's key for device passwords (made by the database, read only by the API)
--   * face_profile    consent (and, for staff, the face photo) for being put on the devices
--   * device_enrolment who is on which device, as the server wants it and as the device confirmed it
--   * device_task     the bridge's work queue (enrol, remove, open the door, set the clock), claimed with a lease
--   * device_event    the ledger: every punch once (device + its own event number), and what the platform made of it
-- =====================================================================================================================================
CREATE TABLE IF NOT EXISTS gate.bridge (
  community_id  uuid        NOT NULL REFERENCES platform.community (id),
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id      text,
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  token_hash    text        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint    text,
  status        text        NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Revoked')),
  last_seen_at  timestamptz,
  agent_version text,
  custom        jsonb       NOT NULL DEFAULT '{}',
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS bridge_token ON gate.bridge (token_hash);

CREATE TABLE IF NOT EXISTS gate.device (
  community_id  uuid        NOT NULL REFERENCES platform.community (id),
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id      text,
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  gate          text        NOT NULL DEFAULT 'Main gate',
  kind          text        NOT NULL CHECK (kind IN ('Face terminal', 'QR reader', 'ANPR camera', 'FASTag reader', 'Barrier', 'Phone kiosk')),
  make          text,
  model         text,
  driver        text        NOT NULL CHECK (driver IN ('hikvision-isapi', 'app-kiosk')),
  direction     text        NOT NULL DEFAULT 'In' CHECK (direction IN ('In', 'Out', 'Both')),
  capabilities  text[]      NOT NULL DEFAULT '{}' CHECK (capabilities <@ ARRAY['Face', 'Card', 'QR', 'PIN', 'Fingerprint', 'Plate', 'Tag', 'Relay']),
  bridge_id     uuid,
  host          text        CHECK (host IS NULL OR host ~ '^[A-Za-z0-9.:\-\[\]]{1,100}$'),
  port          integer     CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  use_tls       boolean     NOT NULL DEFAULT false,
  username      text        CHECK (username IS NULL OR length(username) <= 64),
  secret_enc    text          CHECK (secret_enc IS NULL OR length(secret_enc) <= 400),
  door_no       integer     NOT NULL DEFAULT 1 CHECK (door_no BETWEEN 1 AND 8),
  capacity      integer     CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 1000000),
  status        text        NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Paused')),
  serial        text,
  firmware      text,
  online        boolean     NOT NULL DEFAULT false,
  last_seen_at  timestamptz,
  clock_drift_s integer,
  enrolled_count integer,
  last_error    text,
  last_event_no bigint      NOT NULL DEFAULT 0 CHECK (last_event_no >= 0),
  custom        jsonb       NOT NULL DEFAULT '{}',
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  FOREIGN KEY (community_id, bridge_id) REFERENCES gate.bridge (community_id, id),
  CHECK (driver <> 'hikvision-isapi' OR (bridge_id IS NOT NULL AND host IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS gate.device_key (
  community_id uuid        NOT NULL PRIMARY KEY REFERENCES platform.community (id) ON DELETE CASCADE,
  secret       bytea       NOT NULL DEFAULT gen_random_bytes(32) CHECK (length(secret) = 32),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gate.face_profile (
  community_id  uuid        NOT NULL REFERENCES platform.community (id),
  subject_kind  text        NOT NULL CHECK (subject_kind IN ('person', 'member')),
  subject_id    uuid        NOT NULL,
  photo         text        CHECK (photo IS NULL OR length(photo) <= 400000),
  card_no       text        CHECK (card_no IS NULL OR card_no ~ '^[0-9]{4,20}$'),
  consent_at    timestamptz,
  consent_by    uuid,
  consent_text  text        CHECK (consent_text IS NULL OR length(consent_text) <= 2000),
  withdrawn_at  timestamptz,
  left_at       timestamptz,
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, subject_kind, subject_id),
  CHECK (consent_at IS NOT NULL OR photo IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS face_profile_card ON gate.face_profile (community_id, card_no) WHERE card_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS gate.device_enrolment (
  community_id  uuid        NOT NULL,
  device_id     uuid        NOT NULL,
  employee_no   text        NOT NULL CHECK (employee_no ~ '^[0-9a-f]{32}$'),
  subject_kind  text        NOT NULL CHECK (subject_kind IN ('person', 'member')),
  subject_id    uuid        NOT NULL,
  name          text        NOT NULL,
  valid_from    date,
  valid_to      date,
  face_hash     text,
  card_no       text,
  state         text        NOT NULL CHECK (state IN ('Pending enrol', 'Enrolled', 'Pending removal', 'Removed', 'Failed')),
  last_error    text,
  synced_at     timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, device_id, employee_no),
  FOREIGN KEY (community_id, device_id) REFERENCES gate.device (community_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_enrolment_subject ON gate.device_enrolment (community_id, subject_id);

CREATE TABLE IF NOT EXISTS gate.device_task (
  community_id  uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  bridge_id     uuid        NOT NULL,
  device_id     uuid        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('enrol', 'remove', 'open', 'set-time', 'catch-up')),
  employee_no   text,
  note          text,
  state         text        NOT NULL DEFAULT 'Queued' CHECK (state IN ('Queued', 'Sent', 'Done', 'Failed')),
  attempts      integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text,
  lease_until   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz,
  PRIMARY KEY (community_id, id),
  FOREIGN KEY (community_id, bridge_id) REFERENCES gate.bridge (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, device_id) REFERENCES gate.device (community_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_task_queue ON gate.device_task (community_id, bridge_id, created_at) WHERE state IN ('Queued', 'Sent');
CREATE UNIQUE INDEX IF NOT EXISTS device_task_one_open ON gate.device_task (community_id, device_id, kind, coalesce(employee_no, '')) WHERE state IN ('Queued', 'Sent') AND kind IN ('enrol', 'remove', 'set-time', 'catch-up');

CREATE TABLE IF NOT EXISTS gate.device_event (
  community_id  uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  device_id     uuid        NOT NULL,
  event_no      bigint      NOT NULL CHECK (event_no >= 0),
  at            timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  credential    text        NOT NULL CHECK (credential IN ('Face', 'Card', 'QR', 'PIN', 'Fingerprint', 'Plate', 'Tag', 'App', 'Other')),
  employee_no   text,
  card_no       text,
  subject_kind  text        CHECK (subject_kind IS NULL OR subject_kind IN ('person', 'member')),
  subject_id    uuid,
  name          text,
  direction     text        CHECK (direction IS NULL OR direction IN ('In', 'Out')),
  result        text        NOT NULL CHECK (result IN ('Allowed', 'Refused')),
  reason        text,
  photo         text        CHECK (photo IS NULL OR length(photo) <= 400000),
  outcome       text,
  counted       boolean     NOT NULL DEFAULT false,
  visit_id      uuid,
  session_id    uuid,
  raw           jsonb,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, device_id, event_no),
  FOREIGN KEY (community_id, device_id) REFERENCES gate.device (community_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_event_recent ON gate.device_event (community_id, at DESC);
CREATE INDEX IF NOT EXISTS device_event_subject ON gate.device_event (community_id, subject_id, at DESC) WHERE subject_id IS NOT NULL;

-- attendance a device recorded; the flag for a device entry the rules would have held
ALTER TABLE workforce.attendance_session DROP CONSTRAINT IF EXISTS attendance_source,
  ADD CONSTRAINT attendance_source CHECK (source IN ('Self', 'Supervisor', 'Auto-closed', 'Device'));
ALTER TABLE gate.flag DROP CONSTRAINT IF EXISTS flag_type,
  ADD CONSTRAINT flag_type CHECK (type IN ('Unrecorded entry', 'Tailgate', 'Override entry', 'Identity mismatch', 'Wrong destination', 'Overstay', 'Blocked person attempt',
                                           'Guard silence', 'Headcount mismatch', 'Manual open', 'Missed patrol', 'Reported person', 'Patrol location', 'Device entry'));

DROP TRIGGER IF EXISTS short_id ON gate.bridge;
CREATE TRIGGER short_id BEFORE INSERT ON gate.bridge FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('GBR', '0', '4');
DROP TRIGGER IF EXISTS short_id ON gate.device;
CREATE TRIGGER short_id BEFORE INSERT ON gate.device FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('GDV', '0', '4');

SELECT platform.apply_security();

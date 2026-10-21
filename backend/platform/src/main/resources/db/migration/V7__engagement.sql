-- =====================================================================================================================================
-- Files, in-app notifications (partitioned, high volume), delivery channels and preferences
-- =====================================================================================================================================

-- File METADATA; the bytes live in object storage (S3 / Azure / disk) under storage_key. A file belongs to exactly one record.
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  owner_type    text NOT NULL CHECK (owner_type IN ('Ticket', 'TicketInternal', 'TicketDocument', 'Bill', 'Payment', 'Booking', 'Document', 'Meeting', 'Audit', 'Vendor', 'Event', 'Reading', 'Expense', 'Inventory', 'Other')),
  owner_id      uuid,                                       -- NULL while uploading (before the owner record is saved)
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime_type     text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain', 'text/csv',
                  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/rtf')),
  size_bytes    bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  sha256        bytea NOT NULL CHECK (length(sha256) = 32),
  storage_key   text NOT NULL UNIQUE,
  scan_status   text NOT NULL DEFAULT 'Pending' CHECK (scan_status IN ('Pending', 'Clean', 'Infected', 'Error')),
  uploaded_by   uuid NOT NULL DEFAULT app_user(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id)
);
CREATE INDEX files_owner ON files (community_id, owner_type, owner_id);
CREATE INDEX files_orphans ON files (created_at) WHERE owner_id IS NULL;      -- cleaned up by a job after 24 h
SELECT use_row_stamps('files');

-- In-app notifications: the busiest table (one row per recipient per message). Partitioned by month; old months are dropped.
CREATE TABLE notifications (
  community_id      uuid        NOT NULL,
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  recipient_user_id uuid,                                   -- exactly one recipient kind
  recipient_unit_id uuid,
  recipient_role_id uuid,
  event_type        text        NOT NULL,
  title             text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body              text        NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
  link              text        CHECK (link ~ '^/[A-Za-z0-9/_?=&.-]*$'),     -- an in-app route only, never an external URL
  sender_user_id    uuid,                                   -- the caller (or NULL for the system)
  read_at           timestamptz,
  PRIMARY KEY (community_id, created_at, id),
  CHECK (num_nonnulls(recipient_user_id, recipient_unit_id, recipient_role_id) = 1)
) PARTITION BY RANGE (created_at);
CREATE TABLE notifications_default PARTITION OF notifications DEFAULT;
CREATE INDEX notifications_user ON notifications (community_id, recipient_user_id, created_at DESC) WHERE recipient_user_id IS NOT NULL;
CREATE INDEX notifications_unit ON notifications (community_id, recipient_unit_id, created_at DESC) WHERE recipient_unit_id IS NOT NULL;
CREATE INDEX notifications_role ON notifications (community_id, recipient_role_id, created_at DESC) WHERE recipient_role_id IS NOT NULL;
SELECT ensure_month_partitions('notifications', (current_date - interval '3 months')::date, (current_date + interval '3 months')::date);
-- a recipient may only mark it read; the content never changes
CREATE OR REPLACE FUNCTION guard_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.title, NEW.body, NEW.link, NEW.event_type, NEW.recipient_user_id, NEW.recipient_unit_id, NEW.recipient_role_id, NEW.sender_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.title, OLD.body, OLD.link, OLD.event_type, OLD.recipient_user_id, OLD.recipient_unit_id, OLD.recipient_role_id, OLD.sender_user_id, OLD.created_at)
  THEN RAISE EXCEPTION 'a notification can only be marked read' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_guard BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION guard_notification();
CREATE OR REPLACE FUNCTION notification_sender() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.sender_user_id := app_user(); NEW.created_at := now(); RETURN NEW; END $$;
CREATE TRIGGER notifications_sender BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notification_sender();

-- per person: which extra channels they want for which kind of message
CREATE TABLE notification_preferences (
  community_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  event_type    text NOT NULL,                              -- '*' = default for every kind
  sms           boolean NOT NULL DEFAULT false,
  whatsapp      boolean NOT NULL DEFAULT false,
  email         boolean NOT NULL DEFAULT false,
  push          boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, user_id, event_type),
  FOREIGN KEY (community_id, user_id) REFERENCES user_accounts (community_id, id) ON DELETE CASCADE
);
SELECT use_row_stamps('notification_preferences');

-- every message handed to an outside channel (SMS / WhatsApp / e-mail / push), with retries and the provider's answer
CREATE TABLE message_deliveries (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  community_id    uuid NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email', 'push')),
  destination     text NOT NULL,
  template_code   text NOT NULL,
  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status          text NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Sending', 'Sent', 'Delivered', 'Failed', 'Dead')),
  attempts        smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_ref    text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, id)
);
CREATE INDEX message_deliveries_due ON message_deliveries (next_attempt_at) WHERE status IN ('Queued', 'Failed');

-- outgoing webhooks for integrations (accounting, CRM, MyGate ...): signed with the subscription's secret
CREATE TABLE webhook_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  url           text NOT NULL CHECK (url ~ '^https://'),
  event_types   text[] NOT NULL CHECK (cardinality(event_types) > 0),
  secret_ref    text NOT NULL,                              -- secret-manager reference for the HMAC key
  active        boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id)
);
SELECT use_row_stamps('webhook_subscriptions');

-- =====================================================================================================================================
-- V25 push: notifications reach a person at once, in the open app (a live stream) and on their phone or computer when it is closed (Web Push).
--   * a push subscription is one browser / device of one member: the push service's endpoint and the keys its messages are encrypted with
--   * every in-app notification to a member is queued for each of their subscriptions in the same statement that writes it (JdbcInbox),
--     then sent by the push job; a subscription the push service says is gone is removed
-- =====================================================================================================================================

CREATE TABLE IF NOT EXISTS comms.push_subscription (
  community_id  uuid        NOT NULL REFERENCES platform.community (id),
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid        NOT NULL,
  endpoint      text        NOT NULL CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh        text        NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),            -- the browser's public key (65 bytes, base64url)
  auth          text        NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{16,32}$'),               -- its 16-byte secret (base64url)
  user_agent    text        CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  last_sent_at  timestamptz,
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, endpoint),
  FOREIGN KEY (community_id, membership_id) REFERENCES identity.membership (community_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS push_subscription_member ON comms.push_subscription (community_id, membership_id);

CREATE TABLE IF NOT EXISTS comms.push_queue (
  community_id    uuid        NOT NULL REFERENCES platform.community (id),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  subscription_id uuid        NOT NULL,
  notification_id uuid        NOT NULL,
  title           text        NOT NULL CHECK (length(title) <= 200),
  body            text        NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
  link            text        CHECK (link IS NULL OR link ~ '^#/'),
  status          text        NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Sent', 'Failed', 'Gone')),
  attempts        integer     NOT NULL DEFAULT 0,
  lease_until     timestamptz,
  error           text        CHECK (error IS NULL OR length(error) <= 500),
  sent_at         timestamptz,
  version         bigint      NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  PRIMARY KEY (community_id, id),
  FOREIGN KEY (community_id, subscription_id) REFERENCES comms.push_subscription (community_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS push_queue_due ON comms.push_queue (created_at) WHERE status = 'Queued';

-- the live stream finds a member's new notifications by time, across communities (each server instance asks for the members connected to it)
CREATE INDEX IF NOT EXISTS notification_member_recent ON comms.notification (to_membership_id, created_at) WHERE to_membership_id IS NOT NULL;

SELECT platform.apply_security();

-- =====================================================================================================================================
-- V15 notices, notifications and the forum.
--   * the in-app inbox: one row per person (fanned out by the server from what happened), read per person
--   * the channel queue (email / SMS / WhatsApp): who, which channel, which message, delivery state
--   * a notice (broadcast) is sent once to its audience; who got it, saw it and signed it is a receipt per person; one poll vote per person
--   * forum topics and posts by members, with moderation (hide with a reason) instead of deletion
--   * registers: checked templates, one preference row per member, one settings row per community
-- =====================================================================================================================================

-- ---- the inbox --------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE comms.notification
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS ref_id uuid;
CREATE INDEX IF NOT EXISTS notification_by_ref ON comms.notification (community_id, ref_id) WHERE ref_id IS NOT NULL;

-- ---- the channel queue ------------------------------------------------------------------------------------------------------------------------
ALTER TABLE comms.outbox_message
  ADD COLUMN IF NOT EXISTS membership_id uuid,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS error text;
UPDATE comms.outbox_message SET status = 'Queued' WHERE status IS NULL;
ALTER TABLE comms.outbox_message
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Queued',
  ADD CONSTRAINT outbox_message_status CHECK (status IN ('Queued', 'Sent', 'Failed', 'Skipped')),
  ADD CONSTRAINT outbox_message_channel CHECK (channel IS NULL OR channel IN ('Email', 'SMS', 'WhatsApp'));
CREATE INDEX IF NOT EXISTS outbox_message_queued ON comms.outbox_message (community_id, created_at) WHERE status = 'Queued';

-- ---- notices (broadcasts) -----------------------------------------------------------------------------------------------------------------------
UPDATE comms.broadcast SET status = 'Draft' WHERE status IS NULL;
UPDATE comms.broadcast SET type = 'Announcement' WHERE type IS NULL;
UPDATE comms.broadcast SET audience = 'All residents' WHERE audience IS NULL;
UPDATE comms.broadcast SET subject = 'Notice ' || short_id WHERE subject IS NULL OR btrim(subject) = '';
ALTER TABLE comms.broadcast
  ALTER COLUMN sent_at TYPE timestamptz USING sent_at::timestamptz,
  ADD COLUMN IF NOT EXISTS sent_by_id uuid,
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
  DROP COLUMN IF EXISTS signed_by,
  ALTER COLUMN subject SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Draft',
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN audience SET NOT NULL,
  ADD FOREIGN KEY (community_id, sent_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT broadcast_type CHECK (type IN ('Announcement', 'Emergency alert', 'Notice', 'Scheduled maintenance', 'Poll')),
  ADD CONSTRAINT broadcast_audience CHECK (audience IN ('All residents', 'Owners', 'All villas', 'All apartments', 'Selected villas', 'Selected apartments', 'Selected blocks', 'EC members', 'Staff')),
  ADD CONSTRAINT broadcast_status CHECK (status IN ('Draft', 'Scheduled', 'Sent')),
  ADD CONSTRAINT broadcast_sent CHECK (status <> 'Sent' OR sent_at IS NOT NULL),
  ADD CONSTRAINT broadcast_poll CHECK (type <> 'Poll' OR cardinality(poll_options) >= 2),
  ADD CONSTRAINT broadcast_reminder CHECK (reminder_frequency IS NULL OR reminder_frequency IN ('None', 'Daily', 'Every 3 days', 'Weekly')),
  ADD CONSTRAINT broadcast_subject_len CHECK (length(subject) <= 200);
CREATE TABLE IF NOT EXISTS comms.broadcast_receipt (
  community_id  uuid NOT NULL REFERENCES platform.community (id),
  broadcast_id  uuid NOT NULL,
  membership_id uuid NOT NULL,
  delivered_at  timestamptz NOT NULL DEFAULT now(),
  viewed_at     timestamptz,
  signed_at     timestamptz,
  PRIMARY KEY (community_id, broadcast_id, membership_id),
  FOREIGN KEY (community_id, broadcast_id) REFERENCES comms.broadcast (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, membership_id) REFERENCES identity.membership (community_id, id)
);
CREATE INDEX IF NOT EXISTS broadcast_receipt_member ON comms.broadcast_receipt (community_id, membership_id, delivered_at DESC);
COMMENT ON TABLE comms.broadcast_receipt IS 'who a notice was sent to, when they opened it and when they signed it (one row per person)';

-- a vote answers a notice's poll (one per unit; people without a unit vote for themselves) or a forum topic's poll (one per person)
DELETE FROM comms.poll_vote WHERE broadcast_id IS NULL OR voter_id IS NULL;
ALTER TABLE comms.poll_vote
  ADD COLUMN IF NOT EXISTS topic_id uuid,
  ALTER COLUMN voter_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS poll_vote_community_id_broadcast_id_fkey,
  ADD CONSTRAINT poll_vote_broadcast_fkey FOREIGN KEY (community_id, broadcast_id) REFERENCES comms.broadcast (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT poll_vote_target CHECK (num_nonnulls(broadcast_id, topic_id) = 1),
  ADD CONSTRAINT poll_vote_choices CHECK (cardinality(choices) >= 1);
CREATE UNIQUE INDEX IF NOT EXISTS poll_vote_one_per_unit ON comms.poll_vote (community_id, broadcast_id, unit_id) WHERE broadcast_id IS NOT NULL AND unit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS poll_vote_one_per_person ON comms.poll_vote (community_id, broadcast_id, voter_id) WHERE broadcast_id IS NOT NULL AND unit_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS poll_vote_one_per_topic ON comms.poll_vote (community_id, topic_id, voter_id) WHERE topic_id IS NOT NULL;

-- ---- forum ------------------------------------------------------------------------------------------------------------------------------------
UPDATE comms.forum_topic SET title = 'Topic ' || short_id WHERE title IS NULL OR btrim(title) = '';
UPDATE comms.forum_topic SET status = 'Open' WHERE status IS NULL;
ALTER TABLE comms.forum_topic
  ADD COLUMN IF NOT EXISTS author_id uuid,
  ADD COLUMN IF NOT EXISTS last_post_at timestamptz,
  ADD COLUMN IF NOT EXISTS poll_options text[] NOT NULL DEFAULT '{}',
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Open',
  ALTER COLUMN kind SET DEFAULT 'Discussion',
  ADD FOREIGN KEY (community_id, author_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT forum_topic_title CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  ADD CONSTRAINT forum_topic_status CHECK (status IN ('Open', 'Closed')),
  ADD CONSTRAINT forum_topic_kind CHECK (kind IS NULL OR kind IN ('Discussion', 'Poll')),
  ADD CONSTRAINT forum_topic_poll CHECK (kind IS DISTINCT FROM 'Poll' OR cardinality(poll_options) >= 2);
ALTER TABLE comms.poll_vote ADD FOREIGN KEY (community_id, topic_id) REFERENCES comms.forum_topic (community_id, id) ON DELETE CASCADE;
DELETE FROM comms.forum_post WHERE topic_id IS NULL OR author_id IS NULL OR body IS NULL;
ALTER TABLE comms.forum_post
  ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_reason text,
  ADD COLUMN IF NOT EXISTS hidden_by_id uuid,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ALTER COLUMN topic_id SET NOT NULL,
  ALTER COLUMN author_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS forum_post_community_id_topic_id_fkey,
  ADD CONSTRAINT forum_post_topic_fkey FOREIGN KEY (community_id, topic_id) REFERENCES comms.forum_topic (community_id, id) ON DELETE CASCADE,
  ALTER COLUMN body SET NOT NULL,
  ADD FOREIGN KEY (community_id, hidden_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT forum_post_body CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  ADD CONSTRAINT forum_post_hidden CHECK (NOT hidden OR coalesce(btrim(hidden_reason), '') <> '');
CREATE INDEX IF NOT EXISTS forum_post_by_topic ON comms.forum_post (community_id, topic_id, created_at);

-- ---- registers ----------------------------------------------------------------------------------------------------------------------------------
UPDATE comms.notification_template SET enabled = true WHERE enabled IS NULL;
ALTER TABLE comms.notification_template
  ALTER COLUMN event SET NOT NULL,
  ALTER COLUMN channel SET NOT NULL,
  ADD CONSTRAINT notification_template_channel CHECK (channel IN ('Email', 'SMS', 'WhatsApp')),
  ADD CONSTRAINT notification_template_audience CHECK (audience IS NULL OR audience IN ('Owner', 'Admin')),
  ADD CONSTRAINT notification_template_one UNIQUE (community_id, event, channel, audience);
DELETE FROM comms.notification_pref WHERE membership_id IS NULL;
ALTER TABLE comms.notification_pref
  ALTER COLUMN membership_id SET NOT NULL,
  ADD CONSTRAINT notification_pref_one UNIQUE (community_id, membership_id);
CREATE UNIQUE INDEX IF NOT EXISTS notification_setting_one_per_community ON comms.notification_setting (community_id);
UPDATE comms.important_number SET name = 'Number ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE comms.important_number
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN active SET DEFAULT true,
  ADD CONSTRAINT important_number_phone CHECK (phone IS NULL OR phone ~ '^[0-9+ ()-]{3,20}$');
UPDATE comms.number_section SET name = 'Section ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE comms.number_section
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN active SET DEFAULT true,
  ADD CONSTRAINT number_section_name UNIQUE (community_id, name);
ALTER TABLE comms.merge_field
  ADD CONSTRAINT merge_field_token CHECK (token IS NULL OR token ~ '^\{[a-zA-Z][a-zA-Z0-9_]{0,40}\}$');
ALTER TABLE comms.notice_template
  ADD CONSTRAINT notice_template_applies CHECK (applies_to IS NULL OR applies_to IN ('Any', 'DG bill', 'Water bill', 'Maintenance fee', 'Payment reminder', 'Announcement'));

-- ---- defaults for every community -----------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.provision_comms(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO comms.notification_setting (community_id, events) VALUES (p_community, '{}') ON CONFLICT (community_id) DO NOTHING;
  INSERT INTO comms.number_section (community_id, name, icon, sort_order)
  SELECT p_community, v.name, v.icon, v.n FROM (VALUES ('Emergency', '🚨', 1), ('Security', '🛡', 2), ('Maintenance', '🔧', 3), ('Office', '🏢', 4)) AS v(name, icon, n)
  ON CONFLICT (community_id, name) DO NOTHING;
  INSERT INTO comms.important_number (community_id, name, phone, group_value, available, sort_order)
  SELECT p_community, v.name, v.phone, v.grp, '24 x 7', v.n FROM (VALUES ('Police', '112', 'Emergency', 1), ('Fire', '101', 'Emergency', 2), ('Ambulance', '108', 'Emergency', 3)) AS v(name, phone, grp, n)
  WHERE NOT EXISTS (SELECT 1 FROM comms.important_number x WHERE x.community_id = p_community);
  INSERT INTO comms.merge_field (community_id, token, label, default_value)
  SELECT p_community, v.token, v.label, '' FROM (VALUES ('{name}', 'Recipient name'), ('{unit}', 'Unit number'), ('{community}', 'Community name'), ('{amount}', 'Amount'), ('{dueDate}', 'Due date')) AS v(token, label)
  WHERE NOT EXISTS (SELECT 1 FROM comms.merge_field x WHERE x.community_id = p_community);
END $$;

CREATE OR REPLACE FUNCTION platform.provision_community(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform.provision_core(p_community);
  PERFORM platform.provision_maintenance(p_community);
  PERFORM platform.provision_finance(p_community);
  PERFORM platform.provision_amenities(p_community);
  PERFORM platform.provision_gate(p_community);
  PERFORM platform.provision_comms(p_community);
END $$;

SELECT platform.provision_comms(id) FROM platform.community;

SELECT platform.apply_security();

-- A person can mute the notifications that are not urgent (forum, polls, cultural news, the brochure, the community calendar): no inbox row,
-- no push, no WhatsApp / SMS / e-mail for those. Tickets, bills, payments, approvals, the gate and notices cannot be muted.
ALTER TABLE comms.notification_pref ADD COLUMN IF NOT EXISTS muted text[] NOT NULL DEFAULT '{}';
ALTER TABLE comms.notification_pref DROP CONSTRAINT IF EXISTS notification_pref_muted;
ALTER TABLE comms.notification_pref ADD CONSTRAINT notification_pref_muted
  CHECK (muted <@ ARRAY['forum_topic', 'forum_reply', 'poll', 'cultural', 'brochure', 'calendar']::text[]);

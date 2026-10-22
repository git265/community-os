-- Staff at the gate. A staff member shows their own badge (a QR that changes every 30 seconds) and the guard scans it: that opens or closes
-- their gate visit, which names the membership, so the attendance report puts the gate times beside the clock-in and clock-out.
--   * the badge is signed by the server with the community's own random key (never in the app); a code is accepted once (replay refused)
--   * a staff visit always names its member
ALTER TABLE gate.visit ADD COLUMN IF NOT EXISTS member_id uuid;
ALTER TABLE gate.visit DROP CONSTRAINT IF EXISTS visit_kind,
  ADD CONSTRAINT visit_kind CHECK (kind IN ('Guest', 'Delivery', 'Cab', 'Maid / cook', 'Driver', 'Crew', 'Staff', 'Resident vehicle', 'Goods vehicle', 'Emergency', 'Other'));
ALTER TABLE gate.visit DROP CONSTRAINT IF EXISTS visit_member,
  ADD CONSTRAINT visit_member CHECK (kind <> 'Staff' OR member_id IS NOT NULL);
ALTER TABLE gate.visit DROP CONSTRAINT IF EXISTS visit_member_fk;
ALTER TABLE gate.visit ADD CONSTRAINT visit_member_fk FOREIGN KEY (community_id, member_id) REFERENCES identity.membership (community_id, id);
CREATE INDEX IF NOT EXISTS visit_by_member ON gate.visit (community_id, member_id, in_at) WHERE member_id IS NOT NULL;

-- the community's badge key: 32 random bytes made by the database, read only by the API
CREATE TABLE IF NOT EXISTS gate.badge_key (
  community_id uuid        NOT NULL PRIMARY KEY REFERENCES platform.community (id) ON DELETE CASCADE,
  secret       bytea       NOT NULL DEFAULT gen_random_bytes(32) CHECK (length(secret) >= 32),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- the last badge code accepted per member: a code (one 30-second window) is used once, an older one never again
CREATE TABLE IF NOT EXISTS gate.badge_use (
  community_id uuid        NOT NULL,
  member_id    uuid        NOT NULL,
  last_window  bigint      NOT NULL CHECK (last_window > 0),
  used_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, member_id),
  FOREIGN KEY (community_id, member_id) REFERENCES identity.membership (community_id, id) ON DELETE CASCADE
);

SELECT platform.apply_security();

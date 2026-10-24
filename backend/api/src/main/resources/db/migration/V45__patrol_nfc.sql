-- =====================================================================================================================================
-- V45 NFC tags for patrols (optional, off by default): a checkpoint can have an NFC tag fitted; a guard taps it with the phone instead of
-- scanning the printed QR code. Only a hash of the tag's serial number is kept (sha-256 of the community and the serial), so nobody can
-- read it back from the app. The community chooses: Off, Tag or QR (either counts), or Tag where fitted (a post with a tag takes only the tag).
-- =====================================================================================================================================
ALTER TABLE gate.checkpoint ADD COLUMN IF NOT EXISTS nfc_tag text CHECK (nfc_tag IS NULL OR nfc_tag ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX IF NOT EXISTS checkpoint_nfc_tag ON gate.checkpoint (community_id, nfc_tag) WHERE nfc_tag IS NOT NULL;
ALTER TABLE gate.scan ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'QR' CHECK (method IN ('QR', 'NFC'));
ALTER TABLE gate.setting ADD COLUMN IF NOT EXISTS patrol_nfc text NOT NULL DEFAULT 'Off' CHECK (patrol_nfc IN ('Off', 'Tag or QR', 'Tag where fitted'));
SELECT platform.apply_security();

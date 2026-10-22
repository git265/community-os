-- Late fees on the server: one fee bill per overdue bill per month (its number), never twice - the database holds to it, so the daily job on
-- several servers and a treasurer's "Apply now" at the same time still charge each month once.
ALTER TABLE billing.due ADD COLUMN IF NOT EXISTS late_fee_no smallint CHECK (late_fee_no IS NULL OR late_fee_no BETWEEN 1 AND 120);
ALTER TABLE billing.due DROP CONSTRAINT IF EXISTS due_late_fee_numbered;
ALTER TABLE billing.due ADD CONSTRAINT due_late_fee_numbered CHECK ((late_fee_for IS NULL) = (late_fee_no IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS due_late_fee_once ON billing.due (community_id, late_fee_for, late_fee_no) WHERE late_fee_for IS NOT NULL;

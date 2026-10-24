-- A skipped payment is named the way the app names its sources: "cultural:<id>", "assoc:<id>", "elec:<id>", "dgfuel:<id>" - not only a uuid.
ALTER TABLE finance.ledger_skip ALTER COLUMN source_id TYPE text USING source_id::text;

-- A cash count's "expected" is the books' cash balance, which can be below zero when spending is entered before the receipts; only the
-- counted cash is never negative.
ALTER TABLE finance.cash_count DROP CONSTRAINT IF EXISTS cash_count_money;
ALTER TABLE finance.cash_count ADD CONSTRAINT cash_count_money CHECK (coalesce(counted, 0) >= 0);

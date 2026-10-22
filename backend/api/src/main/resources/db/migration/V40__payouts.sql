-- Provider payouts: the money the payment provider sends to the community's bank (the online payments of a few days, less its fees) is
-- matched to the bank statement line. Each online payment goes into one payout; the payout's cash book entry posts
-- Dr bank (what arrived) / Dr provider fees / Cr gateway clearing (what the payments brought in), and is matched to the line.
ALTER TABLE billing.payment ADD COLUMN IF NOT EXISTS payout_entry_id uuid;
CREATE INDEX IF NOT EXISTS payment_unsettled ON billing.payment (community_id, received_at) WHERE provider IS NOT NULL AND payout_entry_id IS NULL;
ALTER TABLE billing.recon_issue DROP CONSTRAINT IF EXISTS recon_issue_kind_check;
ALTER TABLE billing.recon_issue ADD CONSTRAINT recon_issue_kind_check CHECK (kind IN ('late-capture', 'duplicate-capture', 'amount-mismatch', 'allocation-mismatch', 'bill-paid-mismatch',
  'refund-unanswered', 'ledger-unbalanced', 'credit-mismatch', 'payout-missing'));

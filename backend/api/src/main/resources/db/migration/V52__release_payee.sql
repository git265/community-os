-- =====================================================================================================================================
-- V52 How a release is to be paid: the payee's mode (UPI, bank transfer, cash, cheque) and their UPI id or account details, given by whoever
-- asks for the money (an EC member asking the Treasurer, say); a QR code to scan is a file attached to the release (owner type finance.release).
-- =====================================================================================================================================
ALTER TABLE finance.release
  ADD COLUMN IF NOT EXISTS pay_mode text CHECK (pay_mode IS NULL OR pay_mode IN ('UPI', 'Bank transfer', 'Cash', 'Cheque')),
  ADD COLUMN IF NOT EXISTS pay_to   text CHECK (pay_to IS NULL OR length(pay_to) <= 300);

ALTER TABLE docs.file_object DROP CONSTRAINT IF EXISTS file_object_owner_kind,
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document',
                                                              'cultural.photo', 'cultural.brochure', 'governance.agenda', 'governance.minutes', 'vendor.vendor',
                                                              'assets.equipment', 'assets.inventory', 'assets.dg_fuel', 'assets.electricity_bill', 'assets.audit', 'assets.log_entry',
                                                              'billing.reading', 'maintenance.checklist_round', 'finance.release'));

SELECT platform.apply_security();

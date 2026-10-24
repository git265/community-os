-- =====================================================================================================================================
-- V53 AMC and service visits are kept on the asset: an entry in its condition history (source: "AMC visit · <vendor>") that moves its last and
-- next service dates; the visit report is a file attached to that entry (owner type assets.condition_log). The vendor holds the AMC contract;
-- Audits keep the independent inspections and certificates.
-- =====================================================================================================================================
ALTER TABLE docs.file_object DROP CONSTRAINT IF EXISTS file_object_owner_kind,
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document',
                                                              'cultural.photo', 'cultural.brochure', 'governance.agenda', 'governance.minutes', 'vendor.vendor',
                                                              'assets.equipment', 'assets.inventory', 'assets.dg_fuel', 'assets.electricity_bill', 'assets.audit', 'assets.log_entry',
                                                              'billing.reading', 'maintenance.checklist_round', 'finance.release', 'assets.condition_log'));

SELECT platform.apply_security();

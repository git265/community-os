-- Meter photos are files attached to a reading (owner type billing.reading): the database's list of owner kinds now has it too (it was only in
-- the server's registry, so attaching a photo on the back end was refused by the table's check).
ALTER TABLE docs.file_object DROP CONSTRAINT IF EXISTS file_object_owner_kind,
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document',
                                                              'cultural.photo', 'cultural.brochure', 'governance.agenda', 'governance.minutes', 'vendor.vendor',
                                                              'assets.equipment', 'assets.inventory', 'assets.dg_fuel', 'assets.electricity_bill', 'assets.audit', 'assets.log_entry',
                                                              'billing.reading'));

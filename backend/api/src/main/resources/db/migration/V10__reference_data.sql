-- =====================================================================================================================================
-- V10 reference data: the permission catalogue, and platform.provision_community() which gives a new community its default groups,
-- roles, charge categories and chart of accounts (generated from the app's built-in roles)
-- =====================================================================================================================================

INSERT INTO identity.permission (code, label) VALUES
  ('MANAGE_ROLES', 'Manage roles & permissions'),
  ('MANAGE_USERS', 'Manage users'),
  ('MANAGE_UNITS', 'Manage units directory'),
  ('MANAGE_DOCUMENTS', 'Manage documents'),
  ('MANAGE_CULTURAL', 'Manage cultural events, donations & expenses'),
  ('MANAGE_DUES', 'Manage dues'),
  ('MANAGE_LEDGER', 'Manage accounting / ledger'),
  ('MANAGE_AMENITIES', 'Manage amenities (bookings, payments, refunds, deposits)'),
  ('MANAGE_AMENITY_RATES', 'Change amenity rates, GST, deposits & cancellation rules'),
  ('MANAGE_AMENITY_RULES', 'Edit amenity rules & regulations'),
  ('MANAGE_NOTIFICATIONS', 'Edit notification templates, recipients & reports'),
  ('MANAGE_TICKETS', 'Manage maintenance tickets'),
  ('SET_FINANCIAL_FLAG', 'Mark a task as involving a financial transaction (default: EC and Super Admin)'),
  ('MANAGE_TICKET_TYPES', 'Manage ticket categories'),
  ('MANAGE_VENDORS', 'Manage vendors'),
  ('MODERATE_FORUM', 'Moderate forum'),
  ('MANAGE_FIELD_DUTIES', 'Manage field-staff duties'),
  ('VIEW_AUDIT_LOG', 'View audit log'),
  ('MANAGE_UTILITY_BILLING', 'Manage utility billing'),
  ('MANAGE_UTILITY_TYPES', 'Add / edit utility types (water, DG, gas, …) and custom logs'),
  ('MANAGE_UTILITY_READINGS', 'Record & publish water / DG meter readings'),
  ('MANAGE_NOTICE_TEMPLATES', 'Manage notice templates'),
  ('MANAGE_SECURITY', 'Manage security & visitors'),
  ('MANAGE_GOVERNANCE', 'Manage governance & committees')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

CREATE OR REPLACE FUNCTION platform.provision_community(p_community uuid) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE g_ec uuid; g_staff uuid; g_res uuid; r uuid;
BEGIN
  PERFORM set_config('app.community_id', p_community::text, true);
  INSERT INTO identity.role_group (community_id, name, category, description) VALUES (p_community, 'Executive Committee', 'EC', 'Elected committee members') RETURNING id INTO g_ec;
  INSERT INTO identity.role_group_permission (community_id, group_id, permission) VALUES (p_community, g_ec, 'MODERATE_FORUM');
  INSERT INTO identity.role_group_permission (community_id, group_id, permission) VALUES (p_community, g_ec, 'VIEW_AUDIT_LOG');
  INSERT INTO identity.role_group_permission (community_id, group_id, permission) VALUES (p_community, g_ec, 'SET_FINANCIAL_FLAG');
  INSERT INTO identity.role_group (community_id, name, category, description) VALUES (p_community, 'Staff', 'Staff', 'Facility and field staff') RETURNING id INTO g_staff;
  INSERT INTO identity.role_group_permission (community_id, group_id, permission) VALUES (p_community, g_staff, 'MANAGE_UTILITY_READINGS');
  INSERT INTO identity.role_group (community_id, name, category, description) VALUES (p_community, 'Residents', 'Resident', 'Owners and residents') RETURNING id INTO g_res;
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'super_admin', 'Super Admin', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_ROLES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_USERS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UNITS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_DOCUMENTS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_CULTURAL', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_DUES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_LEDGER', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITIES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RATES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RULES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_NOTIFICATIONS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_TICKETS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_TICKET_TYPES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_VENDORS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_FIELD_DUTIES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_BILLING', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_TYPES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_READINGS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_NOTICE_TEMPLATES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_SECURITY', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_GOVERNANCE', 'grant');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'president', 'President', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_CULTURAL', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_GOVERNANCE', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_DOCUMENTS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RATES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RULES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_NOTIFICATIONS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'SET_FINANCIAL_FLAG', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'general_secretary', 'General Secretary', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_CULTURAL', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_GOVERNANCE', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_DOCUMENTS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_NOTICE_TEMPLATES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UNITS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RULES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_NOTIFICATIONS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'SET_FINANCIAL_FLAG', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'treasurer', 'Treasurer', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_DUES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_LEDGER', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_BILLING', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_VENDORS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RATES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MODERATE_FORUM', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'SET_FINANCIAL_FLAG', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'committee_landscape', 'Landscape Committee', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_VENDORS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MODERATE_FORUM', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'VIEW_AUDIT_LOG', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'SET_FINANCIAL_FLAG', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'committee_electrical', 'Electrical Committee', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_VENDORS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_BILLING', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MODERATE_FORUM', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'VIEW_AUDIT_LOG', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'SET_FINANCIAL_FLAG', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'committee_security', 'Security Committee', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_SECURITY', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MODERATE_FORUM', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'VIEW_AUDIT_LOG', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'SET_FINANCIAL_FLAG', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'committee_cultural', 'Cultural Committee', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_DOCUMENTS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_CULTURAL', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_NOTIFICATIONS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'VIEW_AUDIT_LOG', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'SET_FINANCIAL_FLAG', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'committee_amenities', 'Amenities Committee', g_ec, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITIES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RATES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RULES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_NOTIFICATIONS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MODERATE_FORUM', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'VIEW_AUDIT_LOG', 'revoke');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'SET_FINANCIAL_FLAG', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'facility_manager', 'Facility Manager', g_staff, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_TICKETS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_TICKET_TYPES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_FIELD_DUTIES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_BILLING', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_VENDORS', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITIES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_AMENITY_RULES', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UNITS', 'grant');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'helpdesk', 'Helpdesk', g_staff, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'handyman_plumbing', 'Handyman · Plumbing', g_staff, true, 'Plumbing') RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_READINGS', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'handyman_electrical', 'Handyman · Electrical', g_staff, true, 'Electrical') RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_READINGS', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'handyman_security', 'Handyman · Security', g_staff, true, 'Security') RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_SECURITY', 'grant');
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_READINGS', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'handyman_mep', 'Handyman · MEP', g_staff, true, 'MEP') RETURNING id INTO r;
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'handyman_general', 'Handyman · General', g_staff, true, 'General') RETURNING id INTO r;
  INSERT INTO identity.role_permission_override (community_id, role_id, permission, effect) VALUES (p_community, r, 'MANAGE_UTILITY_READINGS', 'revoke');
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'owner', 'Owner', g_res, true, NULL) RETURNING id INTO r;
  INSERT INTO identity.role (community_id, code, name, group_id, built_in, trade) VALUES (p_community, 'resident', 'Resident', g_res, true, NULL) RETURNING id INTO r;
  INSERT INTO finance.account (community_id, code, name, kind, is_bank) VALUES
    (p_community, '1000', 'Bank', 'Asset', true), (p_community, '1100', 'Members receivable', 'Asset', false), (p_community, '1200', 'Payment gateway clearing', 'Asset', false),
    (p_community, '2000', 'Advances from members', 'Liability', false), (p_community, '2100', 'Tax payable', 'Liability', false), (p_community, '3000', 'Corpus fund', 'Equity', false),
    (p_community, '4000', 'Maintenance income', 'Income', false), (p_community, '4100', 'Utility income', 'Income', false), (p_community, '4200', 'Amenity income', 'Income', false),
    (p_community, '4300', 'Late fees', 'Income', false), (p_community, '5000', 'Operating expenses', 'Expense', false);
  INSERT INTO billing.charge_category (community_id, code, name, is_utility, income_account_id)
    SELECT p_community, v.code, v.name, v.util, (SELECT id FROM finance.account a WHERE a.community_id = p_community AND a.code = v.acct)
    FROM (VALUES ('Maintenance', 'Maintenance', false, '4000'), ('Water', 'Water', true, '4100'), ('DG', 'DG (generator)', true, '4100'),
                 ('Late fee', 'Late fee', false, '4300'), ('Corpus', 'Corpus', false, '4000'), ('Levy', 'Special levy', false, '4000')) AS v(code, name, util, acct);
  INSERT INTO platform.community_settings (community_id) VALUES (p_community);
END $fn$;

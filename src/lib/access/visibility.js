// Who sees the Utilities and Plant pages. Kept apart from the pages themselves so the navigation can decide
// without loading them (each page is downloaded only when it is opened).
const isHandyman = (role) => !!role?.id?.startsWith('handyman_');
export const utilitiesVisible = (role, has) => role.category === 'EC' || has('MANAGE_UTILITY_READINGS') || has('MANAGE_UTILITY_BILLING') || has('MANAGE_LEDGER') || role.id === 'facility_manager';
export const plantVisible = (role) => role.category !== 'Resident' && (!isHandyman(role) || role.id === 'handyman_mep');

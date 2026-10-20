// Document repository groups: who a document is for. A "Villa owner / resident" document belongs to ONE villa
// (the villa is mandatory) and can be opened only by the owner / resident signed in for that villa.
import { DOC_GROUPS, DOC_VILLA_GROUP, CUSTOM_DOC_GROUPS } from './lists/configLists.js';
export { DOC_GROUPS, DOC_VILLA_GROUP }; // live list: the community can add groups in Community setup -> Lists
const LEGACY = { 'All residents': 'Everyone', Owners: 'All owners', Restricted: DOC_VILLA_GROUP };
export const docGroup = (r) => LEGACY[r?.access] || r?.access || 'Everyone';

/** May this principal (a non-admin) see this document? `has` checks a permission on the principal's role. */
export function docVisible(r, p) {
  const group = docGroup(r);
  const cat = p?.role?.category;
  const has = (x) => !!p?.role?.permissions?.includes(x);
  switch (group) {
    case 'Everyone': return true;
    case 'All owners': return cat !== 'Resident' || p.roleId === 'owner';
    case 'Executive Committee': return cat === 'EC';
    case 'EC + Finance': return cat === 'EC' || has('MANAGE_LEDGER');
    case 'Staff': return cat === 'EC' || cat === 'Staff';
    case DOC_VILLA_GROUP: return cat === 'Resident' ? !!r.unit && r.unit === p.unit : has('MANAGE_DOCUMENTS') || cat === 'EC';
    default: { const g = CUSTOM_DOC_GROUPS.find((x) => x.name === group); return g ? g.roles.includes(p?.roleId) || cat === 'EC' && g.roles.includes('group:EC') : cat !== 'Resident'; }
  }
}

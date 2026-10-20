// The community's identity on printed documents (receipts, statements). All of it is data in Community setup > Community details,
// so another community prints its own name, address, registration and tax number - nothing is hard-coded.
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { region } from '../region/regions.js';

/** Letterhead from a community-details row. Pure, so the setup screen can preview unsaved edits. */
export function letterheadFrom(c = {}, fallbackName = '') {
  const taxId = c.taxRegistered === 'No' ? '' : String(c.taxId || '').trim(); // not registered = no tax number anywhere
  return {
    name: c.legalName || fallbackName || 'Residents’ Association',
    address: c.address || '', regNo: c.registrationNo || '', pan: c.panNo || '', phone: c.contactPhone || '', email: c.contactEmail || '', website: c.website || '',
    taxId, taxLabel: region().tax.idLabel,
    signatory: c.signatory || 'Authorised signatory', thanks: c.receiptThanks || 'Received with thanks',
    footer: c.receiptFooter || 'This is a computer-generated document and does not require a signature.',
    statementNote: c.statementNote || '', payHow: c.payInstructions || '',
  };
}

export async function getLetterhead() {
  const [cfg] = await storage.list(C.COMMUNITY_CONFIG).catch(() => []);
  const merge = (await storage.list(C.MERGE_FIELDS).catch(() => [])).find((m) => m.token === '{{SOCIETY_NAME}}');
  return letterheadFrom(cfg || {}, merge?.defaultValue);
}

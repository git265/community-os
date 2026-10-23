import { logEvent, getPrincipalLabel } from '../lib/audit/auditLog.js';
import React, { useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { secureStorage } from '../lib/storage/secureStorage.js';
import { storage, COLLECTIONS } from '../lib/storage/index.js';
import { AuthzError } from '../lib/security/authz.js';

/** Related rows that go with a record when it is deleted (so nothing is left dangling). */
const CASCADE = {
  [COLLECTIONS.TICKETS]: [[COLLECTIONS.TICKET_COMMENTS, 'ticketId'], [COLLECTIONS.QUOTATIONS, 'ticketId']],
  [COLLECTIONS.BROADCASTS]: [[COLLECTIONS.POLL_VOTES, 'broadcastId']],
  [COLLECTIONS.FORUM]: [[COLLECTIONS.FORUM_POSTS, 'topicId']],
};
const NOTES = {
  [COLLECTIONS.TICKETS]: 'Its chat messages, quotations and invoices are deleted with it. Payments Cross-check entries stay (financial records) but lose their task link.',
  [COLLECTIONS.PROPERTIES]: 'The people linked to it keep their portal accounts; remove them in Users if needed.',
};

/** Super Admin only: permanently delete one record (confirmed, audited). Voting records and the audit trail can never be deleted. */
export default function AdminDelete({ collection, id, label = 'record', onDone, small = true, children }) {
  const { roleId } = useApp();
  const [busy, setBusy] = useState(false);
  if (roleId !== 'super_admin' || !id) return null;
  async function go() {
    const note = NOTES[collection] ? `\n\n${NOTES[collection]}` : '';
    if (!window.confirm(`Permanently delete this ${label}? This cannot be undone.${note}`)) return;
    setBusy(true);
    try {
      for (const [col, key] of CASCADE[collection] || []) {
        for (const r of (await storage.list(col)).filter((x) => x[key] === id)) { await storage.remove(col, r.id); logEvent({ who: getPrincipalLabel(), what: col, action: 'Delete', recordId: r.id, recordShortId: r.shortId || '', summary: `${r.shortId || col} removed together with the ${label}` }); }
      }
      if (collection === COLLECTIONS.TICKETS) {
        const t = await storage.get(collection, id);
        for (const l of (await storage.list(COLLECTIONS.LEDGER)).filter((x) => t && x.taskRef === t.ticketNumber)) await storage.put(COLLECTIONS.LEDGER, { ...l, taskRef: '', sourceId: '' });
      }
      const rec = await storage.get(collection, id);
      await secureStorage.remove(collection, id, { label });
      // the files attached to the record go with it
      const fileIds = new Set();
      const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.fileId) fileIds.add(v.fileId); Object.values(v).forEach(walk); } };
      walk(rec);
      for (const fid of fileIds) await storage.remove(COLLECTIONS.FILES, fid).catch(() => {});
      onDone?.();
    } catch (err) {
      const message = err instanceof AuthzError ? err.message : `Could not delete: ${err?.message || 'error'}`;
      window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message } }));
    } finally { setBusy(false); }
  }
  // a rare, Super-Admin-only action: a quiet red link, not a big red button on every record
  return <button type="button" data-testid="admin-delete" className={`link-btn danger-link${small ? ' sm' : ''}`} disabled={busy} onClick={go}>{children || `Delete ${label}`}</button>;
}

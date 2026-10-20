import React, { useEffect, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { finalApproverRoleIds } from './ticketEngine.js';

/** Roles that can see and decide financial tasks: EC roles plus the Facility Manager and MEP. */
const eligible = (r) => r.category === 'EC' || r.id === 'facility_manager' || r.id === 'handyman_mep';

/**
 * "Final approvers": which roles give the second-step approval (after the EC) on a financial task.
 * Saved as one settings row; the server (authz.js -> isSecondApprover) enforces it, and the Approve button and the
 * "waiting for your approval" banner in Maintenance follow it.
 */
export default function ApproversPanel() {
  const { roles } = useApp();
  const { records, save } = useCollection(COLLECTIONS.APPROVER_SETTINGS, 'Final Approvers');
  const row = records[0];
  const saved = finalApproverRoleIds(records);
  const [picked, setPicked] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const canEdit = canWriteCollection(COLLECTIONS.APPROVER_SETTINGS, getPrincipal());
  useEffect(() => { setPicked(finalApproverRoleIds(records)); }, [row?.recVersion, row?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = roles.filter(eligible);
  const dirty = JSON.stringify([...picked].sort()) !== JSON.stringify([...saved].sort());
  const toggle = (id) => { setDone(false); setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); };

  async function submit() {
    if (!picked.length) return;
    setBusy(true);
    const out = await save({ ...(row || { name: 'Final approval' }), roles: picked });
    setBusy(false);
    if (out) setDone(true);
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Final approvers</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        Every financial task goes to the EC first. Tick the roles that may then give the <b>final approval</b> — they get the Approve button
        and the “waiting for your approval” banner, and the system accepts the decision only from them. Default: Treasurer and President.
      </p>
      <div className={`field${!picked.length ? ' invalid' : ''}`}><label>Final approver roles *</label></div>
      <div className="approver-grid">
        {list.map((r) => (
          <label key={r.id} className={`approver-opt${picked.includes(r.id) ? ' on' : ''}`}>
            <input type="checkbox" checked={picked.includes(r.id)} disabled={!canEdit} onChange={() => toggle(r.id)} />
            <span>{r.name}<small className="muted">{r.category === 'EC' ? 'EC' : 'Staff'}</small></span>
          </label>
        ))}
      </div>
      {!picked.length && <div className="field invalid"><div className="field-error">Pick at least one role.</div></div>}
      {canEdit ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn" disabled={!dirty || busy || !picked.length} onClick={submit}>{busy ? 'Saving…' : 'Save approvers'}</button>
          {dirty && <button type="button" className="btn secondary" onClick={() => setPicked(saved)}>Discard</button>}
          {done && !dirty && <span className="tag green">Saved</span>}
        </div>
      ) : (
        <small className="muted" style={{ display: 'block', marginTop: 12 }}>Only the President or the Treasurer can change this list.</small>
      )}
    </div>
  );
}

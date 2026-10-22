import React, { useEffect, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { COND_COLOR, units } from './infraModel.js';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Shown when a task that is linked to an asset is marked Completed or Closed: "is it working again?". The asset's condition is never
 * changed silently; the person who did or checked the work answers, and the answer is logged against the task.
 */
export default function AssetBackDialog({ ticket, onClose }) {
  const { currentUser, role } = useApp();
  const [asset, setAsset] = useState(undefined);
  const [choice, setChoice] = useState('Working');
  const [faulty, setFaulty] = useState('0');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    secureStorage.get(COLLECTIONS.EQUIPMENT, ticket.assetId).then((a) => { if (live) setAsset(a || null); }).catch(() => { if (live) setAsset(null); });
    return () => { live = false; };
  }, [ticket.assetId]);
  const canWrite = canWriteCollection(COLLECTIONS.EQUIPMENT, getPrincipal());
  // nothing to ask: the asset is gone, the person may not change it, or it is already recorded as working
  const skip = asset === null || (asset && (!canWrite || (asset.status === 'Working' && !(Number(asset.faulty) > 0))));
  useEffect(() => { if (skip) onClose(); }, [skip]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!asset || skip) return null;
  const group = units(asset) > 1;

  async function save() {
    setBusy(true); setErr('');
    try {
      const f = choice === 'Working' ? 0 : (group ? Math.max(0, Math.min(units(asset), Math.floor(Number(faulty) || 0))) : 0);
      const saved = await secureStorage.put(COLLECTIONS.EQUIPMENT, { ...asset, status: choice, faulty: f, lastInspected: today() });
      if (!saved) { setBusy(false); setErr('Not saved. You may not be allowed to change this asset.'); return; }
      await secureStorage.put(COLLECTIONS.INFRA_LOG, {
        assetId: asset.id, assetName: asset.name, date: today(), condition: choice, source: ticket.status === 'Closed' ? 'Task closed' : 'Task completed',
        note: [group && f ? `${f} of ${units(asset)} still faulty` : '', note.trim()].filter(Boolean).join('. '), by: currentUser?.name || role?.name || '', ticketId: ticket.id,
      });
      setBusy(false); onClose(choice);
    } catch (e) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Is it working again?" subtitle={`${ticket.title} is ${ticket.status === 'Closed' ? 'closed' : 'completed'}. Record how ${asset.name} is now; the map and the asset history are updated.`} onClose={() => onClose()}>
      <div data-testid="asset-back-dialog">
        <div className="infra-choices" role="radiogroup" aria-label="Condition now">
          {[['Working', 'Yes, working again'], ['Needs attention', 'Works, but still needs attention'], ['Out of service', 'No, still out of service']].map(([v, l]) => (
            <label key={v} className={`infra-choice${choice === v ? ' on' : ''}`}>
              <input type="radio" name="back" checked={choice === v} onChange={() => setChoice(v)} data-testid={`back-${v}`} />
              <span className="dot" style={{ background: COND_COLOR[v] }} />{l}
            </label>
          ))}
        </div>
        {group && choice !== 'Working' && <div className="field" style={{ marginTop: 10 }}><label>How many of the {units(asset)} are still faulty</label><input type="number" min="0" max={units(asset)} aria-label="Still faulty" value={faulty} onChange={(e) => setFaulty(e.target.value)} /></div>}
        <div className="field" style={{ marginTop: 10 }}><label>Note (optional)</label><input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done" /></div>
        {err && <div className="field-error" style={{ marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn secondary" type="button" data-testid="back-later" onClick={() => onClose()}>Decide later</button>
          <button className="btn" type="button" data-testid="back-save" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

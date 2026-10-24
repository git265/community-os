// An asset's AMC and service visits: when, by whom, what was done, the report; and "Log a service visit", which moves its service dates.
// The vendor holds the AMC contract (Vendors); Audits keep the independent inspections and certificates.
import React, { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import Combobox from '../../components/Combobox.jsx';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { VISIT_KINDS, visitOf, logServiceVisit } from '../../lib/serviceVisits.js';
import { fmtDate, todayLocal } from '../../lib/locale.js';

const CONDS = ['Working', 'Needs attention', 'Under repair', 'Out of service', 'Standby'];
const today = todayLocal;
const plusMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };

export default function ServiceVisits({ asset, canEdit = false }) {
  const { records: log } = useCollection(C.INFRA_LOG, 'Condition log');
  const { records: vendors } = useCollection(C.VENDORS, 'Vendors', { enabled: canEdit });
  const [open, setOpen] = useState(false);
  const visits = log.filter((r) => r.assetId === asset.id && visitOf(r)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return (
    <div className="svc-visits" data-testid="service-visits">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, flex: 1 }}>AMC &amp; service visits</h4>
        {canEdit && <button type="button" className="btn secondary sm" data-testid="visit-log" onClick={() => setOpen(true)}>+ Log a service visit</button>}
      </div>
      {!visits.length ? <p className="muted" style={{ margin: '4px 0 0' }}>No visit logged yet{asset.amcVendor ? ` (AMC with ${asset.amcVendor})` : ''}.</p> : (
        <ul className="infra-list" data-testid="visit-list">
          {visits.slice(0, 8).map((r) => {
            const v = visitOf(r);
            return (
              <li key={r.id}>
                <b>{v.kind}</b> <small className="muted">{fmtDate(r.date)}{v.vendor ? ` · ${v.vendor}` : ''}{r.by ? ` · ${r.by}` : ''} · {r.condition}</small>
                {r.note ? <div className="muted" style={{ fontSize: 12.5 }}>{r.note}</div> : null}
                {(r.reports || []).length > 0 && <AttachmentList items={r.reports} />}
              </li>
            );
          })}
        </ul>
      )}
      {open && <VisitDialog asset={asset} vendors={vendors} onClose={() => setOpen(false)} />}
    </div>
  );
}

function VisitDialog({ asset, vendors, onClose }) {
  const [f, setF] = useState(() => ({ date: today(), kind: asset.amcVendor ? 'AMC visit' : 'Service', vendor: asset.amcVendor || '', condition: 'Working', note: '', nextService: asset.amcVendor ? plusMonths(today(), 3) : '' }));
  const [pending, setPending] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    setErr(''); setBusy(true);
    try { const e = await logServiceVisit(asset, f, pending, getPrincipal()?.name || ''); if (e) onClose(); } catch (x) { setErr(x?.message || String(x)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Service visit · ${asset.name}`} subtitle="Kept in the asset's history with the report; it moves the last and next service dates." onClose={onClose}>
      {err && <div className="notice error" data-testid="visit-error">{err}</div>}
      <div className="form-grid" data-testid="visit-form">
        <div className="field"><label>Date</label><input type="date" aria-label="Visit date" max={today()} value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field"><label>Kind</label><select aria-label="Kind of visit" value={f.kind} onChange={(e) => set('kind', e.target.value)}>{VISIT_KINDS.map((k) => <option key={k}>{k}</option>)}</select></div>
        <div className="field"><label>By (vendor)</label><Combobox value={f.vendor} onChange={(v) => set('vendor', v)} options={vendors.filter((v) => v.name).map((v) => ({ value: v.name, label: v.name, hint: v.contractType || v.service || '' }))} allowCustom placeholder="Vendor or technician" /></div>
        <div className="field"><label>Condition after</label><select aria-label="Condition after" value={f.condition} onChange={(e) => set('condition', e.target.value)}>{CONDS.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>What was done</label><textarea aria-label="What was done" rows={2} maxLength={4000} value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. Quarterly AMC check, brake pads adjusted, door sensor replaced" /></div>
        <div className="field"><label>Next service due</label><input type="date" aria-label="Next service due" min={f.date} value={f.nextService} onChange={(e) => set('nextService', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Visit report</label><AttachmentPicker pending={pending} onChange={setPending} label="Attach the visit report" /></div>
      </div>
      <div className="form-actions"><button type="button" className="btn" data-testid="visit-save" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save visit'}</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

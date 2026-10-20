import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import RecordModal from '../billing/RecordModal.jsx';

/** Workers a vendor is signed for, by service line, against the workers registered at the gate and the ones on site now. A facilities vendor may cover several services; another vendor may cover one. */
export default function VendorWorkers({ vendor }) {
  const { records: lines, refresh } = useCollection(C.VENDOR_SERVICES, 'Vendor service lines');
  const { records: people } = useCollection(C.GATE_PEOPLE, 'Registry');
  const { records: visits } = useCollection(C.GATE_VISITS, 'Gate visits');
  const [edit, setEdit] = useState(null);
  const canEdit = canWriteCollection(C.VENDOR_SERVICES, getPrincipal());
  const mine = lines.filter((l) => l.vendorName === vendor.name).sort((a, b) => String(a.service).localeCompare(String(b.service)));
  const signed = mine.reduce((n, l) => n + (Number(l.signedWorkers) || 0), 0);
  const reg = useMemo(() => people.filter((p) => p.vendor === vendor.name && p.status === 'Active'), [people, vendor.name]);
  const regIds = new Set(reg.map((p) => p.id));
  const inside = visits.filter((v) => v.state === 'Inside' && (regIds.has(v.personId) || v.company === vendor.name)).length;
  const gap = signed - reg.length;
  return (
    <div className="ro-block" data-testid="vendor-workers">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0 }}>👷 Workers signed for</h3>
        {canEdit && <button type="button" className="link-btn" data-testid="vs-add" onClick={() => setEdit({ vendorName: vendor.name, signedWorkers: 1 })}>+ Add a service</button>}
      </div>
      {mine.length === 0 ? <p className="muted" style={{ margin: '6px 0 0' }}>No service lines yet. Add what this vendor is signed for and how many workers.</p> : (
        <>
          <ul className="list" style={{ marginTop: 6 }}>
            {mine.map((l) => (
              <li key={l.id} data-testid="vs-row">
                <span><b>{l.service}</b>{l.shift ? <><br /><small className="muted">{l.shift}</small></> : null}</span>
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><b>{l.signedWorkers}</b>{canEdit && <button type="button" className="link-btn" aria-label={`Edit ${l.service}`} onClick={() => setEdit(l)}>Edit</button>}</span>
              </li>
            ))}
          </ul>
          <div className="gg-kpis" style={{ margin: '8px 0 0' }}>
            <div className="gg-kpi"><span className="muted">Signed for</span><b data-testid="vs-signed">{signed}</b></div>
            <div className="gg-kpi"><span className="muted">Registered at gate</span><b data-testid="vs-reg">{reg.length}</b></div>
            <div className={`gg-kpi${gap > 0 ? ' warn' : ''}`}><span className="muted">Not yet registered</span><b data-testid="vs-gap">{Math.max(0, gap)}</b></div>
            <div className="gg-kpi"><span className="muted">On site now</span><b data-testid="vs-inside">{inside}</b></div>
          </div>
          {gap > 0 && <small className="muted" data-testid="vs-gap-note">{gap} worker{gap === 1 ? '' : 's'} promised by the contract {gap === 1 ? 'is' : 'are'} not in the gate registry yet, so {gap === 1 ? 'they' : 'they'} cannot be let in by name.</small>}
          {gap < 0 && <small className="muted">{-gap} more registered than signed for. Check the contract or end the extra registrations.</small>}
        </>
      )}
      {edit && <RecordModal collection={C.VENDOR_SERVICES} label="Vendor service lines" record={edit} title={edit.id ? 'Edit service line' : 'Add a service line'} subtitle={`${vendor.name}: what they are signed for`} allowDelete onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh?.(); }} />}
    </div>
  );
}

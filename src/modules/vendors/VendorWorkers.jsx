import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import RecordModal from '../billing/RecordModal.jsx';
import { money } from '../../lib/locale.js';

const ym = () => new Date().toISOString().slice(0, 7);
const n0 = (v) => Number(v) || 0;
const inr = (n) => money(n);

/**
 * What a vendor is signed for, one line per category they handle (a facilities company may run housekeeping, landscaping and plant operation;
 * another vendor only security). Each line has its own employees and contractors, and is set against the gate registry (workers name their
 * line), who came in this month (attendance) and the fixed monthly expenses booked against that line.
 */
export default function VendorWorkers({ vendor }) {
  const { records: lines, refresh } = useCollection(C.VENDOR_SERVICES, 'Vendor service lines');
  const { records: people } = useCollection(C.GATE_PEOPLE, 'Registry');
  const { records: visits } = useCollection(C.GATE_VISITS, 'Gate visits');
  const { records: fixed } = useCollection(C.FIXED_EXPENSES, 'Fixed Monthly Expenses');
  const [edit, setEdit] = useState(null);
  const canEdit = canWriteCollection(C.VENDOR_SERVICES, getPrincipal());
  const mine = lines.filter((l) => l.vendorName === vendor.name).sort((a, b) => String(a.service).localeCompare(String(b.service)));
  const reg = useMemo(() => people.filter((p) => p.vendor === vendor.name && p.status === 'Active'), [people, vendor.name]);
  const month = ym();
  const stats = useMemo(() => {
    const byId = new Map(reg.map((p) => [p.id, p]));
    const lineOf = (p) => (p?.vendorService && mine.some((l) => l.service === p.vendorService) ? p.vendorService : '');
    const row = () => ({ reg: 0, inside: 0, days: new Set(), fixed: 0 });
    const out = new Map(mine.map((l) => [l.service, row()])); out.set('', row());
    reg.forEach((p) => { out.get(lineOf(p)).reg += 1; });
    visits.forEach((v) => {
      const p = byId.get(v.personId); if (!p && v.company !== vendor.name) return;
      const r = out.get(lineOf(p));
      if (v.state === 'Inside') r.inside += 1;
      if (p && String(v.inAt || '').slice(0, 7) === month) r.days.add(`${p.id}|${String(v.inAt).slice(0, 10)}`);   // a person on a day counts once
    });
    fixed.filter((f) => f.vendor === vendor.name).forEach((f) => { (out.get(mine.some((l) => l.service === f.vendorService) ? f.vendorService : '') || out.get('')).fixed += n0(f.avg); });
    return out;
  }, [reg, visits, fixed, mine, vendor.name, month]);
  const heads = (l) => n0(l.signedWorkers) + n0(l.contractors);
  const signed = mine.reduce((n, l) => n + heads(l), 0);
  const inside = [...stats.values()].reduce((n, r) => n + r.inside, 0);
  const gap = signed - reg.length;
  const loose = stats.get('');
  return (
    <div className="ro-block" data-testid="vendor-workers" style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0 }}>👷 Categories and workers</h3>
        {canEdit && <button type="button" className="link-btn" data-testid="vs-add" onClick={() => setEdit({ vendorName: vendor.name, signedWorkers: 1, contractors: 0 })}>+ Add a category</button>}
      </div>
      {mine.length === 0 ? <p className="muted" style={{ margin: '6px 0 0' }}>No categories yet. Add each category this vendor handles, with how many employees and contractors it is signed for.</p> : (
        <>
          <div className="vs-lines" data-testid="vs-table">
            {mine.map((l) => {
              const r = stats.get(l.service);
              return (
                <div key={l.id} className="vs-line" data-testid="vs-row">
                  <div className="vs-head">
                    <span><b>{l.service}</b>{l.shift ? <small className="muted"> · {l.shift}</small> : null}</span>
                    {canEdit && <button type="button" className="link-btn" aria-label={`Edit ${l.service}`} onClick={() => setEdit(l)}>Edit</button>}
                  </div>
                  <dl className="vs-stats">
                    <div><dt>Employees</dt><dd>{n0(l.signedWorkers)}</dd></div>
                    <div><dt>Contractors</dt><dd>{n0(l.contractors)}</dd></div>
                    <div className={r.reg < heads(l) ? 'warn' : ''}><dt>At the gate</dt><dd>{r.reg} / {heads(l)}</dd></div>
                    <div><dt>On site now</dt><dd>{r.inside}</dd></div>
                    <div><dt>Man-days this month</dt><dd>{r.days.size}</dd></div>
                    <div><dt>Fixed / month</dt><dd>{r.fixed ? <>{inr(r.fixed)}{heads(l) ? <small className="muted"> · {inr(r.fixed / heads(l))} a head</small> : null}</> : <small className="muted">none</small>}</dd></div>
                  </dl>
                </div>
              );
            })}
          </div>
          <div className="gg-kpis" style={{ margin: '8px 0 0' }}>
            <div className="gg-kpi"><span className="muted">Signed for</span><b data-testid="vs-signed">{signed}</b></div>
            <div className="gg-kpi"><span className="muted">Registered at gate</span><b data-testid="vs-reg">{reg.length}</b></div>
            <div className={`gg-kpi${gap > 0 ? ' warn' : ''}`}><span className="muted">Not yet registered</span><b data-testid="vs-gap">{Math.max(0, gap)}</b></div>
            <div className="gg-kpi"><span className="muted">On site now</span><b data-testid="vs-inside">{inside}</b></div>
          </div>
          {gap > 0 && <small className="muted" data-testid="vs-gap-note">{gap} worker{gap === 1 ? '' : 's'} promised by the contract {gap === 1 ? 'is' : 'are'} not in the gate registry yet, so they cannot be let in by face or badge.</small>}
          {gap < 0 && <small className="muted">{-gap} more registered than signed for. Check the contract or end the extra registrations.</small>}
          {(loose.reg > 0 || loose.fixed > 0) && <small className="muted" data-testid="vs-loose" style={{ display: 'block' }}>Not tied to a category yet: {loose.reg} gate worker{loose.reg === 1 ? '' : 's'}{loose.fixed ? `, ${inr(loose.fixed)} a month of fixed expenses` : ''}. Set “Vendor category” on the worker (Security → Registry) or the fixed expense to count them per category.</small>}
        </>
      )}
      {edit && <RecordModal collection={C.VENDOR_SERVICES} label="Vendor service lines" record={edit} title={edit.id ? 'Edit category' : 'Add a category'} subtitle={`${vendor.name}: what they are signed for`} allowDelete onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh?.(); }} />}
    </div>
  );
}

import React, { useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { KINDS, KIND_NAMES, iconOf, isActive, covers, suggest, fmtWhen, defaultMessage, aboutKind } from '../../lib/serviceNotices.js';
import { notify, notifyMany } from '../../lib/notify.js';

/** The block a unit sits in (properties.zone), for notices that cover only some blocks. */
export function useMyBlock() {
  const { currentUser } = useApp();
  const { records } = useCollection(C.PROPERTIES, 'Properties & Residents');
  return records.find((p) => p.unit === currentUser?.unit)?.zone || '';
}

/**
 * Active service notices as banners at the top of Maintenance. Everyone sees the ones that cover them; staff also get
 * "Post a service notice", "Resolved", and a nudge when several villas report the same thing.
 */
export default function ServiceNotices({ tickets = [], canPost }) {
  const { currentUser } = useApp();
  const { records: notices, save } = useCollection(C.SERVICE_NOTICES, 'Service Notices');
  const { records: props } = useCollection(C.PROPERTIES, 'Properties & Residents');
  const block = useMyBlock();
  const [dlg, setDlg] = useState(null);
  const mine = notices.filter((n) => isActive(n) && (canPost || covers(n, block)));
  const hints = useMemo(() => (canPost ? suggest(tickets, notices) : []), [canPost, tickets, notices]);
  const blocks = useMemo(() => [...new Set(props.map((p) => p.zone).filter(Boolean))].sort(), [props]);

  async function resolve(n) {
    const out = await save({ ...n, status: 'Resolved', resolvedAt: new Date().toISOString() });
    if (out) await tell(n, `${iconOf(n.kind)} ${n.kind} restored`, `${n.kind} is back${n.scope === 'Selected blocks' ? ` in ${(n.blocks || []).join(', ')}` : ''}. Thank you for your patience. If something in your villa is still not working, please raise a request.`, props, currentUser).catch(() => {});
  }
  if (!mine.length && !hints.length && !canPost) return null;
  return (
    <div data-testid="service-notices" style={{ marginBottom: 10 }}>
      {mine.map((n) => (
        <div key={n.id} className="svc-banner" data-testid="svc-notice">
          <span className="svc-ic" aria-hidden="true">{iconOf(n.kind)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>{n.kind}{n.scope === 'Selected blocks' ? ` · ${(n.blocks || []).join(', ')}` : ' · whole community'}</b>
            <div>{n.message}</div>
            <small className="muted">Since {fmtWhen(n.startedAt)}{n.expectedBy ? ` · expected back ${fmtWhen(n.expectedBy)}` : ''}{canPost && n.postedBy ? ` · posted by ${n.postedBy}` : ''}</small>
          </div>
          {canPost && <button type="button" className="btn good sm" data-testid="svc-resolve" onClick={() => resolve(n)}>Resolved</button>}
        </div>
      ))}
      {hints.map((h) => (
        <div key={h.kind} className="svc-banner hint" data-testid="svc-suggest">
          <span className="svc-ic" aria-hidden="true">💡</span>
          <div style={{ flex: 1 }}><b>{h.count} villas reported “{h.kind.toLowerCase()}” in the last 3 hours.</b><div className="muted">If it is a community-wide problem, tell residents so they stop raising separate requests.</div></div>
          <button type="button" className="btn sm" data-testid="svc-suggest-post" onClick={() => setDlg({ kind: h.kind })}>Post a notice</button>
        </div>
      ))}
      {canPost && <button type="button" className="btn secondary sm" data-testid="svc-post" onClick={() => setDlg({})}>📢 Post a service notice</button>}
      {dlg && <PostDialog start={dlg} blocks={blocks} onClose={() => setDlg(null)} onPost={async (n) => {
        const out = await save({ ...n, status: 'Active', startedAt: new Date().toISOString(), postedBy: currentUser?.name || '' });
        if (out) await tell(out, `${iconOf(n.kind)} ${n.kind}${n.scope === 'Selected blocks' ? ` · ${n.blocks.join(', ')}` : ''}`, `${n.message}${n.expectedBy ? ` Expected back ${fmtWhen(n.expectedBy)}.` : ''}`, props, currentUser).catch(() => {});
        setDlg(null);
      }} />}
    </div>
  );
}

/** Tell owners and residents (everyone, or only the units in the chosen blocks) on the channels set for "Service notice". */
async function tell(n, title, body, props, me) {
  const base = { event: 'service_notice', title, body, link: '#/maintenance', by: me?.name || '' };
  if (n.scope === 'Selected blocks') {
    const units = [...new Set(props.filter((p) => (n.blocks || []).includes(p.zone)).map((p) => p.unit))];
    return notifyMany(units.map((u) => ({ ...base, toUnit: u })));
  }
  return notify({ ...base, toRoleIds: ['owner', 'resident'] });
}

function PostDialog({ start, blocks, onPost, onClose }) {
  const [f, setF] = useState({ kind: start.kind || 'Power cut', scope: 'Whole community', blocks: [], expectedBy: '', mode: 'Ask them to confirm', message: '' });
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const where = f.scope === 'Selected blocks' ? `in ${f.blocks.join(', ') || 'some blocks'}` : 'across the community';
  const msg = f.message || defaultMessage(f.kind, where);
  const toggle = (b) => set('blocks', f.blocks.includes(b) ? f.blocks.filter((x) => x !== b) : [...f.blocks, b]);
  return (
    <Modal title="Post a service notice" subtitle="Residents see this before they raise a request, and are told on the channels set for service notices." onClose={onClose}>
      <div className="chip-row" role="group" aria-label="What is affected">
        {KIND_NAMES.map((k) => <button key={k} type="button" className={`chip-btn${f.kind === k ? ' on' : ''}`} aria-pressed={f.kind === k} data-testid={`svc-kind-${k}`} onClick={() => set('kind', k)}>{KINDS[k].icon} {k}</button>)}
      </div>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <div className="field"><label>Where</label><select aria-label="Where" data-testid="svc-scope" value={f.scope} onChange={(e) => set('scope', e.target.value)}><option>Whole community</option><option>Selected blocks</option></select></div>
        <div className="field"><label>Expected back by (optional)</label><input aria-label="Expected back by" type="datetime-local" data-testid="svc-expected" value={f.expectedBy} onChange={(e) => set('expectedBy', e.target.value)} /></div>
        {f.scope === 'Selected blocks' && <div className="field" style={{ gridColumn: '1 / -1' }}><label>Blocks affected</label><div className="chip-row">{blocks.map((b) => <button key={b} type="button" className={`chip-btn${f.blocks.includes(b) ? ' on' : ''}`} aria-pressed={f.blocks.includes(b)} onClick={() => toggle(b)}>{b}</button>)}</div></div>}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Message to residents</label><textarea rows={3} aria-label="Message" data-testid="svc-message" value={f.message} placeholder={msg} onChange={(e) => set('message', e.target.value)} /><small className="muted">Leave blank to use: “{msg}”</small></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>If someone then raises a request about it</label>
          <select aria-label="New requests" data-testid="svc-mode" value={f.mode} onChange={(e) => set('mode', e.target.value)}><option>Ask them to confirm</option><option>Do not accept</option></select>
          <small className="muted">{f.mode === 'Ask them to confirm' ? 'They must tick “only my villa is affected” to continue.' : 'The request is not accepted while the notice is active; they are pointed to the notice.'}</small></div>
      </div>
      {err && <div className="field-error" data-testid="svc-error">{err}</div>}
      <div className="form-actions">
        <button type="button" className="btn" data-testid="svc-go" onClick={() => {
          if (f.scope === 'Selected blocks' && !f.blocks.length) return setErr('Pick at least one block.');
          return onPost({ ...f, message: msg, expectedBy: f.expectedBy ? new Date(f.expectedBy).toISOString() : '' });
        }}>Post and notify</button>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/**
 * In the raise-request form: if what the resident is describing matches an active notice, show it and ask them to confirm
 * (or refuse). `onState` reports { blocked, needsConfirm, confirmed } so the form can validate.
 */
export function OutageGuard({ text, confirmed, onConfirm }) {
  const { records: notices } = useCollection(C.SERVICE_NOTICES, 'Service Notices');
  const block = useMyBlock();
  const hits = notices.filter((n) => isActive(n) && covers(n, block)).filter((n) => (KINDS[n.kind]?.words || []).length && aboutKind(n.kind, text));
  if (!hits.length) return null;
  const hard = hits.some((n) => n.mode === 'Do not accept');
  return (
    <div className="svc-banner guard" style={{ gridColumn: '1 / -1' }} data-testid="outage-guard">
      <span className="svc-ic" aria-hidden="true">{iconOf(hits[0].kind)}</span>
      <div style={{ flex: 1 }}>
        {hits.map((n) => <div key={n.id}><b>{n.kind} is already reported{n.scope === 'Selected blocks' ? ` in ${(n.blocks || []).join(', ')}` : ' across the community'}.</b><div>{n.message}</div><small className="muted">Since {fmtWhen(n.startedAt)}{n.expectedBy ? ` · expected back ${fmtWhen(n.expectedBy)}` : ''}</small></div>)}
        {hard
          ? <div style={{ marginTop: 6 }} data-testid="outage-blocked"><b>You do not need to raise a request.</b> We will tell you when it is fixed. Requests about this are not being accepted right now.</div>
          : <label className="check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 6 }}><input type="checkbox" data-testid="outage-confirm" checked={!!confirmed} onChange={(e) => onConfirm(e.target.checked)} /> <span>This is a different problem — only <b>my villa</b> is affected (my neighbours have {hits[0].kind === 'Water supply' ? 'water' : 'it'}).</span></label>}
      </div>
    </div>
  );
}
/** For submit validation: the active notices this text runs into, and whether the form may proceed. */
export function outageVerdict(notices, { text, block, confirmed }) {
  const hits = notices.filter((n) => isActive(n) && covers(n, block)).filter((n) => aboutKind(n.kind, text));
  if (!hits.length) return { ok: true, hits };
  if (hits.some((n) => n.mode === 'Do not accept')) return { ok: false, hits, error: `${hits[0].kind} is already reported — there is no need for a request. We will tell you when it is fixed.` };
  return confirmed ? { ok: true, hits } : { ok: false, hits, error: 'Please confirm that only your villa is affected, or skip the request — the problem is already reported.' };
}

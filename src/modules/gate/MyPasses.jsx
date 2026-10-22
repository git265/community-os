import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { makeCode, passMessage, passQrText, shareLinks } from '../../lib/gate/engine.js';
import { DAYS, GOODS_KINDS } from '../../lib/gate/constants.js';
import { Chips, PhotoCapture, StateTag } from './gateUi.jsx';
import { QrImage } from './QrImage.jsx';
import { validatePhone } from '../../lib/phone.js';

const ld = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ld(new Date());
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ld(d); };
const blank = (goods = false) => ({ kind: goods ? 'Goods' : 'Guest', visitorName: '', phone: '', type: goods ? 'Goods' : 'One-time', validFrom: todayStr(), validTo: todayStr(), fromTime: '', toTime: '', days: [], vehicle: '', guestCap: 20, photo: '', goodsKind: GOODS_KINDS[0], peopleCount: 2, material: '', carryingOut: false, outItems: '' });

/** The pass, ready to hand over: QR, PIN and one tap to send it by WhatsApp or SMS. */
export function PassShare({ pass, template, community, host }) {
  const text = passMessage(template, pass, { community, host });
  const links = shareLinks(pass.phone, text);
  const [copied, setCopied] = useState(false);
  async function nativeShare() {
    try {
      if (navigator.share) { await navigator.share({ title: 'Gate pass', text }); return; }
    } catch { return; }
    copy();
  }
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ } }
  return (
    <div className="gg-share" data-testid="pass-share">
      <QrImage text={passQrText(pass)} size={170} testid="pass-qr" />
      <div>
        <div className="muted">PIN</div>
        <div style={{ fontSize: 30, letterSpacing: 6, fontWeight: 700 }} data-testid="pass-pin">{pass.code}</div>
        <div className="gg-actions" style={{ flexWrap: 'wrap' }}>
          <a className="btn" data-testid="share-wa" href={links.whatsapp} target="_blank" rel="noreferrer">WhatsApp</a>
          <a className="btn secondary" data-testid="share-sms" href={links.sms}>SMS</a>
          <button type="button" className="btn secondary" data-testid="share-native" onClick={nativeShare}>Share…</button>
          <button type="button" className="btn secondary" data-testid="share-copy" onClick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
        </div>
        {!pass.phone && <small className="muted">Add the guest's mobile number and WhatsApp opens straight to them.</small>}
      </div>
    </div>
  );
}

export default function MyPasses({ unit, name }) {
  const { records: passes, save } = useCollection(COLLECTIONS.GATE_PASSES, 'Guest passes');
  const { records: tpls, save: saveTpl, remove: removeTpl } = useCollection(COLLECTIONS.GATE_PASS_TEMPLATES, 'Pass templates');
  const { records: settings } = useCollection(COLLECTIONS.GATE_SETTINGS, 'Gate settings');
  const { records: cfg } = useCollection(COLLECTIONS.COMMUNITY_CONFIG, 'Community');
  const community = String(cfg[0]?.legalName || 'the community').split(/ Residents| Welfare|’|,/)[0].trim() || 'the community';
  const tmplText = (settings.find((s) => s.id === 'default') || settings[0])?.passMessage;
  const [f, setF] = useState(null); const [err, setErr] = useState(''); const [open, setOpen] = useState(''); const [asTpl, setAsTpl] = useState(''); const [justMade, setJustMade] = useState(null);
  const mine = passes.filter((p) => p.unit === unit).sort((a, b) => String(b.validFrom).localeCompare(String(a.validFrom)) || String(b.id).localeCompare(String(a.id)));
  const tplList = useMemo(() => [...tpls].sort((a, b) => (a.unit ? 1 : 0) - (b.unit ? 1 : 0) || a.name.localeCompare(b.name)), [tpls]);
  const goods = f?.type === 'Goods';
  const set = (k, v) => { setF((s) => ({ ...s, [k]: v })); setErr(''); };
  function applyTemplate(t) {
    const n = Math.max(1, Number(t.validityDays) || 1);
    setF({ ...blank(t.passType === 'Goods'), type: t.passType || 'One-time', visitorName: t.visitorName || '', phone: t.phone || '', validFrom: todayStr(), validTo: plus(n - 1), fromTime: t.fromTime || '', toTime: t.toTime || '', days: t.days || [], guestCap: t.guestCap || 20, vehicle: t.vehicle || '', goodsKind: t.goodsKind || GOODS_KINDS[0], peopleCount: t.peopleCount || 2, material: t.material || '', carryingOut: !!t.carryingOut });
    setErr('');
  }
  async function submit(e) {
    e.preventDefault();
    if (!f.visitorName.trim()) { setErr(goods ? 'Driver or company name is required' : 'Guest name is required'); return; }
    if (String(f.phone || '').trim()) { const v = validatePhone(f.phone); if (!v.ok) { setErr(`${goods ? 'Driver' : 'Guest'} mobile: ${v.error}`); return; } }
    if (f.validTo < f.validFrom) { setErr('Valid until cannot be before valid from'); return; }
    if ((new Date(f.validTo) - new Date(f.validFrom)) / 864e5 > 366) { setErr('A pass lasts a year at most'); return; }
    if (f.type === 'Event' && !(Number(f.guestCap) >= 1 && Number(f.guestCap) <= 2000)) { setErr('Guests allowed is between 1 and 2000'); return; }
    if (goods && !f.vehicle.trim()) { setErr('The vehicle number is required for a goods pass'); return; }
    if (goods && !(Number(f.peopleCount) >= 1)) { setErr('Say how many people will be in the vehicle'); return; }
    if (goods && f.carryingOut && !f.outItems.trim()) { setErr('List the items leaving so the guard can check them'); return; }
    const { kind, ...rest } = f;
    const out = await save({ ...rest, visitorName: f.visitorName.trim(), vehicle: f.vehicle.trim(), unit, code: makeCode(), usedCount: 0, hostName: name, status: 'Active', days: f.type === 'Recurring' ? f.days : [], peopleCount: goods ? Number(f.peopleCount) : undefined });
    if (asTpl.trim()) await saveTpl({ name: asTpl.trim(), unit, passType: f.type, visitorName: f.visitorName.trim(), phone: f.phone, validityDays: Math.max(1, Math.round((new Date(f.validTo) - new Date(f.validFrom)) / 864e5) + 1), fromTime: f.fromTime, toTime: f.toTime, days: f.days, guestCap: f.guestCap, vehicle: f.vehicle, goodsKind: f.goodsKind, peopleCount: f.peopleCount, material: f.material, carryingOut: f.carryingOut });
    setJustMade(out?.id || null); setOpen(out?.id || ''); setF(null); setAsTpl(''); setErr('');
  }
  return (
    <div data-testid="my-passes">
      <div className="gg-row" style={{ justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap' }}>
        <p className="muted hide-sm" style={{ margin: 0 }}>Make a pass, then send the QR and PIN. The guard scans or checks it and the gate lets your guest in without calling you.</p>
        {!f && <div className="gg-actions"><button type="button" className="btn" data-testid="pass-new" onClick={() => setF(blank(false))}>+ Guest pass</button><button type="button" className="btn secondary" data-testid="pass-new-goods" onClick={() => setF(blank(true))}>+ Goods vehicle</button></div>}
      </div>
      {f && (
        <form className="card form-grid" onSubmit={submit} style={{ marginBottom: 14 }} data-testid="pass-form">
          {tplList.length > 0 && (
            <div className="field" style={{ gridColumn: '1 / -1' }} data-testid="tpl-row"><label>Start from a template</label>
              <div className="gg-chips">{tplList.map((t) => <button type="button" key={t.id} data-testid="tpl-chip" onClick={() => applyTemplate(t)}>{t.name}{!t.unit && <small> · community</small>}</button>)}</div></div>
          )}
          <div className="field"><label>Pass for</label><select data-testid="pass-type" value={f.type} onChange={(e) => set('type', e.target.value)}>{['One-time', 'Recurring', 'Event', 'Goods'].map((t) => <option key={t} value={t}>{t === 'Goods' ? 'Goods vehicle' : t}</option>)}</select></div>
          <div className={`field${err && !f.visitorName ? ' invalid' : ''}`}><label>{goods ? 'Driver or company *' : 'Guest name *'}</label><input data-testid="pass-name" value={f.visitorName} onChange={(e) => set('visitorName', e.target.value)} /></div>
          <div className="field"><label>{goods ? 'Driver mobile' : 'Guest mobile'}</label><input type="tel" data-testid="pass-phone" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
          <div className="field"><label>Valid from</label><input type="date" value={f.validFrom} onChange={(e) => set('validFrom', e.target.value)} /></div>
          <div className="field"><label>Valid until</label><input type="date" value={f.validTo} onChange={(e) => set('validTo', e.target.value)} /></div>
          <div className="field"><label>Time from</label><input type="time" value={f.fromTime} onChange={(e) => set('fromTime', e.target.value)} /></div>
          <div className="field"><label>Time to</label><input type="time" value={f.toTime} onChange={(e) => set('toTime', e.target.value)} /></div>
          {f.type === 'Recurring' && <div className="field" style={{ gridColumn: '1 / -1' }}><label>Days</label><Chips multi options={DAYS} value={f.days} onChange={(v) => set('days', v)} label="Days" /></div>}
          {f.type === 'Event' && <div className="field"><label>Guests allowed</label><input type="number" min="1" max="2000" value={f.guestCap} onChange={(e) => set('guestCap', Number(e.target.value))} /></div>}
          <div className="field"><label>Vehicle number{goods ? ' *' : ''}</label><input data-testid="pass-vehicle" value={f.vehicle} onChange={(e) => set('vehicle', e.target.value)} /></div>
          {goods && (
            <>
              <div className="field"><label>What for</label><select data-testid="pass-goodskind" value={f.goodsKind} onChange={(e) => set('goodsKind', e.target.value)}>{GOODS_KINDS.map((k) => <option key={k}>{k}</option>)}</select></div>
              <div className="field"><label>People in the vehicle (driver included) *</label><input type="number" min="1" data-testid="pass-people" value={f.peopleCount} onChange={(e) => set('peopleCount', e.target.value)} /></div>
              <div className="field"><label>Material</label><input data-testid="pass-material" value={f.material} onChange={(e) => set('material', e.target.value)} placeholder="e.g. sofa set, cement bags" /></div>
              <label className="gg-row" style={{ gridColumn: '1 / -1' }}><input type="checkbox" data-testid="pass-carryout" checked={f.carryingOut} onChange={(e) => set('carryingOut', e.target.checked)} style={{ width: 'auto' }} /> Items will leave the community (this is the out-pass)</label>
              {f.carryingOut && <div className="field" style={{ gridColumn: '1 / -1' }}><label>Items leaving *</label><input data-testid="pass-outitems" value={f.outItems} onChange={(e) => set('outItems', e.target.value)} placeholder="e.g. old sofa, 6 boxes" /></div>}
            </>
          )}
          {!goods && <div className="field" style={{ gridColumn: '1 / -1' }}><PhotoCapture label="Guest photo (optional)" value={f.photo} onChange={(v) => set('photo', v)} demoName={f.visitorName} testid="pass-photo" /></div>}
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Save as a template (optional)</label><input data-testid="tpl-name" value={asTpl} onChange={(e) => setAsTpl(e.target.value)} placeholder="e.g. Cook, every morning" /></div>
          {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
          <div className="form-actions"><button className="btn" type="submit" data-testid="pass-save">Create pass</button><button type="button" className="btn secondary" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      )}
      {mine.length === 0 ? <div className="empty">No passes yet.</div> : mine.map((p) => (
        <div className="gg-card col" key={p.id} data-testid="pass-row">
          <div className="gg-row" style={{ width: '100%', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen(open === p.id ? '' : p.id)}>
            <div className="gg-main"><b>{p.visitorName} <StateTag state={p.status} /> {p.type === 'Goods' && <span className="tag">🚚 {p.vehicle}</span>}</b>
              <span className="muted">{p.type === 'Goods' ? `${p.goodsKind || 'Goods'} · ${p.peopleCount || '?'} people` : p.type} · {p.validFrom}{p.validTo !== p.validFrom ? ` to ${p.validTo}` : ''}{p.fromTime ? ` · ${p.fromTime}–${p.toTime}` : ''}{p.type === 'Recurring' && p.days?.length ? ` · ${p.days.join(', ')}` : ''}</span></div>
            <span>PIN <b data-testid="pass-code" style={{ letterSpacing: 2 }}>{p.code}</b></span>
          </div>
          {open === p.id && (
            <div style={{ width: '100%' }} data-testid="pass-open">
              {p.status === 'Active' && <PassShare pass={p} template={tmplText} community={community} host={name} />}
              <small className="muted">Used {p.usedCount || 0}×{p.type === 'Goods' && p.carryingOut ? ` · out-pass: ${p.outItems}` : ''}</small>
              {p.status === 'Active' && <div className="gg-actions"><button type="button" className="btn secondary sm" onClick={() => save({ ...p, status: 'Cancelled' })}>Cancel pass</button></div>}
            </div>
          )}
        </div>
      ))}
      {tplList.some((t) => t.unit === unit) && (
        <details style={{ marginTop: 12 }} data-testid="tpl-manage"><summary>My templates</summary>
          {tplList.filter((t) => t.unit === unit).map((t) => <div className="gg-check" key={t.id}><span style={{ flex: 1 }}>{t.name} <small className="muted">· {t.passType}</small></span><button type="button" className="link-btn" onClick={() => removeTpl(t)}>Delete</button></div>)}
        </details>
      )}
    </div>
  );
}

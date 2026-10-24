import React, { useEffect, useState } from 'react';
import { GATE_EVENTS, DELIVERY_COMPANIES, FALLBACKS, DEFAULT_DURATIONS, DEFAULT_SETTINGS, PATROL_NFC } from '../../lib/gate/constants.js';
import { getSettings, saveSettings } from '../../lib/gate/engine.js';
import { Chips } from './gateUi.jsx';

const WHO = { villa: 'The villa', fm: 'Facility Manager', 'villa+security': 'Villa and security', 'security+manager': 'Security and manager', manager: 'Security manager and EC' };
export default function GateRules({ canEdit = false }) {
  const [s, setS] = useState(null); const [saved, setSaved] = useState('');
  useEffect(() => { getSettings().then(setS); }, []);
  if (!s) return null;
  const set = (k, v) => { setS((x) => ({ ...x, [k]: v })); setSaved(''); };
  const num = (k, label, hint) => <div className="field"><label>{label}</label><input type="number" min="0" disabled={!canEdit} data-testid={`set-${k}`} value={s[k] ?? ''} onChange={(e) => set(k, Number(e.target.value))} />{hint && <small className="muted">{hint}</small>}</div>;
  const ev = (id, patch) => set('events', { ...s.events, [id]: { ...(s.events[id] || {}), ...patch } });
  async function save() { await saveSettings(s); setSaved('Saved. New rules apply from the next visit.'); }
  return (
    <div data-testid="gate-rules">
      {!canEdit && <div className="notice">These are the community's gate rules. Only the committee can change them.</div>}
      <div className="card" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Approvals and flags</h2>
        <div className="form-grid">
          {num('waitSeconds', 'Seconds to wait for a resident', 'Then the villa\'s own rule applies.')}
          <div className="field"><label>If nobody answers</label><select disabled={!canEdit} value={s.fallback} onChange={(e) => set('fallback', e.target.value)}>{FALLBACKS.map((f) => <option key={f}>{f}</option>)}</select></div>
          <div className="field"><label>Quiet hours</label><div className="gg-row"><input type="time" disabled={!canEdit} value={s.quietFrom} onChange={(e) => set('quietFrom', e.target.value)} /> to <input type="time" disabled={!canEdit} value={s.quietTo} onChange={(e) => set('quietTo', e.target.value)} /></div></div>
          <div className="field"><label>At night, if nobody answers</label><select disabled={!canEdit} value={s.quietFallback} onChange={(e) => set('quietFallback', e.target.value)}>{FALLBACKS.map((f) => <option key={f}>{f}</option>)}</select></div>
          {num('graceSeconds', 'Ghost flag grace window (seconds)', 'A guard who registers the person inside this time clears it without noise. Use 120 to 180 in real life.')}
          {num('overstayGraceMinutes', 'Overstay grace (minutes)')}
          {num('guardSilenceMinutes', 'Guard silence alert after (minutes)', 'A clocked-in guard whose gate screen shows no activity for this long raises a flag. 0 turns it off.')}
          {num('autoCloseHours', 'Auto-close pass visits after (hours past expected exit)')}
          {num('photoRetentionDays', 'Keep gate photos (days)')}
        </div>
      </div>
      <div className="card" style={{ marginBottom: 14 }} data-testid="rules-goods">
        <h2 style={{ marginTop: 0 }}>Kiosk, goods vehicles and patrol</h2>
        <div className="form-grid">
          <label className="gg-row" style={{ gridColumn: '1 / -1' }}><input type="checkbox" data-testid="set-kioskOn" disabled={!canEdit} checked={!!s.kioskOn} onChange={(e) => set('kioskOn', e.target.checked)} style={{ width: 'auto' }} /> A face kiosk opens the gate for approved visitors (the guard then opens by hand only with a reason, and it is flagged)</label>
          <div className="field"><label>More people than a goods pass allows</label><select disabled={!canEdit} data-testid="set-goodsExtra" value={s.goodsExtraPeople} onChange={(e) => set('goodsExtraPeople', e.target.value)}><option>Block until the guard confirms</option><option>Let in and flag</option></select></div>
          {num('patrolMinSeconds', 'Least seconds between two checkpoint scans', 'Stops one person scanning every post from a photo at the same spot.')}
          <div className="field"><label>NFC tags on patrol posts (optional)</label>
            <select disabled={!canEdit} data-testid="set-patrolNfc" value={s.patrolNfc || 'Off'} onChange={(e) => set('patrolNfc', e.target.value)}>{PATROL_NFC.map((o) => <option key={o}>{o}</option>)}</select>
            <small className="muted">{{ Off: 'Posts are proved by their printed QR code.', 'Tag or QR': 'A guard taps the post\'s NFC tag or scans its QR code; either counts.', 'Tag where fitted': 'A post with a tag takes only the tag (a photo of its QR does not count). Guards need Android phones with NFC.' }[s.patrolNfc || 'Off']}</small></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Pass message (WhatsApp / SMS)</label><textarea rows={4} disabled={!canEdit} data-testid="set-passMessage" value={s.passMessage || DEFAULT_SETTINGS.passMessage} onChange={(e) => set('passMessage', e.target.value)} /><small className="muted">Fields: {'{guest} {host} {unit} {community} {pin} {date} {time} {vehicle} {gate} {qr}'} - {'{qr}'} is a link that opens the QR; it is added at the end when the message does not place it</small></div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Expected time inside (minutes)</h2>
        <div className="form-grid">{Object.entries({ ...DEFAULT_DURATIONS, ...s.durations }).filter(([k]) => k !== 'Resident vehicle').map(([k, v]) => <div className="field" key={k}><label>{k}</label><input type="number" min="0" disabled={!canEdit} value={v} onChange={(e) => set('durations', { ...s.durations, [k]: Number(e.target.value) })} /></div>)}</div>
        <small className="muted">Maids, drivers and crew use their allowed hours instead.</small>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Approved delivery companies</h2>
        <p className="muted hide-sm">A rider from a company that is not on this list always goes to live approval, whatever the villa chose.</p>
        {canEdit ? <Chips multi options={DELIVERY_COMPANIES} value={s.approvedCompanies} onChange={(v) => set('approvedCompanies', v)} label="Approved companies" /> : <p>{s.approvedCompanies.join(', ')}</p>}
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Who is told, and with a photo?</h2>
        <p className="muted hide-sm">Defaults for the whole community. Each villa can switch the optional ones on or off in My Gate. Locked rows cannot be switched off.</p>
        <div className="table-wrap"><table><thead><tr><th>Event</th><th>Told</th><th>On</th><th>Photo</th></tr></thead><tbody>
          {GATE_EVENTS.map((e) => { const c = s.events[e.id] || { on: true, photo: e.photo }; return (
            <tr key={e.id} data-testid={`ev-${e.id}`}><td>{e.label}{e.locked && <span className="tag" style={{ marginLeft: 6 }}>locked</span>}</td><td>{WHO[e.to] || e.to}</td>
              <td><input type="checkbox" aria-label={`${e.label} on`} disabled={!canEdit || e.locked} checked={e.locked ? true : c.on !== false} onChange={(x) => ev(e.id, { on: x.target.checked })} /></td>
              <td><input type="checkbox" aria-label={`${e.label} photo`} disabled={!canEdit || e.id === 'approval'} checked={e.id === 'approval' ? true : c.photo !== false} onChange={(x) => ev(e.id, { photo: x.target.checked })} /></td></tr>); })}
        </tbody></table></div>
      </div>
      {canEdit && <div className="form-actions"><button type="button" className="btn" data-testid="rules-save" onClick={save}>Save rules</button>{saved && <span className="muted" data-testid="rules-saved" style={{ marginLeft: 10 }}>{saved}</span>}</div>}
    </div>
  );
}

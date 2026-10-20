import React, { useEffect, useRef, useState } from 'react';
import { communityTaxId } from '../../lib/locale.js';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { Segmented } from '../../components/ui.jsx';
import { EVENTS, CHANNELS, TOKENS, renderTemplate, bookingVars, buildReport, addDays, inr } from '../../lib/amenityEngine.js';
import { sendReport } from '../../lib/amenityServer.js';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import RichText from '../../components/RichText.jsx';
import { looksLikeHtml } from '../../lib/richtext/sanitize.js';

const Need = ({ children }) => <div className="notice" style={{ marginBottom: 8 }}>🔒 {children} — ask a Super Admin to grant <b>MANAGE_NOTIFICATIONS</b> to your role (Roles &amp; Permissions).</div>;
const SAMPLE = { shortId: 'AMN-1042', amenity: 'Clubhouse', date: '2026-10-20', slot: 'Full day', unit: 'Villa 135', rate: 2500, baseAmount: 2500, gstRate: 18, gstAmount: 450, feeTotal: 2950, depositAmount: 5000, totalPayable: 7950, paymentMode: 'UPI', paymentStatus: 'Paid', refundAmount: 3475, refundPct: 50, retainedAmount: 1475 };

/** Recipient list editor: channel + target + label rows. */
function Recipients({ title, hint, rows, onChange, disabled, testid }) {
  const list = Array.isArray(rows) ? rows : [];
  const set = (i, k, v) => onChange(list.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div data-testid={testid} style={{ marginBottom: 12 }}>
      <h4 style={{ margin: '8px 0 2px' }}>{title}</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{hint}</div>
      {list.map((r, i) => (
        <div key={i} className="cols-2" style={{ marginBottom: 6, gridTemplateColumns: '110px 1fr 1fr auto' }}>
          <select aria-label={`${title} ${i + 1} channel`} value={r.channel} disabled={disabled} onChange={(e) => set(i, 'channel', e.target.value)}>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</select>
          <input aria-label={`${title} ${i + 1} target`} placeholder={r.channel === 'Email' ? 'name@example.com' : r.channel === 'WhatsApp' ? '+91… or group name' : '+91…'} value={r.target || ''} disabled={disabled} onChange={(e) => set(i, 'target', e.target.value)} />
          <input aria-label={`${title} ${i + 1} label`} placeholder="Label" value={r.label || ''} disabled={disabled} onChange={(e) => set(i, 'label', e.target.value)} />
          <button type="button" className="btn secondary sm" disabled={disabled} aria-label={`Remove ${title} ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="btn secondary sm" disabled={disabled} onClick={() => onChange([...list, { channel: 'WhatsApp', target: '', label: '' }])}>＋ Add recipient</button>
    </div>
  );
}

const toEditorHtml = (b) => (looksLikeHtml(b) ? b : esc(b || '').replace(/\n/g, '<br>'));
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function TemplateCard({ tpl, community, settings, canEdit, onSave }) {
  const [d, setD] = useState(tpl);
  const ref = useRef(null);
  const wrap = useRef(null);
  useEffect(() => setD(tpl), [tpl.id, tpl.recVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = d.body !== tpl.body || d.subject !== tpl.subject || !!d.enabled !== !!tpl.enabled;
  const isReport = /report/.test(tpl.event);
  const isEmail = tpl.channel === 'Email';
  const vars = isReport ? { community, report: '(report text appears here)', report_period: '2026-10-11', gstin: communityTaxId() } : bookingVars(SAMPLE, { community, settings, owner: 'Ananya Mehta', reason: 'Sample reason', extra: {} });
  const insert = (tok) => {
    if (!canEdit) return;
    if (isEmail) { const ed = wrap.current?.querySelector('[contenteditable]'); if (ed) { ed.focus(); document.execCommand('insertText', false, tok); } return; }
    const el = ref.current; const at = el ? el.selectionStart : d.body.length;
    setD((x) => ({ ...x, body: `${x.body.slice(0, at)}${tok}${x.body.slice(at)}` }));
  };
  const key = `${tpl.event}-${tpl.channel}-${tpl.audience}`;
  const previewBody = renderTemplate(d.body, vars);
  return (
    <div className="tpl-card" data-testid={`tpl-${tpl.event}-${tpl.channel}-${tpl.audience}`}>
      <div className="tpl-head">
        <b>{tpl.channel} → {tpl.audience === 'Owner' ? 'Owner / resident' : isReport ? 'Report recipients' : 'Admin recipients'}</b>
        <label className="tpl-on"><input type="checkbox" aria-label={`${tpl.event} ${tpl.channel} ${tpl.audience} on`} checked={!!d.enabled} disabled={!canEdit} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> On</label>
      </div>
      {isEmail && (
        <div className="field tpl-field"><label htmlFor={`sub-${key}`}>Subject</label>
          <input id={`sub-${key}`} aria-label={`${tpl.event} ${tpl.audience} subject`} value={d.subject || ''} disabled={!canEdit} placeholder="Subject line, e.g. Booking {{booking_no}} confirmed" onChange={(e) => setD({ ...d, subject: e.target.value })} /></div>
      )}
      <div className="field tpl-field" ref={wrap}><label htmlFor={`msg-${key}`}>Message{isEmail ? ' (formatting is kept in e-mail)' : tpl.channel === 'WhatsApp' ? ' (WhatsApp: *bold*  _italic_)' : ' (plain text)'}</label>
        {isEmail ? (
          canEdit
            ? <div aria-label={`${tpl.event} ${tpl.channel} ${tpl.audience} message`}><RichTextEditor id={`msg-${key}`} value={toEditorHtml(d.body)} onChange={(h) => setD((x) => ({ ...x, body: h }))} placeholder="Write the e-mail…" minHeight={150} /></div>
            : <RichText html={toEditorHtml(d.body)} className="rte-readonly" />
        ) : (
          <textarea id={`msg-${key}`} ref={ref} rows={6} aria-label={`${tpl.event} ${tpl.channel} ${tpl.audience} message`} value={d.body || ''} disabled={!canEdit} onChange={(e) => setD({ ...d, body: e.target.value })} />
        )}
      </div>
      {canEdit && <div className="token-row" aria-label="Insert field"><span className="muted" style={{ fontSize: 12 }}>Insert:</span>{TOKENS.map((t) => <code key={t} onClick={() => insert(t)}>{t}</code>)}</div>}
      <details><summary className="muted" style={{ fontSize: 12 }}>Preview with sample data</summary>
        {isEmail && d.subject ? <p style={{ margin: '6px 0 2px' }}><b>Subject:</b> {renderTemplate(d.subject, vars)}</p> : null}
        {isEmail ? <div className="report-preview" style={{ maxHeight: 220 }}><RichText html={toEditorHtml(previewBody)} /></div> : <pre className="report-preview" style={{ maxHeight: 180 }}>{previewBody}</pre>}
      </details>
      {canEdit && <button type="button" className="btn sm" disabled={!dirty} onClick={() => onSave(d)}>Save template</button>}
    </div>
  );
}

/** Notifications (templates, recipients, outbox) and Reports (preview, send, schedule). Edits need MANAGE_NOTIFICATIONS. */
export default function AmenityNotifications({ mode }) {
  const { roleId, hasPermission, community } = useApp();
  const canEdit = roleId === 'super_admin' || hasPermission('MANAGE_NOTIFICATIONS');
  const cname = community?.name || 'Community';
  const { records: templates, save: saveTpl } = useCollection(COLLECTIONS.NOTIFICATION_TEMPLATES, 'Notification Templates');
  const { records: settingsRows, save: saveSettings } = useCollection(COLLECTIONS.AMENITY_SETTINGS, 'Amenity Settings');
  const { records: outbox, refresh } = useCollection(COLLECTIONS.NOTIFICATION_OUTBOX, 'Notification Outbox');
  const { records: bookings } = useCollection(COLLECTIONS.AMENITIES, 'Amenity Bookings');
  const [sub, setSub] = useState('templates');
  const [kind, setKind] = useState('daily');
  const [sd, setSd] = useState(null);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState('');
  useEffect(() => { if (settingsRows[0]) setSd({ ...settingsRows[0] }); }, [settingsRows[0]?.id, settingsRows[0]?.recVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!sd) return <div className="empty">Loading…</div>;
  const set = (k, v) => setSd((x) => ({ ...x, [k]: v }));
  const keys = (ks) => ks.reduce((o, k) => ({ ...o, [k]: sd[k] }), {});
  async function persist(ks, ok) { const out = await saveSettings({ ...settingsRows[0], ...keys(ks) }); setMsg(out ? ok : ''); }
  async function saveOne(t) { const out = await saveTpl(t); setMsg(out ? 'Template saved' : ''); }

  if (mode === 'reports') {
    const t0 = new Date().toISOString().slice(0, 10);
    const span = sd.summaryReport === 'Monthly' ? 30 : 7;
    const rep = buildReport(kind, { bookings, community: cname, settings: sd, today: t0, from: kind === 'daily' ? t0 : addDays(t0, -span), to: t0 });
    const send = async () => { const r = await sendReport(kind); window.dispatchEvent(new CustomEvent('communityos:changed')); refresh?.(); setMsg(`Report queued to ${r.queued} recipient${r.queued === 1 ? '' : 's'}`); };
    return (
      <div>
        {msg && <div className="notice" data-testid="notif-msg">✔ {msg}</div>}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Report preview</h3>
          <Segmented label="Report type" options={[{ value: 'daily', label: 'Daily' }, { value: 'summary', label: 'Summary' }]} value={kind} onChange={setKind} />
          <pre className="report-preview" data-testid="report-preview" style={{ marginTop: 10 }}>{rep.text}</pre>
          <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>Net received {inr(rep.money.net)} · plain text, so it reads the same in WhatsApp, SMS and e-mail.</div>
          <button type="button" className="btn" data-testid="send-report" disabled={!canEdit} onClick={send}>Send now to report recipients</button>
          {!canEdit && <Need>Only roles with notification access can send reports</Need>}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Schedule &amp; recipients</h3>
          {!canEdit && <Need>Schedules and recipients are locked for your role</Need>}
          <div className="cols-2">
            <label><span>Daily report</span><select aria-label="Daily report" value={sd.dailyReport ? 'On' : 'Off'} disabled={!canEdit} onChange={(e) => set('dailyReport', e.target.value === 'On')}><option>On</option><option>Off</option></select></label>
            <label><span>Daily report time</span><input type="time" aria-label="Daily report time" value={sd.dailyReportTime || '20:00'} disabled={!canEdit} onChange={(e) => set('dailyReportTime', e.target.value)} /></label>
            <label><span>Summary report</span><select aria-label="Summary report" value={sd.summaryReport || 'Off'} disabled={!canEdit} onChange={(e) => set('summaryReport', e.target.value)}><option>Off</option><option>Weekly</option><option>Monthly</option></select></label>
          </div>
          <Recipients testid="report-recipients" title="Report recipients" hint="WhatsApp group name/number, e-mail list or SMS number that receive the daily and summary reports." rows={sd.reportRecipients} disabled={!canEdit} onChange={(v) => set('reportRecipients', v)} />
          <button type="button" className="btn" data-testid="save-report-settings" disabled={!canEdit} onClick={() => persist(['dailyReport', 'dailyReportTime', 'summaryReport', 'reportRecipients'], 'Report schedule saved')}>Save schedule</button>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Reports are generated by the scheduler when the app is open; in production the Spring Boot job runs them on the clock.</div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Report message templates</h3>
          {templates.filter((t) => /report/.test(t.event)).map((t) => <TemplateCard key={t.id} tpl={t} community={cname} settings={sd} canEdit={canEdit} onSave={saveOne} />)}
        </div>
      </div>
    );
  }

  const bookingEvents = EVENTS.filter((e) => !/report/.test(e.id));
  return (
    <div>
      {msg && <div className="notice" data-testid="notif-msg">✔ {msg}</div>}
      <Segmented label="Notification section" options={[{ value: 'templates', label: 'Templates' }, { value: 'recipients', label: 'Recipients' }, { value: 'outbox', label: 'Outbox', count: outbox.length }]} value={sub} onChange={setSub} />
      <div style={{ height: 10 }} />
      {sub === 'templates' && (
        <div>
          {!canEdit && <Need>Templates are read-only for your role</Need>}
          {bookingEvents.map((ev) => {
            const rows = templates.filter((t) => t.event === ev.id);
            return (
              <div className="card" key={ev.id} data-testid={`event-${ev.id}`}>
                <button type="button" className="linklike" aria-expanded={open === ev.id} onClick={() => setOpen(open === ev.id ? '' : ev.id)} style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', width: '100%' }}>
                  <b>{open === ev.id ? '▾' : '▸'} {ev.label}</b> <span className="muted" style={{ fontSize: 12 }}>· {rows.filter((r) => r.enabled).length}/{rows.length} on</span>
                  <div className="muted" style={{ fontSize: 12 }}>{ev.hint}</div>
                </button>
                {open === ev.id && <div style={{ marginTop: 8 }}>{rows.map((t) => <TemplateCard key={t.id} tpl={t} community={cname} settings={sd} canEdit={canEdit} onSave={saveOne} />)}</div>}
              </div>
            );
          })}
        </div>
      )}
      {sub === 'recipients' && (
        <div className="card">
          {!canEdit && <Need>Recipients are locked for your role</Need>}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" aria-label="Notify owner" checked={sd.notifyOwner !== false} disabled={!canEdit} onChange={(e) => set('notifyOwner', e.target.checked)} /> Notify the owner / booking unit</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" aria-label="Notify admin" checked={sd.notifyAdmin !== false} disabled={!canEdit} onChange={(e) => set('notifyAdmin', e.target.checked)} /> Notify admin recipients</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" aria-label="Day-before reminder" checked={!!sd.reminderOn} disabled={!canEdit} onChange={(e) => set('reminderOn', e.target.checked)} /> Day-before reminder to the owner</label>
          <Recipients testid="admin-recipients" title="Admin recipients" hint="Receive a booking summary for every booking, cancellation, payment and refund (channels need an enabled template)." rows={sd.adminRecipients} disabled={!canEdit} onChange={(v) => set('adminRecipients', v)} />
          <label><span>In-app bell goes to roles (comma separated role ids)</span><input aria-label="In-app roles" value={(sd.inAppRoleIds || []).join(', ')} disabled={!canEdit} onChange={(e) => set('inAppRoleIds', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></label>
          <div style={{ marginTop: 10 }}><button type="button" className="btn" data-testid="save-recipients" disabled={!canEdit} onClick={() => persist(['notifyOwner', 'notifyAdmin', 'reminderOn', 'adminRecipients', 'inAppRoleIds'], 'Recipients saved')}>Save recipients</button></div>
        </div>
      )}
      {sub === 'outbox' && (
        <div className="card" data-testid="outbox">
          <div className="notice">ℹ️ Demo mode: messages are queued here and <b>not delivered</b>. The Spring Boot service plugs in SMTP, an SMS gateway and the WhatsApp Business API to send these rows.</div>
          {[...outbox].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 60).map((o) => (
            <div className="outbox-row" key={o.id}>
              <b>{o.channel}</b> → {o.toLabel || o.to} <span className="muted" style={{ fontSize: 12 }}>· {o.audience} · {String(o.createdAt || '').slice(0, 16).replace('T', ' ')}</span>
              <div className="muted" style={{ fontSize: 12 }}>{o.status}{o.to ? ` · ${o.to}` : ''}</div>
              <pre>{o.subject ? `${o.subject}\n` : ''}{o.body}</pre>
            </div>
          ))}
          {!outbox.length && <div className="empty">Nothing queued yet.</div>}
        </div>
      )}
    </div>
  );
}

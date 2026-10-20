import AdminDelete from '../../components/AdminDelete.jsx';
import { notify, notifyMany } from '../../lib/notify.js';
import React, { useState } from 'react';
import { takeHint } from '../../lib/openHint.js';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canEdit } from '../../lib/access/permissions.js';
import ForumPanel from './ForumPanel.jsx';
import NoticeTemplateDesigner from './NoticeTemplateDesigner.jsx';
import AudiencePicker from './AudiencePicker.jsx';
import PollCard from './PollCard.jsx';
import EVoting from './EVoting.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import RichText from '../../components/RichText.jsx';
import NoticeList from '../../components/NoticeList.jsx';
import { TagsInput } from '../../components/DynamicForm.jsx';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';

const TYPES = ['Announcement', 'Emergency alert', 'Notice', 'Scheduled maintenance', 'Poll'];
const timeLabel = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const whenText = (b) => `${new Date(b.eventDate + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}${b.startTime ? `, ${timeLabel(b.startTime)}${b.endTime ? ` – ${timeLabel(b.endTime)}` : ''}` : ''}`;
const AUDIENCES = ['All residents', 'Owners', 'All villas', 'All apartments', 'Selected villas', 'Selected apartments', 'Selected blocks', 'EC members', 'Staff'];
const BLANK = { type: 'Notice', audience: 'All residents', audienceUnits: [], audienceBlocks: [], subject: '', message: '', requiresSignature: false, reminderFrequency: 'None', pollOptions: ['', ''], pollMultiple: false, pollClosesOn: '', eventDate: '', startTime: '', endTime: '', affects: '' };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
const REMINDER_FREQS = ['None', 'Daily', 'Every 3 days', 'Weekly'];

/** The units an audience addresses (null = not a unit-based audience). Block, villa and apartment audiences are expanded from the unit directory. */
const unitsFor = (audience, units, blocks, props) => (audience === 'Selected villas' || audience === 'Selected apartments' ? (units || [])
  : audience === 'Selected blocks' ? props.filter((x) => (blocks || []).includes(x.zone)).map((x) => x.unit)
    : audience === 'All villas' ? props.filter((x) => x.type === 'Villa').map((x) => x.unit)
      : audience === 'All apartments' ? props.filter((x) => x.type === 'Apartment').map((x) => x.unit) : null);

function reachFor(draft, properties) {
  const occupied = (p) => p.occupancy !== 'Vacant';
  switch (draft.audience) {
    case 'Selected villas':
    case 'Selected apartments':
      return properties.filter((p) => draft.audienceUnits.includes(p.unit) && occupied(p)).length;
    case 'Selected blocks':
      return properties.filter((p) => (draft.audienceBlocks || []).includes(p.zone) && occupied(p)).length;
    case 'All villas':
      return properties.filter((p) => p.type === 'Villa' && occupied(p)).length;
    case 'All apartments':
      return properties.filter((p) => p.type === 'Apartment' && occupied(p)).length;
    case 'All residents':
    case 'Owners':
      return properties.filter(occupied).length;
    default:
      return null;
  }
}

function renderTemplate(body, values) {
  let out = body;
  for (const [token, value] of Object.entries(values)) {
    out = out.split(token).join(value || `[${token}]`);
  }
  return out;
}

export default function CommunicationsModule() {
  const { roleId, currentUser, schemaFor, tabAllowed } = useApp();
  const { records: broadcasts, save: saveBroadcast } = useCollection(COLLECTIONS.BROADCASTS, 'Communications');
  const { records: properties } = useCollection(COLLECTIONS.PROPERTIES, 'Properties');
  const { records: blocksList } = useCollection(COLLECTIONS.BLOCKS, 'Blocks & Towers');
  const { records: templates } = useCollection(COLLECTIONS.NOTICE_TEMPLATES, 'Notice Templates');
  const { records: mergeFields } = useCollection(COLLECTIONS.MERGE_FIELDS, 'Merge Field Library');

  const schema = schemaFor(COLLECTIONS.BROADCASTS);
  const canBroadcast = !!schema?.fields.find((f) => f.key === 'subject') && canEdit(schema.fields.find((f) => f.key === 'subject'), roleId);

  const [draft, setDraft] = useState(BLANK);
  const [templateId, setTemplateId] = useState('');
  const [fieldValues, setFieldValues] = useState({});
  const [errs, setErrs] = useState({});
  const ALL_TABS = [['announce', 'Announcements & polls'], ['notices', 'Notices'], ['evote', 'E-voting'], ['templates', 'Announcement templates'], ['forum', 'Forum']];
  const tabs = ALL_TABS.filter(([id]) => tabAllowed(`comms.${id}`) && !(id === 'templates' && !canBroadcast));
  const [tabRaw, setTab] = useState(() => takeHint(['announce', 'notices', 'evote', 'templates', 'forum']) || 'announce');
  const tab = tabs.some(([id]) => id === tabRaw) ? tabRaw : tabs[0]?.[0];

  const reach = reachFor(draft, properties);
  const usableTemplates = templates.filter((t) => !t.appliesTo || t.appliesTo === 'Any' || t.appliesTo === 'Announcement');
  const template = usableTemplates.find((t) => t.id === templateId);
  const isPoll = draft.type === 'Poll';
  const isMaint = draft.type === 'Scheduled maintenance';
  const todayStr = new Date().toISOString().slice(0, 10);
  const upcoming = broadcasts.filter((b) => b.status === 'Sent' && b.eventDate && b.eventDate >= todayStr).sort((a, b) => (a.eventDate + (a.startTime || '')).localeCompare(b.eventDate + (b.startTime || '')));
  const [resch, setResch] = useState(null);
  async function reschedule() {
    if (!resch.eventDate || !resch.startTime) return;
    if (resch.endTime && resch.endTime <= resch.startTime) return;
    const b = broadcasts.find((x) => x.id === resch.id);
    const ok = await saveBroadcast({ ...b, eventDate: resch.eventDate, startTime: resch.startTime, endTime: resch.endTime });
    if (ok) {
      const msg = { event: 'announcement', title: `RESCHEDULED - ${b.subject} (${whenText(resch)})`, body: 'The maintenance time has changed. Please note the new schedule.', link: '#/communications', by: currentUser?.name || '' };
      const units = unitsFor(b.audience, b.audienceUnits, b.audienceBlocks, properties);
      if (units) await notifyMany(units.map((u) => ({ ...msg, toUnit: u })));
      else await notify({ ...msg, toRoleIds: b.audience === 'Owners' ? ['owner'] : ['owner', 'resident'] });
    }
    setResch(null);
  }
  const pickerKind = draft.audience === 'Selected villas' ? 'Villa' : draft.audience === 'Selected apartments' ? 'Apartment' : null;
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  function pickTemplate(id) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const initial = {};
    for (const f of mergeFields) initial[f.token] = f.defaultValue || '';
    setFieldValues(initial);
    setDraft((d) => ({ ...d, subject: t.headerText || d.subject }));
  }

  const previewBody = template ? esc(renderTemplate(template.body, fieldValues)) : draft.message;

  async function send(status) {
    const er = {};
    const options = draft.pollOptions.map((o) => o.trim()).filter(Boolean);
    if (!draft.subject.trim()) er.subject = isPoll ? 'Poll question is required' : 'Subject is required';
    if (!isPoll && !template && isEmptyHtml(draft.message)) er.message = 'Message is required';
    if (pickerKind && draft.audienceUnits.length === 0) er.audience = `Choose at least one ${pickerKind.toLowerCase()}`;
    if (draft.audience === 'Selected blocks' && !(draft.audienceBlocks || []).length) er.audience = 'Choose at least one block';
    if (isMaint && !draft.eventDate) er.eventDate = 'Choose the maintenance date';
    if (isMaint && !draft.startTime) er.startTime = 'Give the start time';
    if (isMaint && draft.endTime && draft.startTime && draft.endTime <= draft.startTime) er.startTime = 'The end time must be after the start time';
    if (isPoll && options.length < 2) er.poll = 'A poll needs at least two answers';
    if (isPoll && new Set(options.map((o) => o.toLowerCase())).size !== options.length) er.poll = 'Poll answers must be different from each other';
    setErrs(er);
    if (Object.keys(er).length) return;
    const recipients = reach ?? 0;
    const ok = await saveBroadcast({
      type: draft.type, audience: draft.audience, audienceUnits: unitsFor(draft.audience, draft.audienceUnits, draft.audienceBlocks, properties) || [], audienceBlocks: draft.audience === 'Selected blocks' ? draft.audienceBlocks : [], subject: draft.subject.trim(),
      requiresSignature: draft.requiresSignature, reminderFrequency: draft.reminderFrequency,
      message: isPoll && isEmptyHtml(previewBody) ? '<p>Please vote.</p>' : previewBody,
      ...(isMaint ? { eventDate: draft.eventDate, startTime: draft.startTime, endTime: draft.endTime, affects: draft.affects.trim() } : {}),
      ...(isPoll ? { pollOptions: options, pollMultiple: draft.pollMultiple, pollClosesOn: draft.pollClosesOn || '' } : {}),
      sentAt: new Date().toISOString().slice(0, 10),
      status,
      recipients,
      viewed: 0,
      pushDelivered: status === 'Sent' ? recipients : 0,
      signedBy: '',
    });
    if (!ok) return;
    if (status === 'Sent') {
      const units = unitsFor(draft.audience, draft.audienceUnits, draft.audienceBlocks, properties);
      const msg = { event: isPoll ? 'poll' : 'announcement', title: `${isPoll ? 'Poll' : draft.type}: ${draft.subject.trim()}${isMaint ? ` (${whenText(draft)})` : ''}`, body: isPoll ? 'A new poll is open — your vote counts.' : 'A new message has been posted for you in Communications.', link: '#/communications', by: currentUser?.name || '' };
      if (units) await notifyMany(units.map((u) => ({ ...msg, toUnit: u })));
      else await notify({ ...msg, toRoleIds: draft.audience === 'Owners' ? ['owner'] : ['owner', 'resident'] });
    }
    setDraft(BLANK);
    setTemplateId('');
    setFieldValues({});
  }

  async function signBroadcast(b) {
    if (!currentUser) return;
    const names = (b.signedBy || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (names.includes(currentUser.name)) return;
    await saveBroadcast({ ...b, signedBy: [...names, currentUser.name].join(', ') });
  }

  const isResidentRole = roleId === 'owner' || roleId === 'resident';
  const reachNote = pickerKind ? `${draft.audienceUnits.length} selected` : draft.audience === 'Selected blocks' ? `${(draft.audienceBlocks || []).length} block(s)` : draft.audience;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Communication center</h1>
          <p>Announcements, polls, owner e-voting, notice templates and the community forum.</p>
        </div>
      </div>
      <div className="tabs" style={{ margin: '0 0 12px' }}>
        {tabs.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>

      {tab === 'notices' && <NoticeList limit={10} title="Notices" />}

      {tab === 'announce' && (
        <>
          <div className="grid two">
            {canBroadcast && (
              <div className="card">
                <h2>Send an announcement or poll</h2>
                <p className="muted" style={{ margin: '-4px 0 12px' }}>Write a notice, alert or poll and choose who receives it.</p>
                <div className="form-grid">
                  <div className="field">
                    <label>Type *</label>
                    <select aria-label="Type" value={draft.type} onChange={(e) => set({ type: e.target.value })}>
                      {TYPES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className={`field${errs.audience ? ' invalid' : ''}`}>
                    <label>Audience *</label>
                    <select aria-label="Audience" value={draft.audience} onChange={(e) => set({ audience: e.target.value, audienceUnits: [], audienceBlocks: [] })}>
                      {AUDIENCES.map((a) => <option key={a}>{a}</option>)}
                    </select>
                    {errs.audience && <div className="field-error">{errs.audience}</div>}
                  </div>
                </div>
                {isMaint && (
                  <div className="form-grid" style={{ marginTop: 10 }} data-testid="maint-fields">
                    <div className={`field${errs.eventDate ? ' invalid' : ''}`}><label>Maintenance date *</label>
                      <input type="date" aria-label="Maintenance date" min={todayStr} value={draft.eventDate} onChange={(e) => set({ eventDate: e.target.value })} />
                      {errs.eventDate && <div className="field-error">{errs.eventDate}</div>}</div>
                    <div className={`field${errs.startTime ? ' invalid' : ''}`}><label>From *</label>
                      <input type="time" aria-label="From time" value={draft.startTime} onChange={(e) => set({ startTime: e.target.value })} />
                      {errs.startTime && <div className="field-error">{errs.startTime}</div>}</div>
                    <div className="field"><label>Until</label>
                      <input type="time" aria-label="Until time" value={draft.endTime} onChange={(e) => set({ endTime: e.target.value })} /></div>
                    <div className="field"><label>What is affected</label>
                      <input value={draft.affects} onChange={(e) => set({ affects: e.target.value })} placeholder="e.g. Water supply, lift 2, power in block C" /></div>
                  </div>
                )}
                {draft.audience === 'Selected blocks' && (
                  <div className="field" data-testid="block-audience" style={{ marginTop: 10 }}>
                    <label>Blocks / towers *</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {blocksList.map((b) => (
                        <label key={b.id} className={`chip-btn${(draft.audienceBlocks || []).includes(b.name) ? ' on' : ''}`} style={{ cursor: 'pointer' }}>
                          <input type="checkbox" style={{ display: 'none' }} checked={(draft.audienceBlocks || []).includes(b.name)} onChange={() => set({ audienceBlocks: (draft.audienceBlocks || []).includes(b.name) ? draft.audienceBlocks.filter((x) => x !== b.name) : [...(draft.audienceBlocks || []), b.name] })} />
                          {(draft.audienceBlocks || []).includes(b.name) ? '✓ ' : ''}{b.name}
                        </label>
                      ))}
                      {blocksList.length === 0 && <span className="muted">No blocks defined yet — add them in Community setup.</span>}
                    </div>
                  </div>
                )}
                {pickerKind && <AudiencePicker kind={pickerKind} properties={properties} value={draft.audienceUnits} onChange={(v) => set({ audienceUnits: v })} />}

                {!isPoll && usableTemplates.length > 0 && (
                  <div className="field" style={{ marginTop: 13 }}>
                    <label>Notice template (optional)</label>
                    <select value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
                      <option value="">No template — write freely</option>
                      {usableTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                )}

                <div className={`field${errs.subject ? ' invalid' : ''}`} style={{ marginTop: 13 }}>
                  <label>{isPoll ? 'Poll question *' : 'Subject *'}</label>
                  <input aria-label={isPoll ? 'Poll question' : 'Subject'} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} placeholder={isPoll ? 'Which day suits the cultural evening?' : 'Water supply maintenance — 6 September'} />
                  {errs.subject && <div className="field-error">{errs.subject}</div>}
                </div>

                {isPoll && (
                  <div className={`field${errs.poll ? ' invalid' : ''}`} style={{ marginTop: 13 }}>
                    <label>Answers * <small className="muted">(2 to 12)</small></label>
                    <TagsInput list={draft.pollOptions.filter(Boolean)} onChange={(l) => set({ pollOptions: l.slice(0, 12) })} label="poll answers" placeholder="Type an answer and press Enter" />
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}><input type="checkbox" aria-label="Allow multiple answers" checked={draft.pollMultiple} onChange={(e) => set({ pollMultiple: e.target.checked })} />Allow more than one answer</label>
                    {errs.poll && <div className="field-error">{errs.poll}</div>}
                    <div className="field" style={{ marginTop: 8 }}><label>Poll closes on (optional)</label><input type="date" aria-label="Poll closes on" min={new Date().toISOString().slice(0, 10)} value={draft.pollClosesOn} onChange={(e) => set({ pollClosesOn: e.target.value })} /></div>
                  </div>
                )}

                {template ? (
                  <>
                    <div className="form-grid" style={{ marginTop: 13 }}>
                      {mergeFields.map((f) => (
                        <div className="field" key={f.token}>
                          <label>{f.label}</label>
                          <input value={fieldValues[f.token] ?? ''} onChange={(e) => setFieldValues((v) => ({ ...v, [f.token]: e.target.value }))} />
                        </div>
                      ))}
                    </div>
                    <div className="notice" style={{ marginTop: 12 }}>
                      <b>{template.logo} {template.headerText}</b>
                      <RichText html={previewBody} />
                    </div>
                  </>
                ) : (
                  <div className={`field${errs.message ? ' invalid' : ''}`} style={{ marginTop: 13 }}>
                    <label>{isPoll ? 'Details (optional)' : 'Message *'}</label>
                    <RichTextEditor value={draft.message} onChange={(h) => set({ message: h })} placeholder={isPoll ? 'Add any background people need to answer' : 'Write the announcement…'} minHeight={110} />
                    {errs.message && <div className="field-error">{errs.message}</div>}
                  </div>
                )}

                {!isPoll && (
                  <div className="form-grid" style={{ marginTop: 13 }}>
                    <div className="field">
                      <label><input type="checkbox" checked={draft.requiresSignature} onChange={(e) => set({ requiresSignature: e.target.checked })} style={{ marginRight: 6 }} />Requires e-signature</label>
                    </div>
                    <div className="field">
                      <label>Reminder frequency</label>
                      <select value={draft.reminderFrequency} onChange={(e) => set({ reminderFrequency: e.target.value })}>
                        {REMINDER_FREQS.map((r) => <option key={r}>{r}</option>)}
                      </select>
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={() => send('Sent')}>{isPoll ? 'Send poll' : 'Send now'}</button>
                  <button className="btn secondary" onClick={() => send('Scheduled')}>Schedule</button>
                  <button className="btn secondary" onClick={() => send('Draft')}>Save draft</button>
                </div>
              </div>
            )}

            {canBroadcast && <div className="card">
              <h2>Reach overview</h2>
              <ul className="list">
                <li><span>Audience</span><b>{reachNote}</b></li>
                <li><span>Estimated recipients</span><b>{reach ?? '—'}</b></li>
                <li><span>Total properties tracked</span><b>{properties.length}</b></li>
              </ul>
              <p className="muted" style={{ marginTop: 8 }}>
                Recipient counts are computed live from the Properties directory, not tracked separately here.
              </p>
            </div>}
          </div>

          {upcoming.length > 0 && (
            <div className="card" style={{ marginTop: 16 }} data-testid="upcoming-notices">
              <h2>🛠 Upcoming maintenance</h2>
              <ul className="list">
                {upcoming.map((b) => (
                  <li key={b.id} data-testid="upcoming-row" style={{ alignItems: 'flex-start' }}>
                    <span style={{ flex: 1 }}>
                      <b>{b.subject}</b><br />
                      <span className="tag orange">{whenText(b)}</span>{b.eventDate === todayStr && <span className="tag red" style={{ marginLeft: 6 }}>Today</span>}
                      {b.affects && <small className="muted"> · {b.affects}</small>}
                      {canBroadcast && resch?.id === b.id && (
                        <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          <input type="date" aria-label="New date" min={todayStr} value={resch.eventDate} onChange={(e) => setResch({ ...resch, eventDate: e.target.value })} />
                          <input type="time" aria-label="New from" value={resch.startTime} onChange={(e) => setResch({ ...resch, startTime: e.target.value })} />
                          <input type="time" aria-label="New until" value={resch.endTime} onChange={(e) => setResch({ ...resch, endTime: e.target.value })} />
                          <button className="btn sm" data-testid="resch-save" onClick={reschedule}>Save &amp; notify</button>
                          <button className="btn secondary sm" onClick={() => setResch(null)}>Cancel</button>
                        </div>
                      )}
                    </span>
                    {canBroadcast && resch?.id !== b.id && <button className="btn secondary sm" data-testid="resch" onClick={() => setResch({ id: b.id, eventDate: b.eventDate, startTime: b.startTime || '', endTime: b.endTime || '' })}>Reschedule</button>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <h2>{canBroadcast ? 'Recent broadcasts' : 'Announcements for you'}</h2>
            {broadcasts.length === 0 ? (
              <div className="empty">Nothing sent yet.</div>
            ) : (
              <ul className="list">
                {[...broadcasts].reverse().map((b) => {
                  const signedNames = (b.signedBy || '').split(',').map((s) => s.trim()).filter(Boolean);
                  const iSigned = currentUser && signedNames.includes(currentUser.name);
                  return (
                    <li key={b.id} style={{ alignItems: 'flex-start' }}>
                      <span style={{ flex: 1 }}>
                        <b>{b.type === 'Poll' ? '📊 ' : ''}{b.subject}</b><br />
                        <small className="muted">{b.type}{b.eventDate ? ` · ${whenText(b)}` : ''} · {b.audience === 'Selected villas' || b.audience === 'Selected apartments' ? `${b.audience} (${(b.audienceUnits || []).length})` : b.audience} · {b.sentAt}</small>
                        {b.message && <RichText html={b.message} />}
                        {b.type === 'Poll' && b.status === 'Sent' && <PollCard poll={b} canSeeVoters={canBroadcast} />}
                        {b.status === 'Sent' && canBroadcast && (
                          <div className="muted" style={{ marginTop: 4 }}>
                            {b.recipients ?? 0} sent · {b.viewed ?? 0} viewed · {b.pushDelivered ?? 0} push delivered
                            {' · '}
                            <button className="btn secondary" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => saveBroadcast({ ...b, viewed: Math.min((b.recipients ?? 0), (b.viewed ?? 0) + 1) })}>+1 viewed</button>
                          </div>
                        )}
                        {b.requiresSignature && (
                          <div style={{ marginTop: 4 }}>
                            <span className="muted">{signedNames.length} signed</span>
                            {isResidentRole && !iSigned && (
                              <button className="btn secondary" style={{ marginLeft: 8, padding: '3px 8px', fontSize: 12 }} onClick={() => signBroadcast(b)}>Sign & dismiss</button>
                            )}
                            {isResidentRole && iSigned && <span className="tag green" style={{ marginLeft: 8 }}>Signed</span>}
                          </div>
                        )}
                      </span>
                      <span className="tag blue">{b.status}</span>
                      <AdminDelete collection={COLLECTIONS.BROADCASTS} id={b.id} label="message" />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {tab === 'evote' && <EVoting />}
      {tab === 'templates' && <NoticeTemplateDesigner scope="announcement" />}
      {tab === 'forum' && <ForumPanel />}
    </div>
  );
}

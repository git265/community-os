import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import SectionPage from '../../components/SectionPage.jsx';
import CommitteeManager from './CommitteeManager.jsx';
import Modal from '../../components/Modal.jsx';
import RichText from '../../components/RichText.jsx';
import { AttachmentList } from '../../components/Attachments.jsx';

const dmy = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
export const when = (m) => [dmy(m.date), m.startTime && (m.endTime ? `${m.startTime}–${m.endTime}` : m.startTime)].filter(Boolean).join(' · ');
const textOf = (html) => { const d = document.createElement('div'); d.innerHTML = String(html || '').replace(/<\/(li|p|div)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n'); return d.textContent.replace(/\n{3,}/g, '\n\n').trim(); };

function exportAgenda(meeting) {
  const text = `${meeting.title}\n${when(meeting)}\n${meeting.location || ''}\n\nAgenda:\n${textOf(meeting.agenda)}`;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${meeting.title.replace(/\s+/g, '-').toLowerCase()}-agenda.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Who holds a role: active users with it as their main or an additional role. */
const holders = (users, roleId) => users.filter((u) => u.status !== 'Inactive' && [u.roleId, ...(Array.isArray(u.extraRoleIds) ? u.extraRoleIds : [])].includes(roleId));

function MemberDetails({ member, roleNames, onClose }) {
  const rows = [
    ['Role', [member.roleId, ...(Array.isArray(member.extraRoleIds) ? member.extraRoleIds : [])].map((r) => roleNames[r] || r).join(', ')],
    ['Phone', member.phone], ['Email', member.email], ['Villa / unit', Array.isArray(member.units) ? member.units.join(', ') : member.units],
  ].filter(([, v]) => v);
  return (
    <Modal title={member.name} subtitle="Committee member" onClose={onClose}>
      <ul className="list">{rows.map(([k, v]) => <li key={k}><span>{k}</span><b>{v}</b></li>)}</ul>
      {rows.length <= 1 && <p className="muted">Contact details are shared with the Executive Committee and management staff only.</p>}
      <div className="form-actions"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

export default function GovernanceModule() {
  const { roles = [] } = useApp();
  const { records: meetings, save: saveMeeting } = useCollection(COLLECTIONS.MEETINGS, 'Governance & Committees');
  const { hasPermission } = useApp();
  const canPublish = hasPermission('MANAGE_GOVERNANCE');
  const { records: users } = useCollection(COLLECTIONS.USERS, 'Users');
  const [member, setMember] = useState(null);
  const [committee, setCommittee] = useState(null);
  const [manage, setManage] = useState('');
  const canManage = hasPermission('MANAGE_ROLES');
  const roleNames = useMemo(() => Object.fromEntries(roles.map((r) => [r.id, r.name])), [roles]);

  // Both rosters come from Roles & Users, so they can never drift: change a person's role and the committee follows.
  const ecRoles = roles.filter((r) => r.category === 'EC' && r.id !== 'super_admin' && !r.id.startsWith('committee_'));
  const subs = roles.filter((r) => r.id.startsWith('committee_'));

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = [...meetings].filter((m) => m.status === 'Scheduled' && m.date >= today).sort((a, b) => (`${a.date}${a.startTime}` < `${b.date}${b.startTime}` ? -1 : 1))[0]
    ?? [...meetings].sort((a, b) => (a.date < b.date ? 1 : -1))[0];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Governance & committees</h1>
          <p>Meetings, minutes and who sits on which committee.</p>
        </div>
      </div>

      <div className="grid two">
        <div className="card" data-testid="ec-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2 style={{ margin: 0 }}>Executive Committee</h2>{canManage && <button type="button" className="btn secondary small" data-testid="manage-ec" onClick={() => setManage('ec')}>Manage</button>}</div>
          <p className="muted" style={{ margin: '2px 0 8px' }}>Taken from Roles &amp; Users. Click a name for details.</p>
          {ecRoles.length === 0 ? <div className="empty">No Executive Committee roles.</div> : (
            <ul className="list">
              {ecRoles.map((r) => {
                const people = holders(users, r.id);
                return (
                  <li key={r.id}>
                    <span>{r.name}</span>
                    <span>{people.length === 0 ? <span className="muted">Vacant</span> : people.map((u) => <button key={u.id} type="button" className="link-btn" style={{ marginLeft: 6 }} onClick={() => setMember(u)}><b>{u.name}</b></button>)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="card" data-testid="sub-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2 style={{ margin: 0 }}>Sub-committees</h2>{canManage && <button type="button" className="btn secondary small" data-testid="manage-sub" onClick={() => setManage('sub')}>Manage</button>}</div>
          <p className="muted" style={{ margin: '2px 0 8px' }}>Click a sub-committee to see its members.</p>
          {subs.length === 0 ? <div className="empty">No sub-committees.</div> : (
            <ul className="list">
              {subs.map((r) => {
                const people = holders(users, r.id);
                return (
                  <li key={r.id} style={{ cursor: 'pointer' }} onClick={() => setCommittee(r)}>
                    <span><button type="button" className="link-btn"><b>{r.name.replace(/ Committee$/, '')}</b></button></span>
                    <b>{people.length} member{people.length === 1 ? '' : 's'}</b>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {upcoming && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>{upcoming.status === 'Scheduled' && upcoming.date >= today ? 'Next meeting' : 'Latest meeting'} · {upcoming.title}</h2>
          {canPublish && (
            <div className="notice" data-testid="publish-state" style={{ marginBottom: 10 }}>
              {upcoming.visibility === 'Internal (committee only)'
                ? <>🔒 <b>Internal</b> — only the committee and management staff can see this meeting. <button type="button" className="btn sm" data-testid="publish-meeting" style={{ marginLeft: 8 }} onClick={async () => { if (window.confirm('Publish this meeting to all owners and residents? They will be notified in the app and by SMS / WhatsApp.')) await saveMeeting({ ...upcoming, visibility: 'Published to residents' }); }}>Publish to residents &amp; notify</button></>
                : <>📣 <b>Published to residents</b>{upcoming.publishedAt ? ` on ${upcoming.publishedAt.slice(0, 10)}` : ''} — owners and residents see it and are notified of new meetings, changes, cancellations and minutes. <button type="button" className="btn secondary sm" style={{ marginLeft: 8 }} onClick={async () => { if (window.confirm('Take this meeting back to committee-only? Residents will no longer see it (they are not notified).')) await saveMeeting({ ...upcoming, visibility: 'Internal (committee only)' }); }}>Unpublish</button></>}
            </div>
          )}
          <div className="grid two">
            <div>
              <p><b>{when(upcoming)}</b><br /><span className="muted">{upcoming.committee}{upcoming.location ? ` · ${upcoming.location}` : ''}</span></p>
              <h3>Agenda</h3>
              {upcoming.agenda ? <RichText html={upcoming.agenda} /> : <p className="muted">No agenda yet.</p>}
              <AttachmentList items={upcoming.agendaFiles || []} />
            </div>
            <div>
              <h3>Meeting record</h3>
              {upcoming.minutes ? <RichText html={upcoming.minutes} /> : <p className="muted">No minutes attached yet. Open the meeting in the list below to write the minutes or attach signed copies.</p>}
              <AttachmentList items={upcoming.minutesFiles || []} />
              <button className="btn secondary" onClick={() => exportAgenda(upcoming)}>Export agenda</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <SectionPage
          sectionId={COLLECTIONS.MEETINGS}
          title="All meetings"
          description="Every scheduled, completed and cancelled meeting. Add a meeting to set its date, time, agenda and files; add the minutes afterwards."
          recordName="meeting"
          search
          filters={[{ key: 'committee', label: 'All committees' }, { key: 'status', label: 'All status' }]}
          dateFields={[{ key: 'date', label: 'Meeting date' }]}
          baseSort={{ key: 'date', dir: 'desc' }}
        />
      </div>

      {manage && <CommitteeManager kind={manage} onClose={() => setManage('')} />}
      {member && <MemberDetails member={member} roleNames={roleNames} onClose={() => setMember(null)} />}
      {committee && (
        <Modal title={committee.name} subtitle="Sub-committee members" onClose={() => setCommittee(null)}>
          {holders(users, committee.id).length === 0 ? <div className="empty">No members yet — give a user this role in Users.</div> : (
            <div className="table-wrap"><table className="resp-table" data-testid="members-table">
              <thead><tr><th>Member</th><th>Phone</th><th>Email</th><th>Villa</th></tr></thead>
              <tbody>
                {holders(users, committee.id).map((u) => (
                  <tr key={u.id} style={{ cursor: 'pointer' }} onClick={() => { setCommittee(null); setMember(u); }}>
                    <td data-label="Member"><b>{u.name}</b></td><td data-label="Phone">{u.phone || '—'}</td><td data-label="Email">{u.email || '—'}</td><td data-label="Villa">{(Array.isArray(u.units) ? u.units.join(', ') : u.units) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <div className="form-actions"><button className="btn" onClick={() => setCommittee(null)}>Close</button></div>
        </Modal>
      )}
    </div>
  );
}

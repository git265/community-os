import { localDay } from '../lib/locale.js';
import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../context/AppContext.jsx';
import { isRead, markRead } from '../lib/noticeReads.js';
import { COLLECTIONS } from '../lib/storage/index.js';
import { dmy } from '../lib/finance/rules.js';
import RichText from './RichText.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Notices (sent announcements) with a month / year filter. Shows the latest `limit` of the chosen period.
 *  Row-level access already limits residents to messages addressed to them. */
export default function NoticeList({ limit = 10, title = 'Notices', onOpen }) {
  const { records } = useCollection(COLLECTIONS.BROADCASTS, 'Communications');
  const sent = useMemo(() => records.filter((b) => b.status === 'Sent' && b.type !== 'Poll').sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt))), [records]);
  const years = useMemo(() => [...new Set(sent.map((b) => String(b.sentAt).slice(0, 4)).filter(Boolean))].sort().reverse(), [sent]);
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [open, setOpen] = useState(null);
  const { currentUser, roleId } = useApp();
  const me = currentUser?.name || roleId || '';
  // reading a notice here counts as reading it (its "New" mark in Communications goes)
  const read = (b) => { if ((b.sentBy || '') !== me && !isRead(b, me)) markRead(b, me).catch(() => {}); };
  const rows = sent.filter((b) => (!year || String(b.sentAt).slice(0, 4) === year) && (!month || String(b.sentAt).slice(5, 7) === month));
  const shown = rows.slice(0, limit);
  return (
    <div className="card" style={{ marginTop: 16 }} data-testid="notice-list">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span style={{ display: 'flex', gap: 6 }}>
          <select aria-label="Month" data-testid="notice-month" value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">All months</option>
            {MONTHS.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
          </select>
          <select aria-label="Year" data-testid="notice-year" value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="">All years</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </span>
      </div>
      <p className="muted" style={{ margin: '2px 0 8px', fontSize: 13 }}>Latest {limit}{rows.length > shown.length ? ` of ${rows.length}` : ''}. Pick a month and year to look back.</p>
      {shown.length === 0 ? <div className="empty">No notices for this period.</div> : (
        <ul className="list">
          {shown.map((b) => (
            <li key={b.id} data-testid="notice-row" style={{ alignItems: 'flex-start', cursor: 'pointer' }} onClick={() => { if (open !== b.id) read(b); setOpen(open === b.id ? null : b.id); }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{b.subject}</b><br />
                <small className="muted">{b.type} · {dmy(localDay(b.sentAt))}</small>
                {b.message && (open === b.id ? <RichText html={b.message} /> : <div className="clamp3" data-testid="notice-preview"><RichText html={b.message} /></div>)}
                {b.message && <span className="notice-more">{open === b.id ? 'Show less' : 'Read more'}</span>}
              </span>
              <span className="tag blue">{b.type}</span>
            </li>
          ))}
        </ul>
      )}
      {onOpen && <button className="btn secondary sm" style={{ marginTop: 8 }} onClick={onOpen}>All in Communications</button>}
    </div>
  );
}

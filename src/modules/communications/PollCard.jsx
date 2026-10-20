import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';

/** WhatsApp-style poll: pick one or several answers, change them until the poll closes, live bars with counts. */
export default function PollCard({ poll, canSeeVoters }) {
  const { currentUser } = useApp();
  const { records: allVotes, save } = useCollection(COLLECTIONS.POLL_VOTES, 'Poll Votes');
  const votes = useMemo(() => allVotes.filter((v) => v.broadcastId === poll.id), [allVotes, poll.id]);
  const options = poll.pollOptions || [];
  // one answer per villa: anyone in the household sees and can change the villa's answer (people without a villa: one per person)
  const mine = currentUser?.unit ? votes.find((v) => v.unit === currentUser.unit) : votes.find((v) => v.voter === currentUser?.name);
  const villaVoteBy = mine && currentUser?.unit && mine.voter !== currentUser.name ? mine.voter : '';
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState('');
  const closed = !!poll.pollClosesOn && poll.pollClosesOn < new Date().toISOString().slice(0, 10);
  const current = picked ?? (mine?.choices || []);
  const multi = !!poll.pollMultiple;
  const total = votes.length;
  const count = (i) => votes.filter((v) => (v.choices || []).includes(String(i))).length;

  function toggle(i) {
    if (closed) return;
    const k = String(i);
    setPicked(multi ? (current.includes(k) ? current.filter((x) => x !== k) : [...current, k]) : [k]);
  }
  async function submit() {
    if (!current.length) return setError('Choose at least one answer');
    setError('');
    const ok = await save({ ...(mine || {}), broadcastId: poll.id, voter: currentUser.name, unit: currentUser.unit || '', choices: current });
    if (ok) setPicked(null);
  }
  const dirty = picked !== null && JSON.stringify([...picked].sort()) !== JSON.stringify([...(mine?.choices || [])].sort());

  return (
    <div className="poll-card" data-testid="poll-card" style={{ marginTop: 8, padding: 10, border: '1px solid var(--line)', borderRadius: 10 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{multi ? 'Select one or more' : 'Select one'}{poll.pollClosesOn ? ` · ${closed ? 'closed' : 'closes'} ${poll.pollClosesOn}` : ''}</div>
      {options.map((o, i) => {
        const n = count(i); const pct = total ? Math.round((n / total) * 100) : 0; const on = current.includes(String(i));
        return (
          <div key={i} style={{ marginBottom: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: closed ? 'default' : 'pointer' }}>
              <input type={multi ? 'checkbox' : 'radio'} name={`poll-${poll.id}`} aria-label={o} checked={on} disabled={closed || !!villaVoteBy} onChange={() => toggle(i)} />
              <span style={{ flex: 1 }}>{o}</span><b>{n}</b>
            </label>
            <div style={{ height: 6, borderRadius: 4, background: 'var(--line)', marginLeft: 26 }}><div style={{ width: `${pct}%`, height: '100%', borderRadius: 4, background: on ? '#2563eb' : '#93c5fd' }} /></div>
            {canSeeVoters && n > 0 && <small className="muted" style={{ marginLeft: 26 }}>{votes.filter((v) => (v.choices || []).includes(String(i))).map((v) => `${v.voter}${v.unit ? ` (${v.unit})` : ''}`).join(', ')}</small>}
          </div>
        );
      })}
      {error && <div className="field-error">{error}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
        <small className="muted">{total} vote{total === 1 ? '' : 's'}</small>
        {!closed && currentUser && <button type="button" className="btn sm" disabled={!!villaVoteBy || (!!mine && !dirty)} onClick={submit}>{villaVoteBy ? 'Voted for your villa' : mine ? (dirty ? 'Change vote' : 'Voted ✓') : 'Vote'}</button>}
        {currentUser?.unit && <small className="muted" data-testid="poll-villa-note">One vote per villa{villaVoteBy ? ` — ${currentUser.unit} already voted (by ${villaVoteBy})` : ''}</small>}
      </div>
    </div>
  );
}

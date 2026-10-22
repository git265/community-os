import { notify } from '../../lib/notify.js';
import React, { useEffect, useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import RichText from '../../components/RichText.jsx';
import RecordModal from '../billing/RecordModal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { FOR_AGAINST, buildRoll, rollHash, rollEntryFor, whyCannotVote, requestOtp, verifyOtp, tally, verifyChain, todayStr } from '../../lib/evoting.js';

const STATUS_TAG = { Draft: '', Open: 'green', Closed: 'blue' };

/* --------------------------------------------------------------- voting -- */
function VoteFlow({ ballot, onClose }) {
  const { currentUser } = useApp();
  const principal = getPrincipal();
  const [step, setStep] = useState('choose'); // choose -> verify -> review -> done
  const [choice, setChoice] = useState('');
  const [sms, setSms] = useState(null);
  const [code, setCode] = useState('');
  const [proof, setProof] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState(null);

  async function sendCode() {
    setError('');
    try { setSms(await requestOtp(ballot, principal)); } catch (e) { setError(e.message); }
  }
  async function checkCode() {
    setError('');
    try { setProof(await verifyOtp(ballot, principal, code)); setStep('review'); } catch (e) { setError(e.message); }
  }
  async function cast() {
    setBusy(true); setError('');
    try {
      await secureStorage.put(COLLECTIONS.VOTE_ROLL, { ballotId: ballot.id, unit: principal.unit, proof }, { summaryOf: () => `Voted on “${ballot.title}”`, label: 'Voter roll' });
      const box = await secureStorage.put(COLLECTIONS.BALLOT_BOX, { ballotId: ballot.id, choice });
      setReceipt(box);
      setStep('done');
    } catch (e) { setError(e.message || 'The vote could not be recorded'); }
    setBusy(false);
  }

  return (
    <Modal title={`Vote · ${ballot.title}`} subtitle={`Voting for ${principal.unit} · one vote per unit · final once cast`} onClose={onClose}>
      {error && <div className="notice error" role="alert">{error}</div>}
      {step === 'choose' && (
        <>
          {ballot.description && <RichText html={ballot.description} />}
          <div className="field" style={{ marginTop: 10 }}><label id="choice-l">Your choice * <small className="muted">· {ballot.options.length} options</small></label>
            <div className="vote-options" role="radiogroup" aria-labelledby="choice-l">
              {ballot.options.map((o) => (
                <label key={o} className={`vote-opt${choice === o ? ' on' : ''}${/^for$|^yes$/i.test(o) ? ' pos' : /^against$|^no$/i.test(o) ? ' neg' : ''}`}>
                  <input type="radio" name="ballot-choice" aria-label={o} checked={choice === o} onChange={() => setChoice(o)} />
                  <span className="vote-dot" aria-hidden="true" />
                  <span className="vote-label">{o}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="form-actions"><button className="btn" disabled={!choice} onClick={() => setStep('verify')}>Next: verify it’s you</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
        </>
      )}
      {step === 'verify' && (
        <>
          <p>Second step: we send a 6-digit code to the mobile registered for <b>{principal.unit}</b>{(() => { const e = rollEntryFor(ballot, principal.unit); const l4 = e?.phones?.[principal.name] || e?.phoneLast4; return l4 ? ` (ends ${l4})` : ''; })()}. It works for 5 minutes and 3 tries.</p>
          {!sms ? <button className="btn" onClick={sendCode}>Send code</button> : (
            <>
              {sms.code ? <div className="notice" data-testid="sms-sim">📱 <b>Simulated SMS</b> (no SMS gateway in this demo): your code is <b data-testid="otp-code">{sms.code}</b></div> : <div className="notice" data-testid="sms-sent">📱 We sent a 6-digit code to your registered mobile{sms.phoneLast4 ? ` (ends ${sms.phoneLast4})` : ''}.</div>}
              <div className="field" style={{ marginTop: 10 }}><label>Enter the code *</label>
                <input aria-label="One-time code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </div>
              <div className="form-actions"><button className="btn" disabled={code.length !== 6} onClick={checkCode}>Verify</button><button className="btn secondary" onClick={sendCode}>Send again</button></div>
            </>
          )}
        </>
      )}
      {step === 'review' && (
        <>
          <div className="notice">✅ Verified. Check your choice — it cannot be changed after this.</div>
          <p style={{ fontSize: 18 }}>You are voting <b className="vote-chosen">{choice}</b> on “{ballot.title}” for <b>{principal.unit}</b>.</p>
          <div className="form-actions"><button className="btn" disabled={busy} onClick={cast}>{busy ? 'Casting…' : 'Cast my vote (final)'}</button><button className="btn secondary" disabled={busy} onClick={() => setStep('choose')}>Change choice</button></div>
        </>
      )}
      {step === 'done' && (
        <>
          <div className="notice" data-testid="vote-done">✅ Your vote for {principal.unit} is recorded. Nobody can link it to you.</div>
          <p>Keep this receipt. After voting closes you can check that your vote is in the count:</p>
          <p style={{ fontSize: 20, letterSpacing: 2 }}><b data-testid="receipt">{receipt?.receipt}</b></p>
          <small className="muted">Vote no. {receipt?.seq} · fingerprint {String(receipt?.hash || '').slice(0, 16)}…</small>
          <div className="form-actions"><button className="btn" onClick={onClose}>Done</button></div>
        </>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- results -- */
function Results({ ballot, box, marks }) {
  const t = useMemo(() => tally(ballot, box, (ballot.roll || []).length), [ballot, box]);
  const [chain, setChain] = useState(null);
  const [rc, setRc] = useState('');
  const [found, setFound] = useState(null);
  useEffect(() => { verifyChain(box).then(setChain); }, [box]);
  const max = Math.max(1, ...Object.values(t.counts));
  const match = chain && chain.ok && (!ballot.chainHead || chain.head === ballot.chainHead);
  return (
    <div data-testid="results" style={{ marginTop: 8 }}>
      <div className="notice"><b>{t.outcome}</b> · {t.cast} of {(ballot.roll || []).length} units voted ({t.turnoutPct}%) · quorum {ballot.quorumPct || 0}% {t.quorumMet ? 'met' : 'not met'}</div>
      {Object.entries(t.counts).map(([o, n]) => (
        <div key={o} style={{ margin: '6px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{o}</span><b>{n}</b></div>
          <div style={{ height: 8, background: 'var(--line)', borderRadius: 4 }}><div style={{ width: `${(n / max) * 100}%`, height: '100%', background: '#2563eb', borderRadius: 4 }} /></div>
        </div>
      ))}
      <div className="muted" style={{ marginTop: 6 }}>{chain ? (match ? `✔ Ballot box verified: ${chain.count} votes, chain intact, matches the fingerprint recorded at close.` : `⚠ Ballot box failed verification${chain.brokenAt ? ` at vote ${chain.brokenAt}` : ''}.`) : 'Verifying ballot box…'}</div>
      {marks !== null && marks !== box.length && <div className="notice error">The voter roll shows {marks} votes but the box holds {box.length}.</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input aria-label="Receipt code" style={{ maxWidth: 200 }} placeholder="Check my receipt" value={rc} onChange={(e) => { setRc(e.target.value.trim()); setFound(null); }} />
        <button type="button" className="btn secondary" disabled={!rc} onClick={() => setFound(box.find((r) => r.receipt === rc.toLowerCase()) || false)}>Check</button>
        {found && <span className="tag green" data-testid="receipt-ok">Found: vote no. {found.seq} — {found.choice}</span>}
        {found === false && <span className="tag red">No vote with that receipt</span>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- cards -- */
function BallotCard({ ballot, roll, box, canManage, onEdit, onOpen, onClose, onVote, principal }) {
  const marks = roll.filter((r) => r.ballotId === ballot.id);
  const size = (ballot.roll || []).length;
  const iVoted = marks.some((m) => m.unit === principal?.unit);
  const why = whyCannotVote(ballot, principal);
  const [showYet, setShowYet] = useState(false);
  const yet = (ballot.roll || []).filter((r) => !marks.some((m) => m.unit === r.unit));
  const today = todayStr();
  return (
    <div className="card" style={{ marginTop: 12 }} data-testid="ballot-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div><b style={{ fontSize: 16 }}>{ballot.title}</b><br /><small className="muted">{ballot.kind === 'Resolution' ? `Resolution · ${(ballot.options || []).join(' / ')}` : `Choose one of ${ballot.options?.length || 0}`} · {ballot.opensOn} → {ballot.closesOn} · quorum {ballot.quorumPct || 0}%</small></div>
        <span className={`tag ${STATUS_TAG[ballot.status]}`}>{ballot.status}</span>
      </div>
      {ballot.description && <RichText html={ballot.description} />}
      {ballot.status !== 'Draft' && <div className="muted" style={{ marginTop: 6 }}>Turnout: {marks.length} of {size} units ({size ? Math.round((marks.length / size) * 100) : 0}%) · voter roll fingerprint {String(ballot.rollHash || '').slice(0, 12)}…</div>}
      {principal?.roleId === 'owner' && ballot.status === 'Open' && (iVoted ? <div className="tag green" style={{ marginTop: 8 }}>✓ {principal.unit} has voted{(() => { const m = marks.find((x) => x.unit === principal?.unit); return m?.owner ? ` (by ${m.owner})` : ''; })()} · one vote per villa</div> : !why ? <div style={{ marginTop: 8 }}><button className="btn" onClick={() => onVote(ballot)}>Vote now</button></div> : <div className="muted" style={{ marginTop: 8 }}>{why}</div>)}
      {principal?.roleId !== 'owner' && ballot.status === 'Open' && <div className="muted" style={{ marginTop: 8 }}>Only registered owners can vote.</div>}
      {ballot.status === 'Closed' && <Results ballot={ballot} box={box.filter((b) => b.ballotId === ballot.id)} marks={marks.length} />}
      {ballot.status === 'Open' && <div className="muted" style={{ marginTop: 6 }}>🔒 Votes stay sealed (even from administrators) until voting closes.</div>}
      {canManage && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {ballot.status === 'Draft' && <><button className="btn secondary" onClick={() => onEdit(ballot)}>Edit</button><button className="btn" onClick={() => onOpen(ballot)}>Open voting…</button></>}
          {ballot.status === 'Open' && <button className="btn secondary" disabled={today < ballot.closesOn} title={today < ballot.closesOn ? `Can be closed from ${ballot.closesOn}` : ''} onClick={() => onClose(ballot)}>Close voting &amp; publish results</button>}
          {ballot.status !== 'Draft' && <button className="btn secondary" onClick={() => setShowYet((v) => !v)}>{showYet ? 'Hide' : 'Show'} units yet to vote ({yet.length})</button>}
        </div>
      )}
      {canManage && showYet && <div className="muted" style={{ marginTop: 6 }}>{yet.map((r) => r.unit.replace(/^Villa /, '')).join(', ') || 'Everyone has voted.'}</div>}
    </div>
  );
}

export default function EVoting() {
  const { records: ballots, save: saveBallot, refresh } = useCollection(COLLECTIONS.BALLOTS, 'E-voting Ballots');
  const { records: roll } = useCollection(COLLECTIONS.VOTE_ROLL, 'Voter Roll Marks');
  const { records: box } = useCollection(COLLECTIONS.BALLOT_BOX, 'Ballot Box');
  const { records: properties } = useCollection(COLLECTIONS.PROPERTIES, 'Properties');
  const { currentUser } = useApp();
  const principal = getPrincipal();
  const canManage = canWriteCollection(COLLECTIONS.BALLOTS, principal);
  const [editing, setEditing] = useState(null);
  const [voting, setVoting] = useState(null);
  const [opening, setOpening] = useState(null);
  const [error, setError] = useState('');

  const sorted = [...ballots].sort((a, b) => (a.opensOn < b.opensOn ? 1 : -1));
  const draftRecord = { status: 'Draft', kind: 'Resolution', options: FOR_AGAINST, quorumPct: 50, passPct: 50 };

  function beforeSave(d) {
    const out = { ...d, status: d.status || 'Draft' };
    const opts = (out.options || []).map((o) => String(o).trim()).filter(Boolean);
    out.options = opts.length ? opts : (out.kind === 'Resolution' ? FOR_AGAINST : []);
    if (out.options.length < 2) return 'A ballot needs at least two options.';
    if (out.kind === 'Resolution' && !(out.options.includes('For') && out.options.includes('Against'))) return 'A Resolution ballot needs “For” and “Against” among its options (you can add more, e.g. Abstain or Defer). Use “Choose one” for other questions.';
    if (out.closesOn < out.opensOn) return 'The closing date must be on or after the opening date.';
    if (Number(out.quorumPct) < 0 || Number(out.quorumPct) > 100 || Number(out.passPct) < 0 || Number(out.passPct) > 100) return 'Quorum and pass threshold are percentages between 0 and 100.';
    return out;
  }
  async function confirmOpen() {
    setError('');
    const r = buildRoll(properties);
    try {
      const ok = await saveBallot({ ...opening, status: 'Open', roll: r, rollHash: await rollHash(r) });
      if (ok) notify({ event: 'ballot', title: `Voting is open · ${opening.title || 'new ballot'}`, body: `One vote per villa. Voting closes on ${opening.closesOn || 'the closing date'}.`, link: '#/communications', toRoleIds: ['owner'], by: getPrincipal()?.name || '' }).catch(() => {});
      if (!ok) return;
      setOpening(null);
    } catch (e) { setError(e.message); }
  }
  async function closeBallot(b) {
    setError('');
    try { await saveBallot({ ...b, status: 'Closed' }); await refresh(); window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.BALLOT_BOX } })); } catch (e) { setError(e.message); }
  }

  const rollPreview = opening ? buildRoll(properties) : [];
  const noOwner = opening ? properties.filter((p) => p.unit && !p.owner).length : 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>E-voting</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>Registered owners only · one vote per villa (any registered owner of the villa may cast it) · code to your registered mobile · secret, tamper-evident ballot.</p>
        </div>
        {canManage && <button className="btn" onClick={() => setEditing(draftRecord)}>+ New ballot</button>}
      </div>
      {error && <div className="notice error" style={{ marginTop: 8 }}>{error}</div>}
      {canManage && <VoterRegister properties={properties} />}
      {sorted.length === 0 && <div className="empty">No ballots yet.</div>}
      {sorted.map((b) => (
        <BallotCard key={b.id} ballot={b} roll={roll} box={box} canManage={canManage} principal={principal}
          onEdit={(x) => setEditing(x)} onOpen={(x) => setOpening(x)} onClose={closeBallot} onVote={(x) => setVoting(x)} />
      ))}
      {editing && (
        <RecordModal collection={COLLECTIONS.BALLOTS} label="E-voting Ballots" record={editing} title={editing.id ? 'Edit ballot' : 'New ballot'}
          subtitle="Saved as a draft. Nothing is visible to voters until you open voting." hide={['status', 'roll', 'rollHash', 'openedAt', 'closedAt', 'chainHead', 'votesCounted']}
          beforeSave={beforeSave} allowDelete={!!editing.id} onClose={() => setEditing(null)} />
      )}
      {opening && (
        <Modal title={`Open voting · ${opening.title}`} subtitle="This freezes the list of voters." onClose={() => setOpening(null)}>
          <p><b>{rollPreview.length}</b> units have a registered owner and will be on the voter roll{noOwner ? `; ${noOwner} have no registered owner and cannot vote` : ''}.</p>
          <details style={{ marginBottom: 8 }} data-testid="roll-preview"><summary>See who is on the roll</summary><RollTable roll={rollPreview} /></details>
          <ul className="muted" style={{ marginTop: 0 }}>
            <li>After opening, the question, options, dates and voter roll can no longer be edited by anyone.</li>
            <li>Each unit votes once; the owner gets a one-time code on the registered mobile.</li>
            <li>Votes are sealed until voting closes on {opening.closesOn}.</li>
          </ul>
          <div className="form-actions"><button className="btn" onClick={confirmOpen}>Freeze roll &amp; open voting</button><button className="btn secondary" onClick={() => setOpening(null)}>Cancel</button></div>
        </Modal>
      )}
      {voting && <VoteFlow ballot={voting} onClose={() => { setVoting(null); refresh(); }} />}
    </div>
  );
}

/** The registered voters today: one line per unit with a registered owner (who may vote for it, and the mobile the code goes to). */
function VoterRegister({ properties }) {
  const roll = buildRoll(properties);
  const without = properties.filter((p) => p.unit && !p.owner).map((p) => p.unit).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  return (
    <details className="card" style={{ marginTop: 12 }} data-testid="voter-register">
      <summary><b>Registered voters</b> <span className="muted">· {roll.length} unit{roll.length === 1 ? '' : 's'} can vote{without.length ? `, ${without.length} without a registered owner` : ''}</span></summary>
      <p className="muted" style={{ margin: '6px 0' }}>Taken from the Unit Directory: the primary and additional owners of each unit (tenants and family contacts do not vote in owner ballots). The list is frozen into a ballot when voting opens.</p>
      <RollTable roll={roll} />
      {without.length > 0 && <p className="muted" data-testid="no-owner">No registered owner, so cannot vote: {without.join(', ')}. Add the owner in the Unit Directory.</p>}
    </details>
  );
}
function RollTable({ roll }) {
  return (
    <div className="table-wrap"><table className="resp-table" data-testid="roll-table">
      <thead><tr><th>Unit</th><th>May vote</th><th>Code goes to</th></tr></thead>
      <tbody>{roll.map((r) => (
        <tr key={r.unit} style={{ cursor: 'default' }}><td data-label="Unit"><b>{r.unit}</b></td><td data-label="May vote">{r.owners.join(', ')}</td>
          <td data-label="Code goes to">{r.owners.map((o) => (r.phones?.[o] ? `${o}: ••${r.phones[o]}` : `${o}: no mobile`)).join(' · ')}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

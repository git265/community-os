// E-voting over the real API (HTTP + PostgreSQL): the second factor is asked for and checked by the SERVER, and a vote is two ordinary writes.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, seedTenant, pool as mkPool, TENANT, purge, rowsOf } from './harness.mjs';

let S, pool, root, olive, omar, guard;
const today = new Date().toISOString().slice(0, 10);
const roll = [{ unit: 'V-1', owners: ['Olive Owner'], phones: { 'Olive Owner': '9999' }, phoneLast4: '9999' }, { unit: 'V-2', owners: ['Omar Owner'], phones: {}, phoneLast4: '' }];
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const ballot = async (extra = {}) => ({ id: 'bal-1', title: 'Lift replacement', description: '', kind: 'Resolution', options: ['For', 'Against'], opensOn: today, closesOn: today, quorumPct: 10, passPct: 50, roll, rollHash: await sha(JSON.stringify(roll)), status: 'Draft', ...extra });
const put = (token, c, rec) => S.call('PUT', `/${c}/${rec.id}`, { token, body: rec });
const code = async (token, ballotId = 'bal-1') => { const r = await S.call('POST', '/evoting/otp/request', { token, body: { ballotId } }); return r; };
const vote = async (token, choice = 'For', n = Math.random().toString(36).slice(2, 8)) => {
  const r = await code(token); assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = await S.call('POST', '/evoting/otp/verify', { token, body: { ballotId: 'bal-1', code: r.body.code } }); assert.equal(v.status, 200, JSON.stringify(v.body));
  const mark = await put(token, 'voteRoll', { id: `vr-${n}`, ballotId: 'bal-1', unit: undefined, proof: v.body.proof, ...(token === olive ? { unit: 'V-1' } : { unit: 'V-2' }) });
  if (mark.status !== 200) return { mark };
  return { mark, box: await put(token, 'ballotBox', { id: `bx-${n}`, ballotId: 'bal-1', choice }) };
};

before(async () => {
  pool = mkPool(); await seedTenant(pool); await pool.query('DELETE FROM auth_attempts');
  await pool.query("UPDATE users SET data = data || '{\"name\":\"Olive Owner\"}'::jsonb WHERE tenant=$1 AND id='u-own1'", [TENANT]);
  S = await startServer({ port: 8098 });
  root = (await S.otp('+91 98000 00003')).token; olive = (await S.otp('+91 98000 00011')).token; omar = (await S.otp('+91 98000 00012')).token; guard = (await S.otp('+91 98000 00021')).token;
});
after(async () => { S?.stop(); await purge(pool); await pool.end(); });

describe('e-voting through the API', () => {
  test('a ballot opens only with a roll that matches its fingerprint', async () => {
    const bad = await put(root, 'ballots', await ballot({ status: 'Open', rollHash: 'forged' }));
    assert.equal(bad.status, 403); assert.match(bad.body.message, /does not match its fingerprint/);
    assert.equal((await put(root, 'ballots', await ballot())).status, 200);
    const open = await put(root, 'ballots', await ballot({ status: 'Open' }));
    assert.equal(open.status, 200, JSON.stringify(open.body)); assert.equal(open.body.openedAt, today);
    const edit = await put(root, 'ballots', await ballot({ status: 'Open', title: 'Changed' }));
    assert.equal(edit.status, 403); assert.match(edit.body.message, /open ballot cannot be edited/);
  });

  test('no code, no vote: the voter-roll write demands the proof, and the box demands the roll mark', async () => {
    assert.equal((await code(root)).status, 400);                                                       // only owners are on the roll
    const noProof = await put(olive, 'voteRoll', { id: 'vr-x', ballotId: 'bal-1', unit: 'V-1' });
    assert.equal(noProof.status, 403); assert.match(noProof.body.message, /Second-factor check missing/);
    const noMark = await put(olive, 'ballotBox', { id: 'bx-x', ballotId: 'bal-1', choice: 'For' });
    assert.equal(noMark.status, 403); assert.match(noMark.body.message, /No verified voter roll mark/);
    assert.equal((await S.call('POST', '/evoting/otp/request', { body: { ballotId: 'bal-1' } })).status, 401);
  });

  test('wrong codes are counted; three burn the code', async () => {
    const r = await code(omar); assert.equal(r.status, 200);
    assert.equal(r.body.phoneLast4, '');                                                                  // the roll has no number for this owner
    const wrong = r.body.code === '111111' ? '222222' : '111111';
    const msgs = [];
    for (let i = 0; i < 3; i++) msgs.push((await S.call('POST', '/evoting/otp/verify', { token: omar, body: { ballotId: 'bal-1', code: wrong } })).body.message);
    assert.match(msgs[0], /2 attempts left/); assert.match(msgs[2], /0 attempts left/);
    const burnt = await S.call('POST', '/evoting/otp/verify', { token: omar, body: { ballotId: 'bal-1', code: r.body.code } });
    assert.equal(burnt.status, 400); assert.match(burnt.body.message, /Too many wrong attempts/);
  });

  test('a vote: roll mark (who) and box row (what) are separate, the proof works once, and the box is sealed until closing', async () => {
    const a = await vote(olive, 'For', 'olive');
    assert.equal(a.mark.status, 200, JSON.stringify(a.mark.body)); assert.ok(!a.mark.body.owner, 'the reply shows the roll mark as the voter may read it (no name)'); assert.equal(a.mark.body.proof, undefined);
    assert.equal((await rowsOf(pool, 'voteRoll')).find((r) => r.id === a.mark.body.id)?.owner, 'Olive Owner');   // the server recorded who
    assert.equal(a.box.status, 200, JSON.stringify(a.box.body)); assert.equal(a.box.body.seq, 1); assert.match(a.box.body.receipt, /^[0-9a-f]{12}$/);
    assert.equal(a.box.body.unit, undefined); assert.equal(a.box.body.recordCreatedBy, 'Ballot box'); assert.equal(a.box.body.recordCreatedAt, today);
    const again = await vote(olive, 'Against', 'olive2');                                                // one vote per villa
    assert.equal(again.mark.status, 403); assert.match(again.mark.body.message, /already voted/);
    assert.equal((await S.call('GET', '/ballotBox', { token: root })).body.length, 0);                    // sealed, even for the Super Admin
    const b = await vote(omar, 'Against', 'omar');
    assert.equal(b.box.status, 200, JSON.stringify(b.box.body)); assert.equal(b.box.body.seq, 2); assert.equal(b.box.body.prevHash, a.box.body.hash);
    assert.equal((await S.call('DELETE', `/ballotBox/${a.box.body.id}`, { token: root })).status, 403);
    assert.equal((await put(root, 'ballotBox', { ...a.box.body, choice: 'Against' })).status, 403);
    const audit = (await rowsOf(pool, 'audit')).filter((r) => r.collection === 'ballotBox');
    assert.equal(audit.length, 0);                                                                         // the box is never attributed to anyone
  });

  test('closing seals the chain; afterwards nothing can change and the box can be read and verified', async () => {
    const cur = (await S.call('GET', '/ballots/bal-1', { token: root })).body;
    const closed = await put(root, 'ballots', { ...cur, status: 'Closed' });
    assert.equal(closed.status, 200, JSON.stringify(closed.body)); assert.equal(closed.body.votesCounted, 2); assert.match(closed.body.chainHead, /^[0-9a-f]{64}$/);
    const box = (await S.call('GET', '/ballotBox', { token: root })).body;
    assert.equal(box.length, 2);
    assert.equal(box[1].hash, closed.body.chainHead);
    assert.equal(box[1].hash, await sha(`${box[0].hash}|2|${box[1].receipt}|${box[1].choice}`));
    const late = await put(root, 'ballots', { ...closed.body, title: 'Other' });
    assert.equal(late.status, 403); assert.match(late.body.message, /closed ballot can never be changed/);
    assert.equal((await code(olive)).status, 400);                                                        // voting is closed
  });
});

#!/usr/bin/env node
// A stand-in for a Hikvision DS-K1T344MBWX-QRE1 face terminal: the ISAPI calls the bridge makes, Digest login (with the real device's
// lockout after five refused logins), users, cards, faces, the door, the clock and the access event log. People "present" a face or a
// card through /sim/present (no login), and the stand-in decides as the device would.
//   node sim/ds-k1t344.js [--port 8091] [--user admin] [--password Passw0rd!] [--drift 45]
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const OFFSET = '+05:30', OFFSET_MIN = 330;

export function createSimulator({ port = 0, username = 'admin', password = 'Passw0rd!', driftSeconds = 0, serial = 'DS-K1T344MBWX-QRE1-SIM0001' } = {}) {
  const s = {
    users: new Map(), cards: new Map(), faces: new Map(), events: [], opens: [], nextSerial: 1, clockMs: driftSeconds * 1000, timeMode: 'NTP',
    refused: 0, lockedUntil: 0, logins: { ok: 0, refused: 0 }, requests: [], nonces: new Set(),
  };
  const realm = 'DS-K1T344MBWX-QRE1';
  const now = () => new Date(Date.now() + s.clockMs);
  const local = (d) => new Date(d.getTime() + OFFSET_MIN * 60_000).toISOString().slice(0, 19) + OFFSET;

  function challenge(res, extra = '') {
    const nonce = randomBytes(16).toString('hex'); s.nonces.add(nonce);
    res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}", stale="FALSE"`, 'Content-Type': 'application/xml' });
    const left = Math.max(0, 5 - s.refused);
    res.end(`<?xml version="1.0" encoding="UTF-8"?><userCheck><statusValue>401</statusValue><statusString>Unauthorized</statusString>${extra}<retryLoginTime>${left}</retryLoginTime></userCheck>`);
  }
  function authorized(req, res) {
    if (Date.now() < s.lockedUntil) { challenge(res, `<lockStatus>lock</lockStatus><unlockTime>${Math.ceil((s.lockedUntil - Date.now()) / 1000)}</unlockTime>`); return false; }
    const h = req.headers.authorization || '';
    if (!h.startsWith('Digest ')) { challenge(res); return false; }
    const a = {};
    for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) a[m[1]] = m[2] ?? m[3];
    if (!s.nonces.has(a.nonce)) { challenge(res); return false; }       // an old nonce: a new challenge, not a refusal
    const ha1 = md5(`${username}:${realm}:${password}`), ha2 = md5(`${req.method}:${a.uri}`);
    const want = md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:${a.qop}:${ha2}`);
    if (a.username !== username || a.response !== want) {
      s.refused++; s.logins.refused++;
      if (s.refused >= 5) s.lockedUntil = Date.now() + 30 * 60_000;
      challenge(res); return false;
    }
    s.refused = 0; s.logins.ok++;
    return true;
  }
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const ok = (res) => json(res, 200, { statusCode: 1, statusString: 'OK', subStatusCode: 'ok' });
  const bad = (res, sub, msg = 'Invalid Content') => json(res, 400, { statusCode: 6, statusString: msg, subStatusCode: sub, errorCode: 0x60000000, errorMsg: sub });
  const xml = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`); };

  function record(minor, extra) {
    const e = { major: 5, minor, time: local(now()), serialNo: s.nextSerial++, currentVerifyMode: 'cardOrFace', pictureURL: null, ...extra };
    e.pictureURL = `http://${server.address().address === '::' ? '127.0.0.1' : server.address().address}:${server.address().port}/LOCALS/pic/acsLinkCap/${e.serialNo}.jpeg@WEB`;
    s.events.push(e);
    return e;
  }
  /** Someone at the terminal: { face: employeeNo } or { card: number } (or { face: null } for a face it does not know). */
  function present({ face, card, attendanceStatus } = {}) {
    const today = now();
    const valid = (u) => u && Date.parse(u.Valid.beginTime + OFFSET) <= today.getTime() && today.getTime() <= Date.parse(u.Valid.endTime + OFFSET);
    if (card !== undefined) {
      const emp = s.cards.get(String(card)), u = emp && s.users.get(emp);
      return valid(u) ? record(1, { cardNo: String(card), employeeNoString: emp, name: u.name, attendanceStatus: attendanceStatus || 'undefined' })
        : u ? record(7, { cardNo: String(card), employeeNoString: emp, name: u.name }) : record(9, { cardNo: String(card) });
    }
    const u = face && s.users.get(face);
    if (u && s.faces.has(face) && valid(u)) return record(75, { employeeNoString: face, name: u.name, attendanceStatus: attendanceStatus || 'undefined' });
    return record(76, {});
  }
  async function body(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); }
  function parts(buf, type) {
    const b = (/boundary=([^;]+)/.exec(type) || [])[1];
    if (!b) return [];
    const out = []; const sep = Buffer.from('--' + b);
    let i = buf.indexOf(sep);
    while (i >= 0) {
      const next = buf.indexOf(sep, i + sep.length);
      if (next < 0) break;
      const chunk = buf.subarray(i + sep.length + 2, next - 2);
      const h = chunk.indexOf('\r\n\r\n');
      if (h > 0) { const head = chunk.subarray(0, h).toString(); out.push({ name: (/name="([^"]+)"/.exec(head) || [])[1], type: (/Content-Type:\s*([^\r\n]+)/i.exec(head) || [])[1], data: chunk.subarray(h + 4) }); }
      i = next;
    }
    return out;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'); const path = url.pathname;
    try {
      if (path.startsWith('/sim/')) {           // the test's hands: no login
        if (path === '/sim/present' && req.method === 'POST') return json(res, 200, present(JSON.parse((await body(req)).toString() || '{}')));
        if (path === '/sim/state') return json(res, 200, state());
        return json(res, 404, {});
      }
      if (!authorized(req, res)) return;
      s.requests.push(`${req.method} ${path}`);
      const raw = await body(req);
      const j = () => JSON.parse(raw.toString() || '{}');
      if (path === '/ISAPI/System/deviceInfo') return xml(res, `<DeviceInfo version="2.0"><deviceName>Main gate</deviceName><model>DS-K1T344MBWX-QRE1</model><serialNumber>${serial}</serialNumber><firmwareVersion>V3.11.0</firmwareVersion><deviceType>ACS</deviceType></DeviceInfo>`);
      if (path === '/ISAPI/System/time' && req.method === 'GET') return xml(res, `<Time version="2.0"><timeMode>${s.timeMode}</timeMode><localTime>${local(now())}</localTime><timeZone>CST-5:30:00</timeZone></Time>`);
      if (path === '/ISAPI/System/time' && req.method === 'PUT') {
        const t = (/<localTime>([^<]+)<\/localTime>/.exec(raw.toString()) || [])[1];
        if (!t || Number.isNaN(Date.parse(t))) return bad(res, 'badXmlContent');
        s.clockMs = Date.parse(t) - Date.now(); s.timeMode = 'manual';
        return xml(res, '<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>');
      }
      if (path === '/ISAPI/AccessControl/UserInfo/Count') return json(res, 200, { UserInfoCount: { userNumber: s.users.size } });
      if (path === '/ISAPI/AccessControl/UserInfo/Record' && req.method === 'POST') {
        const u = j().UserInfo;
        if (!u || !u.employeeNo || String(u.employeeNo).length > 32 || !u.name || [...String(u.name)].length > 32) return bad(res, 'badParameters');
        if (s.users.has(u.employeeNo)) return bad(res, 'employeeNoAlreadyExist');
        s.users.set(u.employeeNo, u); return ok(res);
      }
      if (path === '/ISAPI/AccessControl/UserInfo/Modify' && req.method === 'PUT') {
        const u = j().UserInfo;
        if (!s.users.has(u.employeeNo)) return bad(res, 'employeeNoNotExist');
        s.users.set(u.employeeNo, u); return ok(res);
      }
      if (path === '/ISAPI/AccessControl/UserInfo/Delete' && req.method === 'PUT') {
        for (const { employeeNo } of j().UserInfoDelCond.EmployeeNoList) {
          s.users.delete(employeeNo); s.faces.delete(employeeNo);
          for (const [c, e] of s.cards) if (e === employeeNo) s.cards.delete(c);
        }
        return ok(res);
      }
      if (path === '/ISAPI/AccessControl/CardInfo/Delete' && req.method === 'PUT') {
        const list = j().CardInfoDelCond.EmployeeNoList.map((x) => x.employeeNo);
        for (const [c, e] of s.cards) if (list.includes(e)) s.cards.delete(c);
        return ok(res);
      }
      if (path === '/ISAPI/AccessControl/CardInfo/Record' && req.method === 'POST') {
        const c = j().CardInfo;
        if (!s.users.has(c.employeeNo)) return bad(res, 'employeeNoNotExist');
        if (s.cards.has(c.cardNo) && s.cards.get(c.cardNo) !== c.employeeNo) return bad(res, 'cardNoAlreadyExist');
        s.cards.set(c.cardNo, c.employeeNo); return ok(res);
      }
      if (path === '/ISAPI/Intelligent/FDLib/FaceDataRecord' && req.method === 'POST') {
        const ps = parts(raw, req.headers['content-type'] || '');
        const rec = ps.find((p) => p.name === 'FaceDataRecord'), img = ps.find((p) => p.name === 'FaceImage' || p.name === 'img');
        if (!rec || !img) return bad(res, 'badParameters');
        const fp = JSON.parse(rec.data.toString()).FPID;
        if (!s.users.has(fp)) return bad(res, 'employeeNoNotExist');
        if (img.data[0] !== 0xff || img.data[1] !== 0xd8) return bad(res, 'invalidPicture');
        if (img.data.length > 200 * 1024) return bad(res, 'pictureTooLarge');
        if (s.faces.has(fp)) return bad(res, 'deviceUserAlreadyExistFace');
        s.faces.set(fp, img.data.length); return ok(res);
      }
      if (path === '/ISAPI/Intelligent/FDLib/FDSearch/Delete' && req.method === 'PUT') { for (const { value } of j().FPID) s.faces.delete(value); return ok(res); }
      if (/^\/ISAPI\/AccessControl\/RemoteControl\/door\/\d+$/.test(path) && req.method === 'PUT') {
        if (!/<cmd>open<\/cmd>/.test(raw.toString())) return bad(res, 'badXmlContent');
        s.opens.push({ door: Number(path.split('/').pop()), at: new Date().toISOString() }); record(21, {});   // door unlocked: not a punch
        return xml(res, '<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>');
      }
      if (path === '/ISAPI/AccessControl/AcsEvent' && req.method === 'POST') {
        const c = j().AcsEventCond;
        const from = Date.parse(c.startTime), to = Date.parse(c.endTime);
        const match = s.events.filter((e) => e.major === c.major && (!c.minor || e.minor === c.minor) && Date.parse(e.time) >= from && Date.parse(e.time) <= to);
        const page = match.slice(c.searchResultPosition, c.searchResultPosition + Math.min(c.maxResults, 30));
        return json(res, 200, { AcsEvent: { searchID: c.searchID, totalMatches: match.length, responseStatusStrg: !match.length ? 'NO MATCH' : c.searchResultPosition + page.length < match.length ? 'MORE' : 'OK', numOfMatches: page.length, InfoList: page } });
      }
      if (path.startsWith('/LOCALS/pic/')) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9])); }
      return json(res, 404, { statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport' });
    } catch (e) { return bad(res, 'badJsonContent', e.message); }
  });
  function state() {
    return { users: [...s.users.values()], cards: Object.fromEntries(s.cards), faces: [...s.faces.keys()], opens: s.opens, events: s.events.length, clockDriftS: Math.round(s.clockMs / 1000),
      timeMode: s.timeMode, logins: s.logins, locked: Date.now() < s.lockedUntil };
  }
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, state, present, raw: s,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  createSimulator({ port: Number(arg('port', 8091)), username: arg('user', 'admin'), password: arg('password', 'Passw0rd!'), driftSeconds: Number(arg('drift', 0)) })
    .then((sim) => console.log(`DS-K1T344 stand-in at ${sim.url} (user ${arg('user', 'admin')}). Present someone: curl -X POST ${sim.url}/sim/present -d '{"face":"<employeeNo>"}'`));
}

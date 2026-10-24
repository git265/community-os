// The few ISAPI calls the bridge makes to a Hikvision access terminal (DS-K1T344 and its family), over the Digest client.
import { randomBytes } from 'node:crypto';

/** The device said no. `sub` is its subStatusCode (e.g. employeeNoAlreadyExist), `permanent` when trying again cannot help. */
export class IsapiError extends Error {
  constructor(http, statusCode, sub, message) {
    super(message); this.name = 'IsapiError'; this.http = http; this.statusCode = statusCode; this.sub = sub || '';
    this.permanent = PERMANENT.some((p) => this.sub.toLowerCase().includes(p.toLowerCase())) || http === 400 && /invalid|bad/i.test(message);
  }
}
// what the device answers when the data itself is the problem: sending it again changes nothing
const PERMANENT = ['faceLibraryFull', 'userFull', 'cardFull', 'pictureTooLarge', 'faceQuality', 'noFace', 'multiFace', 'modelingFailed', 'faceBlurred',
  'cardNoAlreadyExist', 'invalidPicture', 'pictureFormat', 'badJsonContent', 'badParameters', 'notSupport'];

export class Isapi {
  constructor(client) { this.c = client; }

  // ---- plumbing ----------------------------------------------------------------------------------------------------------------------
  async json(method, path, body) {
    const res = await this.c.request(method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    return check(res, path);
  }
  async xml(method, path, body) {
    const res = await this.c.request(method, path, body === undefined ? {} : { body, headers: { 'Content-Type': 'application/xml' } });
    const text = res.body.toString('utf8');
    if (res.status >= 400) {
      throw new IsapiError(res.status, Number(tag(text, 'statusCode')) || null, tag(text, 'subStatusCode'), `${path}: ${tag(text, 'statusString') || res.status}${tag(text, 'subStatusCode') ? ' (' + tag(text, 'subStatusCode') + ')' : ''}`);
    }
    return text;
  }
  async multipart(method, path, parts) {
    const boundary = '----cosbridge' + randomBytes(8).toString('hex');
    const chunks = [];
    for (const p of parts) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\nContent-Type: ${p.type}\r\n\r\n`));
      chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data)); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const res = await this.c.request(method, path, { body: Buffer.concat(chunks), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, timeoutMs: 30_000 });
    return check(res, path);
  }

  // ---- the device ---------------------------------------------------------------------------------------------------------------------
  async deviceInfo() {
    const x = await this.xml('GET', '/ISAPI/System/deviceInfo');
    return { model: tag(x, 'model'), serial: tag(x, 'serialNumber'), firmware: tag(x, 'firmwareVersion'), name: tag(x, 'deviceName') };
  }
  /** The device's clock, as it reads it (an ISO time with its offset) and the rest of its time settings. */
  async time() {
    const x = await this.xml('GET', '/ISAPI/System/time');
    return { localTime: tag(x, 'localTime'), timeZone: tag(x, 'timeZone'), timeMode: tag(x, 'timeMode') };
  }
  /** Set the clock by hand (the device's own zone is kept). */
  async setTime(localTime, timeZone) {
    await this.xml('PUT', '/ISAPI/System/time',
      `<?xml version="1.0" encoding="UTF-8"?><Time version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><timeMode>manual</timeMode><localTime>${localTime}</localTime>${timeZone ? `<timeZone>${esc(timeZone)}</timeZone>` : ''}</Time>`);
  }
  async userCount() {
    const r = await this.json('GET', '/ISAPI/AccessControl/UserInfo/Count?format=json');
    return r?.UserInfoCount?.userNumber ?? null;
  }
  async addUser(u) { return this.json('POST', '/ISAPI/AccessControl/UserInfo/Record?format=json', { UserInfo: u }); }
  async modifyUser(u) { return this.json('PUT', '/ISAPI/AccessControl/UserInfo/Modify?format=json', { UserInfo: u }); }
  async deleteUser(employeeNo) { return this.json('PUT', '/ISAPI/AccessControl/UserInfo/Delete?format=json', { UserInfoDelCond: { EmployeeNoList: [{ employeeNo }] } }); }
  async deleteCards(employeeNo) { return this.json('PUT', '/ISAPI/AccessControl/CardInfo/Delete?format=json', { CardInfoDelCond: { EmployeeNoList: [{ employeeNo }] } }); }
  async addCard(employeeNo, cardNo) { return this.json('POST', '/ISAPI/AccessControl/CardInfo/Record?format=json', { CardInfo: { employeeNo, cardNo, cardType: 'normalCard' } }); }
  async addFace(employeeNo, jpeg) {
    return this.multipart('POST', '/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json', [
      { name: 'FaceDataRecord', type: 'application/json', data: JSON.stringify({ faceLibType: 'blackFD', FDID: '1', FPID: employeeNo }) },
      { name: 'FaceImage', filename: 'face.jpg', type: 'image/jpeg', data: jpeg },
    ]);
  }
  async deleteFace(employeeNo) { return this.json('PUT', '/ISAPI/Intelligent/FDLib/FDSearch/Delete?format=json&FDID=1&faceLibType=blackFD', { FPID: [{ value: employeeNo }] }); }
  async openDoor(doorNo = 1) {
    await this.xml('PUT', `/ISAPI/AccessControl/RemoteControl/door/${doorNo}`, '<?xml version="1.0" encoding="UTF-8"?><RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>');
  }
  /** One page of access events in a time window (newest last). */
  async events({ searchID, position = 0, max = 30, from, to }) {
    const r = await this.json('POST', '/ISAPI/AccessControl/AcsEvent?format=json', {
      AcsEventCond: { searchID, searchResultPosition: position, maxResults: max, major: 5, minor: 0, startTime: from, endTime: to },
    });
    const a = r?.AcsEvent || {};
    return { more: a.responseStatusStrg === 'MORE', list: a.InfoList || [], total: a.totalMatches ?? null };
  }
  /** A snapshot the device took (its picture URL is on the device itself). */
  async picture(url) {
    let path = url;
    try { const u = new URL(url); path = u.pathname + u.search; } catch { /* a bare path */ }
    const res = await this.c.request('GET', path, { timeoutMs: 10_000 });
    if (res.status >= 400 || !res.body.length) return null;
    return res.body;
  }
}

/** A JSON answer: ISAPI says OK with statusCode 1 (or simply 200 with data). */
function check(res, path) {
  const text = res.body.toString('utf8');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const code = data && typeof data.statusCode === 'number' ? data.statusCode : null;
  if (res.status >= 400 || (code !== null && code !== 1)) {
    const sub = data?.subStatusCode || tag(text, 'subStatusCode');
    const msg = data?.errorMsg || data?.statusString || tag(text, 'statusString') || `HTTP ${res.status}`;
    throw new IsapiError(res.status, code, sub, `${path.split('?')[0]}: ${msg}${sub ? ' (' + sub + ')' : ''}`);
  }
  return data;
}
export function tag(xml, name) { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml || ''); return m ? m[1].trim() : null; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

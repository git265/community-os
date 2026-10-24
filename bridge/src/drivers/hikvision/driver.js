// A Hikvision access terminal over ISAPI: put people on it (user, card, face), take them off, open the door, set its clock,
// read its punches, say how it is. The terminal decides at the door on its own; this only keeps it in step with CommunityOS.
import { DigestClient } from './digest.js';
import { Isapi } from './isapi.js';
import { toPunch, deviceTime, offsetOf } from './events.js';

const EXISTS = /AlreadyExist/i;                 // employeeNoAlreadyExist, deviceUserAlreadyExist
const NOT_THERE = /NotExist|noUser|notFound|noMatch|noRecord/i;
const OURS = /^[0-9a-f]{32}$/;

export class HikvisionDriver {
  constructor(device, cfg = {}) {
    this.cfg = cfg;
    this.client = new DigestClient({ host: device.host, port: device.port, tls: device.useTls, username: device.username, password: device.password, strictTls: !!cfg.deviceTlsStrict,
      pin: cfg.pins?.pin(device.id) || null, onPin: (fp) => cfg.pins?.setPin(device.id, fp) });
    this.isapi = new Isapi(this.client);
    this.device = device; this.offset = null; this.timeZone = null; this.catchUpFrom = null;
  }
  get id() { return this.device.id; }
  update(device) {
    this.device = device;
    this.client.update({ host: device.host, port: device.port, tls: device.useTls, username: device.username, password: device.password });
  }
  close() { this.client.close(); }

  /** How the device is: reachable, which one, its clock against ours (seconds, + = ahead), how many users it holds. */
  async health(clockOffsetMs = 0) {
    const h = { deviceId: this.id, online: false, serial: null, model: null, firmware: null, clockDriftS: null, enrolledCount: null, lastError: null };
    try {
      const info = await this.isapi.deviceInfo();
      Object.assign(h, { online: true, serial: info.serial, model: info.model, firmware: info.firmware });
      const t = await this.isapi.time();
      this.offset = offsetOf(t.localTime) || this.offset; this.timeZone = t.timeZone || this.timeZone;
      const dev = Date.parse(t.localTime);
      if (Number.isFinite(dev)) h.clockDriftS = Math.round((dev - (Date.now() + clockOffsetMs)) / 1000);
      h.enrolledCount = await this.isapi.userCount().catch(() => null);
    } catch (e) { h.lastError = String(e.message).slice(0, 300); }
    return h;
  }

  /** One job from CommunityOS -> { ok, error, permanent }. */
  async run(task, clockOffsetMs = 0) {
    try {
      switch (task.kind) {
        case 'enrol': await this.enrol(task); break;
        case 'remove': await this.remove(task.employeeNo); break;
        case 'open': await this.isapi.openDoor(this.device.doorNo || 1); break;
        case 'set-time': await this.setTime(clockOffsetMs); break;
        case 'catch-up': this.catchUpFrom = new Date(Date.now() - 7 * 86_400_000); break;
        default: return { ok: false, error: `This bridge does not know the job "${task.kind}"`, permanent: true };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 300), permanent: !!e.permanent };
    }
  }

  async enrol(t) {
    const user = {
      employeeNo: t.employeeNo, name: t.name || t.employeeNo.slice(0, 8), userType: 'normal',
      Valid: { enable: true, beginTime: `${t.validFrom || '2020-01-01'}T00:00:00`, endTime: `${t.validTo || '2037-12-31'}T23:59:59`, timeType: 'local' },
      doorRight: String(this.device.doorNo || 1), RightPlan: [{ doorNo: this.device.doorNo || 1, planTemplateNo: '1' }],
    };
    try { await this.isapi.addUser(user); }
    catch (e) { if (!EXISTS.test(e.sub || e.message)) throw e; await this.isapi.modifyUser(user); }
    await this.isapi.deleteCards(t.employeeNo).catch(() => {});          // the card is set afresh (it may have changed or gone)
    if (t.cardNo) await this.isapi.addCard(t.employeeNo, t.cardNo);
    if (t.faceJpegBase64) {
      await this.isapi.deleteFace(t.employeeNo).catch(() => {});
      await this.isapi.addFace(t.employeeNo, Buffer.from(t.faceJpegBase64, 'base64'));
    }
  }
  async remove(employeeNo) {
    await this.isapi.deleteFace(employeeNo).catch(() => {});
    try { await this.isapi.deleteUser(employeeNo); }
    catch (e) { if (!NOT_THERE.test(e.sub || e.message)) throw e; }        // not on the device: that is what we wanted
  }
  /** The device's clock to CommunityOS's time, in the device's own zone. */
  async setTime(clockOffsetMs) {
    if (!this.offset) await this.health(clockOffsetMs);
    await this.isapi.setTime(deviceTime(new Date(Date.now() + clockOffsetMs), this.offset), this.timeZone);
  }

  /**
   * The punches after `cursor` (the device's own event numbers), read in pages from a little before the last one's time. A snapshot is
   * fetched for the punches `wantPhoto` picks. -> punches, oldest first
   */
  async poll(cursor, { wantPhoto = () => false, extra = { pass: [], fail: [] }, maxPerPoll = 3000 } = {}) {
    if (this.client.paused) return [];
    if (!this.offset) { await this.health(); if (!this.offset) return []; }
    const now = Date.now();
    const from = this.catchUpFrom || new Date(cursor.at ? Date.parse(cursor.at) - 10 * 60_000 : now - 86_400_000);
    const to = new Date(now + 86_400_000);                               // the device's clock may be ahead
    const searchID = Math.random().toString(36).slice(2);
    const found = new Map();
    for (let position = 0; position < maxPerPoll;) {
      const page = await this.isapi.events({ searchID, position, max: 30, from: deviceTime(from, this.offset), to: deviceTime(to, this.offset) });
      for (const e of page.list) {
        const p = toPunch(e, extra);
        if (p && p.eventNo > cursor.no) found.set(p.eventNo, p);
      }
      position += page.list.length;
      if (!page.more || !page.list.length) break;
    }
    this.catchUpFrom = null;
    const out = [...found.values()].sort((a, b) => a.eventNo - b.eventNo);
    for (const p of out) {
      if (p.pictureURL && wantPhoto(p)) {
        const jpg = await this.isapi.picture(p.pictureURL).catch(() => null);
        if (jpg && jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length <= 290_000) p.photo = 'data:image/jpeg;base64,' + jpg.toString('base64');
      }
      delete p.pictureURL;
    }
    return out;
  }
  static ours(employeeNo) { return OURS.test(employeeNo || ''); }
}

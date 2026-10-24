// What must survive a restart or a long outage: the punches not yet sent, and where each device's events were read up to.
// Small JSON files in the state folder, written whole and renamed into place (a power cut leaves the old file, never half a file).
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';

const MAX_WAITING = 20_000;        // punches kept while CommunityOS cannot be reached
const KEEP_PHOTOS_UNDER = 500;     // past this many waiting, new punches are kept without their snapshot

export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.outbox = this.read('outbox.json', []);
    this.cursors = this.read('cursors.json', {});
    this.dirty = false;
  }
  read(name, empty) {
    const f = join(this.dir, name);
    if (!existsSync(f)) return empty;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { log.warn(`state file ${name} unreadable, starting it afresh`, e); return empty; }
  }
  write(name, value) {
    const f = join(this.dir, name), tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, f);
  }

  /** Where a device's events were read up to (its own event number and that event's time). */
  cursor(deviceId) { return this.cursors[deviceId] || { no: 0, at: null }; }
  /** Keep a punch to send (once per device and event number) and move the cursor past it. */
  add(deviceId, punch) {
    if (this.outbox.some((x) => x.deviceId === deviceId && x.punch.eventNo === punch.eventNo)) return false;
    if (this.outbox.length >= MAX_WAITING) { log.error(`${MAX_WAITING} punches are waiting: dropping the oldest`); this.outbox.shift(); }
    const p = this.outbox.length >= KEEP_PHOTOS_UNDER ? { ...punch, photo: null } : punch;
    this.outbox.push({ deviceId, punch: p });
    const c = this.cursor(deviceId);
    if (punch.eventNo > c.no) this.cursors[deviceId] = { no: punch.eventNo, at: punch.at };
    this.dirty = true;
    return true;
  }
  /** The server's own record of where the device stopped (after a reinstall the state folder is empty). */
  serverCursor(deviceId, no) {
    const c = this.cursor(deviceId);
    if (no > c.no) { this.cursors[deviceId] = { no, at: c.at }; this.dirty = true; }
  }
  /** The next batch for one device: at most `max` punches and about 4 MB. */
  batch(max = 20) {
    if (!this.outbox.length) return null;
    const deviceId = this.outbox[0].deviceId;
    const out = []; let size = 0;
    for (const x of this.outbox) {
      if (x.deviceId !== deviceId) continue;
      const n = JSON.stringify(x.punch).length;
      if (out.length && (out.length >= max || size + n > 4_000_000)) break;
      out.push(x.punch); size += n;
    }
    return { deviceId, punches: out };
  }
  sent(deviceId, punches) {
    const done = new Set(punches.map((p) => p.eventNo));
    this.outbox = this.outbox.filter((x) => !(x.deviceId === deviceId && done.has(x.punch.eventNo)));
    this.dirty = true;
  }
  save() {
    if (!this.dirty) return;
    this.write('outbox.json', this.outbox); this.write('cursors.json', this.cursors);
    this.dirty = false;
  }
}

// The bridge's loops: the device list from CommunityOS, its jobs, the devices' punches (kept on disk until CommunityOS has them), health.
// Each loop waits for its own previous round, so a slow device never piles up work; one device's trouble never stops another's.
import { DRIVERS } from './drivers/index.js';
import { log } from './log.js';

const OURS = /^[0-9a-f]{32}$/;

export class Bridge {
  constructor(cfg, { cloud, store, drivers = DRIVERS }) {
    this.cfg = cfg; this.cloud = cloud; this.store = store; this.drivers = drivers;
    this.devices = new Map();            // device id -> driver
    this.clockOffsetMs = 0;              // CommunityOS's clock minus ours
    this.timers = []; this.stopped = false; this.blockedUntil = 0; this.helloOk = false;
    this.busy = new Set();
  }

  async start() {
    log.info(`bridge starting (CommunityOS at ${this.cfg.server})`);
    await this.tick('hello', () => this.hello());
    this.every('hello', this.cfg.helloEveryMs, () => this.hello());
    this.every('tasks', this.cfg.tasksEveryMs, () => this.tasks());
    this.every('events', this.cfg.eventsEveryMs, () => this.events());
    this.every('flush', this.cfg.flushEveryMs, () => this.flush());
    this.every('health', this.cfg.healthEveryMs, () => this.health(), 2_000);
  }
  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.store.save();
    for (const d of this.devices.values()) d.close();
    log.info('bridge stopped');
  }
  every(name, ms, fn, first = ms) {
    const loop = async () => { if (this.stopped) return; await this.tick(name, fn); if (!this.stopped) this.timers.push(setTimeout(loop, ms)); };
    this.timers.push(setTimeout(loop, first));
  }
  async tick(name, fn) {
    if (Date.now() < this.blockedUntil && name !== 'events') return;      // the token was refused: keep reading the devices, call nobody
    try { await fn(); }
    catch (e) {
      if (e.status === 401 || e.status === 403) {
        this.blockedUntil = Date.now() + 60_000;
        log.error('CommunityOS refused this bridge\'s token (revoked, or a new one was made): trying again in a minute', e);
      } else log.warn(`${name}: ${e.message}`);
    }
  }

  /** The devices this bridge looks after, with their passwords and where their events stopped. */
  async hello() {
    const h = await this.cloud.hello();
    if (h.serverTime) this.clockOffsetMs = Date.parse(h.serverTime) - Date.now();
    const seen = new Set();
    for (const d of h.devices || []) {
      const Driver = this.drivers[d.driver];
      if (!Driver) { log.warn(`${d.name}: no driver "${d.driver}" in this bridge`); continue; }
      seen.add(d.id);
      this.store.serverCursor(d.id, d.lastEventNo || 0);
      if (this.devices.has(d.id)) this.devices.get(d.id).update(d);
      else { this.devices.set(d.id, new Driver(d, { ...this.cfg, pins: this.store })); log.info(`looking after ${d.name} at ${d.host}${d.port ? ':' + d.port : ''} (${d.gate}, counts ${d.direction})`); }
    }
    for (const [id, drv] of this.devices) if (!seen.has(id)) { log.info(`${drv.device.name} is no longer on this bridge`); drv.close(); this.devices.delete(id); }
    if (!this.helloOk) { this.helloOk = true; log.info(`signed in as "${h.name}": ${this.devices.size} device(s)`); }
    this.store.save();
  }

  /** CommunityOS's jobs, one device at a time each, every device in parallel; each result is reported back. */
  async tasks() {
    const list = await this.cloud.tasks(10);
    if (!list || !list.length) return;
    const byDevice = new Map();
    for (const t of list) { if (!byDevice.has(t.deviceId)) byDevice.set(t.deviceId, []); byDevice.get(t.deviceId).push(t); }
    await Promise.all([...byDevice].map(async ([deviceId, jobs]) => {
      const drv = this.devices.get(deviceId);
      for (const t of jobs) {
        const r = drv ? await drv.run(t, this.clockOffsetMs) : { ok: false, error: 'This bridge does not have that device (yet): it will be tried again', permanent: false };
        if (r.ok) log.info(`${drv.device.name}: ${t.kind}${t.employeeNo ? ' ' + (t.name || t.employeeNo.slice(0, 8)) : ''} done`);
        else log.warn(`${drv ? drv.device.name : deviceId}: ${t.kind} failed: ${r.error}`);
        await this.cloud.taskResult(t.id, r.ok, r.error, r.permanent);
      }
    }));
  }

  /** New punches from every device, kept on disk first. */
  async events() {
    const want = (p) => this.cfg.eventPhotos === 'all' || (this.cfg.eventPhotos !== 'none' && (p.result === 'Refused' || !OURS.test(p.employeeNo || '')));
    await Promise.all([...this.devices.values()].map(async (drv) => {
      if (this.busy.has(drv.id)) return;
      this.busy.add(drv.id);
      try {
        const punches = await drv.poll(this.store.cursor(drv.id), { wantPhoto: want, extra: { pass: this.cfg.passMinors || [], fail: this.cfg.failMinors || [] } });
        let n = 0;
        for (const p of punches) if (this.store.add(drv.id, p)) n++;
        if (n) log.debug(`${drv.device.name}: ${n} new punch(es)`);
      } catch (e) { log.debug(`${drv.device.name}: events not read (${e.message})`); }
      finally { this.busy.delete(drv.id); }
    }));
    this.store.save();
  }

  /** Waiting punches to CommunityOS, oldest first, in batches; kept until it has them. */
  async flush() {
    for (let i = 0; i < 50; i++) {
      const b = this.store.batch(20);
      if (!b) break;
      try {
        const r = await this.cloud.events(b.deviceId, b.punches);
        this.store.sent(b.deviceId, b.punches);
        if (r && r.flagged) log.info(`${r.flagged} punch(es) flagged for the security team`);
      } catch (e) {
        if (e.status === 400 || e.status === 404) {          // CommunityOS will never take these (the device left this bridge): do not block the rest
          log.error(`punches of device ${b.deviceId} not taken (${e.message}): dropped`);
          this.store.sent(b.deviceId, b.punches);
        } else { this.store.save(); throw e; }
      }
    }
    this.store.save();
  }

  async health() {
    if (!this.devices.size) return;
    const list = await Promise.all([...this.devices.values()].map((d) => d.health(this.clockOffsetMs)));
    for (const h of list) if (h.lastError) log.warn(`${this.devices.get(h.deviceId).device.name}: ${h.lastError}`);
    await this.cloud.health(list);
  }
}

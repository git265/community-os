// HTTP to a device on the community network, with Digest login (what Hikvision ISAPI asks for).
// One request at a time per device. A refused login is never retried in a loop: these devices lock the admin user for 30 minutes
// after about five failures, so after two refusals (or when the device says few tries are left) the device is left alone for 30 minutes.
// On https a device's own (self-signed) certificate is pinned the first time: if it ever changes, nothing is sent to it.
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

export class DeviceAuthError extends Error {
  constructor(message, { locked = false } = {}) { super(message); this.name = 'DeviceAuthError'; this.locked = locked; this.permanent = false; }
}
export class DeviceNetError extends Error { constructor(message) { super(message); this.name = 'DeviceNetError'; } }

const PAUSE_MS = 30 * 60 * 1000;
const md5 = (s) => createHash('md5').update(s).digest('hex');

export class DigestClient {
  constructor({ host, port, tls = false, username, password, strictTls = false, timeoutMs = 15_000, pin = null, onPin = () => {} }) {
    this.base = { host, port: port || (tls ? 443 : 80), tls };
    this.strictTls = strictTls; this.pin = pin; this.onPin = onPin;
    this.username = username || 'admin'; this.password = password || '';
    this.timeoutMs = timeoutMs;
    this.agent = tls ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: strictTls }) : new http.Agent({ keepAlive: true, maxSockets: 1 });
    this.challenge = null; this.nc = 0; this.refused = 0; this.pausedUntil = 0; this.chain = Promise.resolve();
  }
  /** New details from CommunityOS: a changed password lifts the pause (someone fixed it). */
  update({ host, port, tls, username, password }) {
    const changed = password !== this.password || (username || 'admin') !== this.username;
    if (host !== this.base.host || (port || (tls ? 443 : 80)) !== this.base.port || !!tls !== this.base.tls) { this.base = { host, port: port || (tls ? 443 : 80), tls: !!tls }; this.challenge = null; }
    if (changed) { this.username = username || 'admin'; this.password = password || ''; this.challenge = null; this.refused = 0; this.pausedUntil = 0; }
  }
  get paused() { return Date.now() < this.pausedUntil; }

  /** method, path (with query), { body: Buffer|string, headers, timeoutMs } -> { status, headers, body: Buffer } */
  request(method, path, opts = {}) {
    const run = () => this.send(method, path, opts);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  async send(method, path, { body, headers = {}, timeoutMs } = {}) {
    if (this.paused) throw new DeviceAuthError(`Login paused until ${new Date(this.pausedUntil).toISOString()} after the device refused the password (to avoid its lockout)`);
    let res = await this.raw(method, path, body, headers, this.challenge ? this.authorize(method, path) : null, timeoutMs);
    if (res.status !== 401) return this.ok(res);
    this.checkLock(res);
    const ch = parseChallenge(res.headers['www-authenticate']);
    if (!ch) throw new DeviceAuthError('The device asked for a login it did not describe (Digest expected)');
    this.challenge = ch; this.nc = 0;                       // a first request, or an old nonce: once more with the new one
    res = await this.raw(method, path, body, headers, this.authorize(method, path), timeoutMs);
    if (res.status !== 401) return this.ok(res);
    this.checkLock(res);
    this.challenge = null;
    if (++this.refused >= 2) this.pausedUntil = Date.now() + PAUSE_MS;
    throw new DeviceAuthError('The device refused the user name or password' + (this.paused ? ' (paused for 30 minutes to avoid its lockout)' : ''));
  }
  ok(res) { this.refused = 0; return res; }
  checkLock(res) {
    const text = res.body.toString('utf8');
    const locked = /<lockStatus>\s*lock(ed)?\s*<\/lockStatus>/i.test(text);
    const left = Number((text.match(/<retryLoginTime>\s*(\d+)\s*<\/retryLoginTime>/i) || [])[1]);
    const unlock = Number((text.match(/<unlockTime>\s*(\d+)\s*<\/unlockTime>/i) || [])[1]);
    if (locked) {
      this.pausedUntil = Date.now() + (Number.isFinite(unlock) && unlock > 0 ? unlock * 1000 : PAUSE_MS);
      throw new DeviceAuthError(`The device has locked its admin user for ${Math.round((this.pausedUntil - Date.now()) / 60000)} min (too many refused logins)`, { locked: true });
    }
    if (Number.isFinite(left) && left > 0 && left <= 2 && this.challenge) this.pausedUntil = Date.now() + PAUSE_MS;   // only a few tries left: stop now
  }
  authorize(method, uri) {
    const ch = this.challenge;
    const nc = (++this.nc).toString(16).padStart(8, '0');
    const cnonce = randomBytes(8).toString('hex');
    let ha1 = md5(`${this.username}:${ch.realm}:${this.password}`);
    if ((ch.algorithm || '').toUpperCase() === 'MD5-SESS') ha1 = md5(`${ha1}:${ch.nonce}:${cnonce}`);
    const ha2 = md5(`${method}:${uri}`);
    const qop = ch.qop ? (ch.qop.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : ch.qop.split(',')[0].trim()) : null;
    const response = qop ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${ch.nonce}:${ha2}`);
    const parts = [`username="${this.username}"`, `realm="${ch.realm}"`, `nonce="${ch.nonce}"`, `uri="${uri}"`, `algorithm=${ch.algorithm || 'MD5'}`, `response="${response}"`];
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
    return 'Digest ' + parts.join(', ');
  }
  raw(method, path, body, headers, auth, timeoutMs) {
    const lib = this.base.tls ? https : http;
    const data = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    return new Promise((resolve, reject) => {
      const req = lib.request({
        host: this.base.host, port: this.base.port, method, path, agent: this.agent,
        headers: { ...headers, ...(auth ? { Authorization: auth } : {}), ...(data ? { 'Content-Length': data.length } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', (e) => reject(new DeviceNetError(`The device's answer broke off (${e.message})`)));
      });
      req.setTimeout(timeoutMs || this.timeoutMs, () => req.destroy(new Error('timed out')));
      req.on('error', (e) => reject(e instanceof DeviceNetError ? e : new DeviceNetError(`The device at ${this.base.host}:${this.base.port} is not reachable (${e.code || e.message})`)));
      const send = () => { if (data) req.write(data); req.end(); };
      if (!this.base.tls || this.strictTls) return send();
      // our own check of the device's certificate, before anything is written to it
      req.on('socket', (sock) => {
        const go = () => { const bad = this.checkPin(sock); if (bad) req.destroy(bad); else send(); };
        const cert = typeof sock.getPeerCertificate === 'function' ? sock.getPeerCertificate() : null;
        if (cert && Object.keys(cert).length) go(); else sock.once('secureConnect', go);
      });
    });
  }
  checkPin(sock) {
    const fp = sock.getPeerCertificate()?.fingerprint256;
    if (!fp) return new DeviceNetError('The device sent no certificate');
    if (!this.pin) { this.pin = fp; this.onPin(fp); return null; }
    return fp === this.pin ? null : new DeviceNetError(`The device's certificate has changed (it was ${this.pin.slice(0, 23)}…): nothing was sent. If the device was replaced or reset, forget its certificate on the bridge (see README).`);
  }
  close() { this.agent.destroy(); }
}

/** The Digest challenge among the WWW-Authenticate headers (there may be a Basic one too). */
export function parseChallenge(header) {
  const all = Array.isArray(header) ? header : header ? [header] : [];
  for (const h of all) {
    const m = /^\s*Digest\s+(.*)$/i.exec(h);
    if (!m) continue;
    const out = {};
    for (const p of m[1].matchAll(/([a-zA-Z]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g)) out[p[1].toLowerCase()] = p[2] ?? p[3];
    if (out.nonce && out.realm !== undefined) return { realm: out.realm, nonce: out.nonce, qop: out.qop, opaque: out.opaque, algorithm: out.algorithm, stale: /true/i.test(out.stale || '') };
  }
  return null;
}

// The CommunityOS side: every call goes out from the site (no port is opened at the gate), signed with the bridge's token.
import { AGENT } from './config.js';

export class CloudError extends Error {
  constructor(status, message, retry) { super(message); this.status = status; this.retry = retry; }
}

export class Cloud {
  constructor({ server, token, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    this.server = server; this.token = token; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  hello() { return this.call('GET', '/api/v1/bridge/hello'); }
  tasks(max = 10) { return this.call('GET', `/api/v1/bridge/tasks?max=${max}`); }
  taskResult(id, ok, error, permanent = false) { return this.call('POST', `/api/v1/bridge/tasks/${id}`, { ok, error: error ? String(error).slice(0, 1000) : null, permanent }); }
  events(deviceId, events) { return this.call('POST', '/api/v1/bridge/events', { deviceId, events }); }
  health(devices) { return this.call('POST', '/api/v1/bridge/health', { devices }); }

  async call(method, path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.server + path, {
        method, signal: ctl.signal,
        headers: { 'X-Bridge-Token': this.token, 'X-Bridge-Agent': AGENT, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new CloudError(0, `CommunityOS not reachable (${e.name === 'AbortError' ? 'timed out' : e.message})`, true);
    } finally { clearTimeout(timer); }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const why = (data && (data.detail || data.title)) || text.slice(0, 200) || res.statusText;
      // 401/403: the token is wrong or the bridge was revoked; 4xx: the request itself; 5xx and 429: try again later
      throw new CloudError(res.status, `CommunityOS said ${res.status}: ${why}`, res.status >= 500 || res.status === 429);
    }
    return data;
  }
}

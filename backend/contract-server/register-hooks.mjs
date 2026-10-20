// Preload (node --import ./register-hooks.mjs): source rewrite hook + the few browser globals the UI modules mention at import time.
import { register } from 'node:module';
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
// The address people open the app at (links in invites and messages are built from it): PUBLIC_APP_URL, e.g. https://app.communityos.in
// (sub-domain installs: lapaloma.communityos.in is derived from it) or http://localhost:5173 in development.
const pub = (() => { try { return new URL(process.env.PUBLIC_APP_URL || 'http://localhost:5173'); } catch { return new URL('http://localhost:5173'); } })();
const location = { hash: '', search: '', pathname: '/', hostname: pub.hostname, host: pub.host, port: pub.port, protocol: pub.protocol, origin: pub.origin, href: `${pub.origin}/` };
globalThis.window ??= { location, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, history: { replaceState() {} } };
globalThis.sessionStorage ??= mem(); globalThis.localStorage ??= mem();
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, createElement: () => ({}) };
register('./shared-hooks.mjs', import.meta.url);

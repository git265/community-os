// Field-level encryption at rest (AES-256-GCM) for personal data such as ID and bank numbers.
//   DATA_ENCRYPTION_KEY   32 bytes as 64 hex characters or base64 (generate: openssl rand -hex 32). Rotate by listing older keys in DATA_ENCRYPTION_KEY_OLD (comma separated).
//   ENCRYPT_FIELDS        field names to protect, anywhere in a record (default below). A protected field cannot be searched or sorted on.
// Stored as "enc:v1:<keyid>:<iv>:<tag>:<ciphertext>". Records written before the key was set stay readable (plain values pass through).
// This is on top of, not instead of, disk/database encryption (managed PostgreSQL, LUKS, TDE) and TLS in transit.
import crypto from 'node:crypto';
const asKey = (s) => { const b = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64'); if (b.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (64 hex characters).'); return b; };
const kid = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 8);
export const DEFAULT_ENCRYPT_FIELDS = ['aadhaar', 'panNumber', 'accountNumber', 'ssn', 'passportNumber', 'taxId'];

export function createFieldCrypto(env = process.env) {
  const cur = env.DATA_ENCRYPTION_KEY ? asKey(env.DATA_ENCRYPTION_KEY) : null;
  const all = new Map(); if (cur) all.set(kid(cur), cur);
  for (const s of String(env.DATA_ENCRYPTION_KEY_OLD || '').split(',').map((x) => x.trim()).filter(Boolean)) { const k = asKey(s); all.set(kid(k), k); }
  const fields = new Set(cur ? String(env.ENCRYPT_FIELDS || DEFAULT_ENCRYPT_FIELDS.join(',')).split(',').map((x) => x.trim()).filter(Boolean) : []);
  const enabled = !!cur && fields.size > 0;
  const enc = (v) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', cur, iv); const ct = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]); return `enc:v1:${kid(cur)}:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`; };
  const dec = (s) => { const [, , id, iv, tag, ct] = s.split(':'); const key = all.get(id); if (!key) throw new Error('No key for this encrypted value.'); const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64')); return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')); };
  const isEnc = (v) => typeof v === 'string' && v.startsWith('enc:v1:');
  const walk = (o, f) => { if (Array.isArray(o)) return o.map((x) => walk(x, f)); if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = f(k, v) ?? walk(v, f); return r; } return o; };
  return {
    enabled, fields,
    encryptRecord: (rec) => (!enabled ? rec : walk(rec, (k, v) => (fields.has(k) && v !== '' && v != null && !isEnc(v) && typeof v !== 'object' ? enc(v) : undefined))),
    decryptRecord: (rec) => walk(rec, (k, v) => (isEnc(v) ? dec(v) : undefined)),
    isEnc,
  };
}

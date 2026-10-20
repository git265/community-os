// Ciphertext written by the Node reference (fieldcrypto.mjs) for the Java FieldCryptoTest to open, and redactChanges answers for AuditTrail.
//   node test/gen-fieldcrypto-golden.mjs      (or: npm run gen:fieldcrypto)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFieldCrypto } from '../fieldcrypto.mjs';
import { redactChanges } from '../guards.mjs';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spring/src/test/resources/fieldcrypto/golden.json');
const K1 = crypto.createHash('sha256').update('fieldcrypto-golden-1').digest('hex'), K2 = crypto.createHash('sha256').update('fieldcrypto-golden-2').digest('base64');
const fields = 'aadhaar,taxId,secretNo';
const records = [
  { id: 'a', taxId: 'ABCDE1234F', name: 'Asha', other: 5 },
  { id: 'b', aadhaar: 123456789012, nested: { taxId: 'X-1', deeper: [{ secretNo: true }, 'plain', { secretNo: 'ü€😀 "quoted" \\ back\nline' }] }, list: ['taxId', { taxId: 'in-array' }] },
  { id: 'c', taxId: '', secretNo: null, aadhaar: 0, flag: false },
  { id: 'd', taxId: { not: 'a scalar' }, secretNo: [1, 2] },
  { id: 'e', secretNo: 12.5 },
];
const a = createFieldCrypto({ DATA_ENCRYPTION_KEY: K1, ENCRYPT_FIELDS: fields });
const rotated = createFieldCrypto({ DATA_ENCRYPTION_KEY: K2, DATA_ENCRYPTION_KEY_OLD: K1, ENCRYPT_FIELDS: fields });
const changes = [
  { field: 'password', from: 'a', to: 'b' }, { field: 'title', from: 'x', to: 'y' }, { field: 'otpCode', from: '', to: '123456' }, { label: 'Card number', from: null, to: '4111' },
  { field: 'taxId', from: 'old', to: 'new' }, { field: 'Pin code', from: 1, to: 2 }, { field: 'shipping', from: 'a', to: 'b' }, { field: '', label: 'Authorization', from: 'x', to: '' }, { field: 'notes', from: 'x', to: 'y' },
  { field: 'accountNo', from: 0, to: false }, { field: 'PAN number', from: 'p', to: 'q' }, { field: 'panel', from: 'p', to: 'q' },
];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  key1: K1, key2: K2, fields,
  plain: records, encryptedWithKey1: records.map((r) => a.encryptRecord(r)), encryptedWithKey2: records.map((r) => rotated.encryptRecord(r)),
  extra: ['taxId'], changes, redacted: redactChanges(changes, new Set(['taxId'])),
}, null, 1));
console.log('wrote', OUT);

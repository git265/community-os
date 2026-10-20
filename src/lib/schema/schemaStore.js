import { storage, COLLECTIONS } from '../storage/index.js';
import { DEFAULT_SCHEMAS } from './registry.js';
import { requirePermission, auditAdmin } from '../security/adminGuard.js';

// Schemas start from DEFAULT_SCHEMAS but are then persisted (and mutated) via
// the same storage adapter as everything else, under COLLECTIONS.SCHEMA - one
// record per section, id = section id. This is what makes custom attributes
// and permission changes durable across a session and, later, across the
// real backend: Super Admin edits go through putSchema() -> storage.put(),
// exactly like any other data write.

export async function loadSchemas() {
  const stored = await storage.list(COLLECTIONS.SCHEMA);
  if (stored.length > 0) {
    // an app update may add sections / fields: merge them in without touching anything a Super Admin changed
    const out = [];
    for (const d of DEFAULT_SCHEMAS) {
      const cur = stored.find((x) => x.id === d.id);
      if (!cur) { await storage.put(COLLECTIONS.SCHEMA, d); out.push(d); continue; }
      const missing = d.fields.filter((f) => !cur.fields.some((x) => x.key === f.key));
      if ((d.rev || 0) > (cur.rev || 0)) {
        // a newer app revision changed what existing fields ARE (type, label, required, order) - not who can see/edit them
        const ACCESS = ['viewableBy', 'editableBy'];
        const fields = d.fields.map((df) => {
          const c = cur.fields.find((x) => x.key === df.key);
          if (!c) return df;
          const keep = Object.fromEntries(ACCESS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
          return { ...df, ...keep };
        });
        const custom = cur.fields.filter((x) => !d.fields.some((df) => df.key === x.key));
        const next = { ...cur, rev: d.rev, fields: [...fields, ...custom] };
        await storage.put(COLLECTIONS.SCHEMA, next); out.push(next);
      } else if (missing.length) { const next = { ...cur, fields: [...cur.fields, ...missing] }; await storage.put(COLLECTIONS.SCHEMA, next); out.push(next); } else out.push(cur);
    }
    return [...out, ...stored.filter((x) => !DEFAULT_SCHEMAS.some((d) => d.id === x.id))];
  }

  // First run: seed storage from the defaults so Super Admin edits have
  // something to persist against.
  for (const schema of DEFAULT_SCHEMAS) {
    await storage.put(COLLECTIONS.SCHEMA, schema);
  }
  return DEFAULT_SCHEMAS;
}

export async function putSchema(schema, change) {
  requirePermission('MANAGE_ROLES'); // Studio = field-level access control, Super Admin / role managers only
  const saved = await storage.put(COLLECTIONS.SCHEMA, schema);
  if (change) await auditAdmin({ what: 'Studio (field access)', recordId: schema.id, action: 'Update', summary: schema.label ?? schema.id, changes: [change] });
  return saved;
}

/** Super Admin adds a custom field to a section at runtime. */
export async function addCustomField(sectionId, field) {
  const schema = await storage.get(COLLECTIONS.SCHEMA, sectionId);
  if (!schema) throw new Error(`Unknown section: ${sectionId}`);
  const next = {
    ...schema,
    fields: [...schema.fields, { ...field, isCustom: true }],
  };
  return putSchema(next, { field: field.key, label: 'Custom field added', from: '—', to: field.label ?? field.key });
}

/** Super Admin changes who can view/edit an existing field. */
export async function updateFieldAccess(sectionId, fieldKey, { viewableBy, editableBy }) {
  const schema = await storage.get(COLLECTIONS.SCHEMA, sectionId);
  if (!schema) throw new Error(`Unknown section: ${sectionId}`);
  const next = {
    ...schema,
    fields: schema.fields.map((f) =>
      f.key === fieldKey
        ? { ...f, viewableBy: viewableBy ?? f.viewableBy, editableBy: editableBy ?? f.editableBy }
        : f
    ),
  };
  return putSchema(next, { field: fieldKey, label: `Field access: ${fieldKey}`, from: 'previous access', to: `view: ${(viewableBy ?? []).length} roles · edit: ${(editableBy ?? []).length} roles` });
}

export async function removeField(sectionId, fieldKey) {
  const schema = await storage.get(COLLECTIONS.SCHEMA, sectionId);
  if (!schema) throw new Error(`Unknown section: ${sectionId}`);
  const next = { ...schema, fields: schema.fields.filter((f) => f.key !== fieldKey) };
  return putSchema(next, { field: fieldKey, label: 'Field removed', from: fieldKey, to: '—' });
}

/** Super Admin edits a field's definition: label, required, options, help text, table column. (Built-in fields keep their key and type.) */
export async function updateField(sectionId, fieldKey, patch) {
  const schema = await storage.get(COLLECTIONS.SCHEMA, sectionId);
  if (!schema) throw new Error(`Unknown section: ${sectionId}`);
  const allowed = ['label', 'required', 'options', 'placeholder', 'showInTable'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  const field = schema.fields.find((f) => f.key === fieldKey);
  if (!field) throw new Error(`Unknown field: ${fieldKey}`);
  const next = { ...schema, fields: schema.fields.map((f) => (f.key === fieldKey ? { ...f, ...clean } : f)) };
  const changes = Object.keys(clean).filter((k) => JSON.stringify(clean[k]) !== JSON.stringify(field[k])).map((k) => ({ field: fieldKey, label: `Field ${k}`, from: JSON.stringify(field[k] ?? '—'), to: JSON.stringify(clean[k]) }));
  if (!changes.length) return field;
  await putSchema(next, changes[0]);
  return next.fields.find((f) => f.key === fieldKey);
}

/** Set one field's view/edit access for many roles at once (e.g. everyone in the EC group). */
export async function setFieldAccessFor(sectionId, fieldKey, roleIds, { view, edit }) {
  const schema = await storage.get(COLLECTIONS.SCHEMA, sectionId);
  const f = schema?.fields.find((x) => x.key === fieldKey);
  if (!f) throw new Error(`Unknown field: ${fieldKey}`);
  let v = new Set(f.viewableBy); let e = new Set(f.editableBy);
  const apply = (set, on) => roleIds.forEach((id) => (on ? set.add(id) : set.delete(id)));
  if (view !== undefined) { apply(v, view); if (!view) apply(e, false); }
  if (edit !== undefined) { apply(e, edit); if (edit) apply(v, true); }
  return updateFieldAccess(sectionId, fieldKey, { viewableBy: [...v], editableBy: [...e] });
}

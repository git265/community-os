// Shared shape for a field definition. Every section (properties, tickets,
// dues, vendors, documents, ...) is described by an array of these instead
// of hardcoded form/table markup. Components (DynamicForm, DynamicTable)
// render off this array, so:
//   - "all fields editable" = every field has an `editableBy` role list
//   - "custom attributes per section" = Super Admin appends new Field
//     objects (isCustom: true) to a section's schema at runtime
//   - "access level controlled by super admin" = viewableBy/editableBy are
//     only ever changed through the Studio module, which is itself gated
//     to the super_admin role

/**
 * @typedef {'text'|'number'|'date'|'select'|'boolean'|'textarea'} FieldType
 *
 * @typedef {Object} FieldDef
 * @property {string} key             - unique within the section, used as the record's property key
 * @property {string} label
 * @property {FieldType} type
 * @property {string[]} [options]     - for type 'select'
 * @property {boolean} [required]
 * @property {string[]} viewableBy    - role ids allowed to see this field
 * @property {string[]} editableBy    - role ids allowed to edit this field (subset of viewableBy)
 * @property {boolean} [isCustom]     - true for fields added by Super Admin at runtime
 * @property {boolean} [showInTable]  - show as a table column (vs. detail-only)
 *
 * @typedef {Object} SectionSchema
 * @property {string} id              - matches a COLLECTIONS key, e.g. 'properties'
 * @property {string} label
 * @property {FieldDef[]} fields
 */

export {};

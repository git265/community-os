// Field-level access is data (viewableBy / editableBy on each FieldDef), not
// code, so it can only be changed by Super Admin through the Studio module -
// everywhere else just reads these two pure functions.

export function canView(field, roleId) {
  return field.viewableBy.includes(roleId);
}

export function canEdit(field, roleId) {
  return field.editableBy.includes(roleId);
}

export function visibleFields(schema, roleId) {
  return schema.fields.filter((f) => canView(f, roleId));
}

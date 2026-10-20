import React, { useEffect, useState } from 'react';
import { deleteVerdict } from '../lib/deleteGuard.js';

/** Loads the delete verdict for a record: { checked, blocked, message }. */
export function useDeleteVerdict(collection, record) {
  const [v, setV] = useState({ checked: false, blocked: false, message: '' });
  useEffect(() => {
    let on = true;
    if (!record?.id) { setV({ checked: true, blocked: false, message: '' }); return undefined; }
    deleteVerdict(collection, record).then((r) => on && setV({ checked: true, ...r }));
    return () => { on = false; };
  }, [collection, record?.id]);
  return v;
}

/** The explanation shown instead of a Delete button. */
export function DeleteBlockedNote({ message }) {
  if (!message) return null;
  return <div className="delete-blocked" data-testid="delete-blocked" role="note">🛈 {message}</div>;
}

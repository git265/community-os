// Errors that mean "the server (or the rules) said no". Kept in their own tiny file so the storage layer can use them without
// importing the whole rule book.
export class AuthzError extends Error {
  constructor(message) { super(message); this.name = 'AuthzError'; }
}
/** Someone else saved this record after you opened it (HTTP 409). `current` is the stored version. Shown like a refusal: the list is reloaded. */
export class ConflictError extends AuthzError {
  constructor(current, message) { super(message || 'This record was changed by someone else while you were editing. The latest version is loaded - please review it and make your change again.'); this.name = 'ConflictError'; this.status = 409; this.current = current; }
}
/**
 * One change that takes several calls (the details, then the status; a new record, then its photos) went part of the way: what went through is
 * kept (`saved`, the record as it is now - null if it could not be read back), the rest was refused (`cause`). The screen treats the record as
 * saved (so pressing Save again does not make a second one) and says exactly what did not go through.
 */
export class PartialSaveError extends Error {
  constructor(saved, cause, done = '') {
    const why = cause?.message || 'it was refused';
    super(`${done ? `${done[0].toUpperCase()}${done.slice(1)} saved` : 'Part of the change was saved'}, but the rest was not: ${why}`);
    this.name = 'PartialSaveError'; this.saved = saved; this.cause = cause;
  }
}

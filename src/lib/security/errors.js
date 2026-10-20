// Errors that mean "the server (or the rules) said no". Kept in their own tiny file so the storage layer can use them without
// importing the whole rule book.
export class AuthzError extends Error {
  constructor(message) { super(message); this.name = 'AuthzError'; }
}
/** Someone else saved this record after you opened it (HTTP 409). `current` is the stored version. Shown like a refusal: the list is reloaded. */
export class ConflictError extends AuthzError {
  constructor(current, message) { super(message || 'This record was changed by someone else while you were editing. The latest version is loaded - please review it and make your change again.'); this.name = 'ConflictError'; this.status = 409; this.current = current; }
}

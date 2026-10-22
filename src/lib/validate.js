// Shared field checks, so every screen accepts and refuses the same values. Phones: lib/phone.js (validatePhone).
export const EMAIL_RE = /^\S+@\S+\.\S+$/;
export const isEmail = (v) => EMAIL_RE.test(String(v ?? '').trim());
/** Optional e-mail: blank is fine; anything typed must look like an address. Returns an error message or ''. */
export const emailError = (v, { required = false } = {}) => {
  const t = String(v ?? '').trim();
  if (!t) return required ? 'E-mail is required' : '';
  return isEmail(t) ? '' : 'Enter a valid e-mail address (name@example.com)';
};

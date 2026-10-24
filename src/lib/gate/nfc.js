// NFC tags on patrol posts, read with the phone (Web NFC: Chrome on Android, over https). Optional: a community turns it on in the gate
// rules; a phone that cannot read tags (iPhone, a computer) keeps the QR code. A tag is known by its serial number, which the server keeps
// only as a hash, so tapping the real tag is what counts, not a copy of what is written on it.

/** Can this phone and browser read NFC tags? */
export const nfcSupported = () => typeof window !== 'undefined' && 'NDEFReader' in window && window.isSecureContext !== false;

/** A tag's serial as the server wants it: plain upper-case hex ("04:a2:3f" -> "04A23F"). */
export const serialOf = (s) => String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();

const why = (e) => (e?.name === 'NotAllowedError' ? 'NFC was not allowed: allow NFC for this site in the browser settings'
  : e?.name === 'NotSupportedError' ? 'This phone cannot read NFC tags (or NFC is turned off in its settings)'
    : e?.name === 'AbortError' ? 'Stopped' : e?.message || 'The tag could not be read');

/**
 * Wait for one tag. Resolves { serial, text } (text: the first text record on it, if any); rejects when stopped, after `ms`, or when NFC
 * is not available. `onUnreadable` is told when a tag was in range but could not be read (a blank, unformatted tag, or moved too fast).
 */
export function readTag({ signal, ms = 30000, onUnreadable } = {}) {
  return new Promise((resolve, reject) => {
    if (!nfcSupported()) { reject(new Error('This phone cannot read NFC tags: scan the QR code instead')); return; }
    const ctl = new AbortController();
    const stop = (err) => { clearTimeout(timer); ctl.abort(); if (err) reject(err); };
    const timer = setTimeout(() => stop(new Error('No tag was tapped. Hold the top of the phone on the tag.')), ms);
    signal?.addEventListener('abort', () => stop(new Error('Stopped')));
    const reader = new window.NDEFReader();
    reader.onreading = (e) => {
      const serial = serialOf(e.serialNumber);
      let text = '';
      try { for (const r of e.message?.records || []) if (r.recordType === 'text') { text = new TextDecoder(r.encoding || 'utf-8').decode(r.data); break; } } catch { /* no text */ }
      stop(); resolve({ serial, text });
    };
    reader.onreadingerror = () => onUnreadable?.();
    reader.scan({ signal: ctl.signal }).catch((e) => stop(new Error(why(e))));
  });
}

/** Write a label onto a tag (a new, blank tag must be written once before phones can read it). */
export async function labelTag(text, { signal } = {}) {
  if (!nfcSupported()) throw new Error('This phone cannot write NFC tags');
  try { await new window.NDEFReader().write({ records: [{ recordType: 'text', data: text }] }, { signal }); }
  catch (e) { throw new Error(why(e)); }
}

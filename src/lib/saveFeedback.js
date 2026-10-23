// "It worked": a short green message after a save, a payment or any other change the person asked for.
//
// Every write that succeeds is announced (changes.js -> announceChange). When the person has just pressed a button that
// changes something - a form's submit button, or a button such as Save, Record payment, Pay, Publish, Approve - the first
// write announced after it shows one message, worded from that button ("Payment recorded", "Published", "Saved").
// Writes nobody asked for (scheduled jobs, read receipts) come with no such press and stay silent; a refused or failed
// write is never announced, so its own error message is the only one shown.
const WINDOW_MS = 8000;
// buttons that change something by themselves (buttons that open a form - Add, Enter reading, Rename - wait for that form's Save)
const VERB = /^(save|update|record|pay|confirm|submit|publish|book|approve|reject|post|send|assign|upload|apply|issue|done|mark|complete|reopen|close|cancel (booking|ticket|bill|pass|visit)|check (in|out)|clock (in|out)|accept|decline|refund|waive|delete|remove)\b/i;
const NOT = /^(cancel|close|discard|back|no|not now|dismiss)$/i;

let intent = null;   // { at, text } - the last press that asked for a change

const clean = (s) => String(s || '').replace(/[^\p{L}\p{N}₹.,' -]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The message for the button that was pressed. */
export function messageFor(label) {
  const t = clean(label).toLowerCase();
  if (/\b(pay|payment|paid|refund)\b/.test(t)) return /refund/.test(t) ? 'Refund recorded' : /^(record|mark)/.test(t) ? 'Payment recorded' : 'Payment received';
  if (/\bpublish/.test(t)) return 'Published';
  if (/^(send|post)\b/.test(t)) return 'Sent';
  if (/^book\b/.test(t)) return 'Booked';
  if (/^approve/.test(t)) return 'Approved';
  if (/^(reject|decline)/.test(t)) return 'Declined';
  if (/^upload/.test(t)) return 'Uploaded';
  if (/^assign/.test(t)) return 'Assigned';
  if (/^(add|create|raise|issue|generate|import)\b/.test(t)) return 'Added';
  if (/^cancel\b/.test(t)) return 'Cancelled';
  if (/^(delete|remove)\b/.test(t)) return 'Deleted';
  if (/^(mark|check|clock|done|complete|close|reopen|accept|move|rename|transfer|waive|apply|enter|confirm)\b/.test(t)) return 'Done';
  return 'Saved';
}

function note(label) { intent = { at: Date.now(), text: messageFor(label) }; }

let installed = false;
/** Listen for the presses that ask for a change (once, at start-up). */
export function installSaveFeedback() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('submit', (e) => {
    const b = e.submitter; const t = clean(b?.textContent || b?.value || '');
    if (NOT.test(t)) return;
    note(t || 'Save');
    // the form closed but nothing was written: the record already said this (Save with no edits)
    const mine = intent; const form = e.target;
    setTimeout(() => {
      if (intent !== mine || form?.isConnected) return;
      intent = null;
      window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { kind: 'success', message: 'No changes to save' } }));
    }, 1500);
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target?.closest?.('button');
    if (!b || b.type === 'submit' || b.disabled) return;
    const raw = String(b.textContent || '').trim();
    if (raw.startsWith('+')) return;          // "+ Add …" opens a form; its own Save is the press that counts
    const t = clean(raw || b.getAttribute('aria-label') || '');
    if (t && !NOT.test(t) && VERB.test(t)) note(t);
  }, true);
  // a refused or failed change ends that press: no "Saved" for it afterwards
  window.addEventListener('communityos:denied', (e) => { if (e.detail?.kind !== 'success') intent = null; });
}

/** A write went through (called for every announced change): show the message if the person just asked for it. */
export function changeSucceeded() {
  if (!intent || Date.now() - intent.at > WINDOW_MS || typeof window === 'undefined') return;
  const text = intent.text; intent = null;
  window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { kind: 'success', message: text } }));
}

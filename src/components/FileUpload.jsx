import React, { useRef, useState } from 'react';
import { validateFile, DOCUMENT_ACCEPT, MAX_BYTES } from '../lib/files/fileValidation.js';

/**
 * File picker that validates before anything is accepted.
 * onAccepted({ file, validation }) fires only for files that passed; the
 * parent keeps the file and decides when to persist it.
 */
export default function FileUpload({ onAccepted, onCleared, accept = DOCUMENT_ACCEPT, allowImages = false }) {
  const inputRef = useRef(null);
  const [state, setState] = useState({ phase: 'idle' }); // idle | scanning | ok | rejected

  async function pick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setState({ phase: 'scanning', name: file.name });
    const validation = await validateFile(file, { allowImages });
    if (!validation.ok) {
      setState({ phase: 'rejected', name: file.name, reason: validation.reason });
      if (inputRef.current) inputRef.current.value = '';
      onCleared?.();
      return;
    }
    setState({ phase: 'ok', name: file.name, size: file.size, status: validation.status });
    onAccepted({ file, validation });
  }

  return (
    <div className={`file-upload ${state.phase}`}>
      <input ref={inputRef} type="file" accept={accept} onChange={pick} data-testid="file-input" style={{ display: 'none' }} />
      <button type="button" className="btn secondary att-btn" data-testid="file-attach" disabled={state.phase === 'scanning'} onClick={() => inputRef.current?.click()}>📎 {state.phase === 'ok' ? 'Choose another file' : 'Attach file'}</button>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        PDF, Excel (.xls/.xlsx), text/CSV{allowImages ? ', PNG/JPG' : ''} · max {MAX_BYTES / 1024 / 1024} MB · files are checked before upload
      </div>
      {state.phase === 'scanning' && <div className="notice">🔍 Scanning {state.name}…</div>}
      {state.phase === 'ok' && (
        <div className="notice success">
          ✅ {state.name} ({Math.ceil(state.size / 1024)} KB) passed the upload checks
          {state.status === 'clean' ? ' and the virus scan.' : ' (type, signature, active-content and test-virus checks). A server-side antivirus scan runs when the backend is connected.'}
        </div>
      )}
      {state.phase === 'rejected' && <div className="notice error">🚫 {state.reason}</div>}
    </div>
  );
}

import React, { useRef, useState } from 'react';
import Modal from './Modal.jsx';

/**
 * Small "ask for a few values" dialog used before an action (e.g. record a payment: pick the account).
 *   const { ask, node } = usePrompt();
 *   const v = await ask({ title, subtitle, confirm, fields: [{ key, label, type: 'select'|'date'|'textarea'|'text', options, required, value }] });
 *   // v is an object of the values, or null if cancelled. Required fields are marked * and checked.
 */
export function usePrompt() {
  const [cfg, setCfg] = useState(null);
  const resolver = useRef(null);
  const ask = (c) => new Promise((resolve) => { resolver.current = resolve; setCfg(c); });
  const done = (v) => { resolver.current?.(v); resolver.current = null; setCfg(null); };
  return { ask, node: cfg ? <PromptForm cfg={cfg} onDone={done} /> : null };
}

function PromptForm({ cfg, onDone }) {
  const [vals, setVals] = useState(() => Object.fromEntries(cfg.fields.map((f) => [f.key, f.value ?? ''])));
  const [errors, setErrors] = useState({});
  const submit = (e) => {
    e.preventDefault();
    const miss = {};
    cfg.fields.forEach((f) => { if (f.required && String(vals[f.key] ?? '').trim() === '') miss[f.key] = `${f.label} is required`; });
    setErrors(miss);
    if (!Object.keys(miss).length) onDone(vals);
  };
  return (
    <Modal title={cfg.title} subtitle={cfg.subtitle} onClose={() => onDone(null)}>
      <form className="form-grid" onSubmit={submit}>
        {cfg.fields.map((f) => (
          <div key={f.key} className={`field${errors[f.key] ? ' invalid' : ''}`} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
            <label>{f.label}{f.required && ' *'}</label>
            {f.type === 'select' ? (
              <select aria-label={f.label} value={vals[f.key]} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}>
                <option value="">Select…</option>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea aria-label={f.label} rows={3} value={vals[f.key]} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : (
              <input aria-label={f.label} type={f.type === 'date' ? 'date' : 'text'} value={vals[f.key]} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
            )}
            {errors[f.key] && <div className="field-error">{errors[f.key]}</div>}
          </div>
        ))}
        <div className="form-actions">
          <button type="submit" className="btn">{cfg.confirm || 'OK'}</button>
          <button type="button" className="btn secondary" onClick={() => onDone(null)}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

/** Ask which account a payment is recorded against. Resolves { account, date } or null. */
export function askAccount(ask, accountNames, { title = 'Record payment', subtitle = 'Choose the bank account this payment went through.' } = {}) {
  return ask({
    title, subtitle, confirm: 'Record',
    fields: [
      { key: 'account', label: 'Account', type: 'select', options: accountNames, required: true },
      { key: 'date', label: 'Payment date', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
    ],
  });
}

import React from 'react';
import Modal from '../../components/Modal.jsx';
import { AttachmentList } from '../../components/Attachments.jsx';
import { fmtDate, money } from '../../lib/locale.js';

const inr = (n) => money(n, { round: false, maximumFractionDigits: 2 });
const dmy = (s) => fmtDate(s, { empty: '—' });

/**
 * Read-only detail of one record behind a payment row - the same idea as opening a maintenance task from Payments.
 *   rows      [[label, value]]   facts about the record (empty values are left out)
 *   payments  ledger rows paid against it
 *   steps     [{ name, state, who, at }]  approval trail
 *   files     attachment metas
 *   link      { label, onClick }  jump to the owning module
 * The record's own short id (EXP-0003, ABL-0007 …) is shown in the title so it can be quoted anywhere.
 */
export default function RecordDetail({ title, shortId, tag, tagTone = '', rows = [], payments = [], steps = [], files = [], note, link, onClose }) {
  return (
    <Modal title={title} subtitle={shortId ? `Record ${shortId}` : undefined} onClose={onClose}>
      <div data-testid="record-detail">
        {tag && <p><span className={`tag ${tagTone}`}>{tag}</span></p>}
        <dl className="rd-grid">
          {rows.filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== '—').map(([k, v]) => <div key={k} className="rd-row"><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {steps.length > 0 && (
          <div className="rd-sec"><b>Approval</b>
            {steps.map((s, i) => <div key={i} className="rd-step"><span className={`tag ${s.state === 'approved' ? 'green' : s.state === 'rejected' ? 'red' : 'orange'}`}>{s.state === 'approved' ? '✓ ' : ''}{s.state === 'rejected' ? 'Rejected' : s.state === 'approved' ? 'Approved' : 'Pending'}</span> {s.name}{s.who ? <small className="muted"> · {s.who}{s.at ? ` · ${s.at}` : ''}</small> : null}</div>)}
          </div>
        )}
        <div className="rd-sec"><b>Payments</b>
          {payments.length === 0 ? <div className="muted">No payment recorded yet.</div> : payments.map((l) => <div key={l.id} className="rd-step" data-testid="rd-payment"><span className="mono">{l.shortId}</span> · {dmy(l.date)} · <b>{inr(l.amount)}</b> · {l.account}{l.mode ? ` · ${l.mode}` : ''}{l.ref ? ` · ref ${l.ref}` : ''}</div>)}
        </div>
        {files.length > 0 && <div className="rd-sec"><b>Files</b><AttachmentList items={files} /></div>}
        {note && <div className="rd-sec muted">{note}</div>}
        {link && <div className="form-actions"><button type="button" className="btn secondary" onClick={link.onClick}>{link.label}</button></div>}
      </div>
    </Modal>
  );
}

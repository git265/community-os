import React, { useState } from 'react';
import { visibleCommentsFor } from './ticketEngine.js';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import RichText from '../../components/RichText.jsx';
import { Segmented } from '../../components/ui.jsx';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { persistPending, inlineImagesToFiles, screenFiles } from '../../lib/files/attachments.js';
import { tell } from '../../lib/net/activity.js';

/**
 * Generic discussion thread for one ticket/task, with a Public/Internal
 * visibility split: Public is Owner <-> Helpdesk <-> Assigned Staff (anyone
 * who can open the ticket sees it); Internal is FM <-> MEP <-> EC <-> Helpdesk
 * - field staff and EC only. Residents never see, or get the option to post,
 * Internal comments. For EC-type tasks, quotation/invoice conversation is
 * just an Internal comment made while that stage's status is in flight -
 * one generic thread rather than three separate ones.
 */
export default function CommentThread({ comments, ticketId, author, authorRoleId, isFieldStaff, canPost, onAdd }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [pending, setPending] = useState([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible = visibleCommentsFor(comments, ticketId, { isFieldStaff });

  async function submit(e) {
    e.preventDefault();
    if (isEmptyHtml(body) && !pending.length) return;
    setBusy(true);
    try {
      let attachments = [];
      const inline = inlineImagesToFiles(body);
      const pictures = inline.files.length ? (await screenFiles(inline.files)).accepted : [];
      const all = [...pending, ...pictures];
      if (all.length) {
        // internal notes keep their files away from residents too
        const metas = await persistPending(all, { ownerType: internal ? 'ticketInternal' : 'ticket', ownerId: ticketId });
        if (!metas) { setBusy(false); return; }
        attachments = metas;
      }
      await onAdd({
        ticketId,
        author,
        authorRoleId,
        visibility: internal ? 'Internal' : 'Public',
        body: isEmptyHtml(inline.html) ? '<p>(attachment)</p>' : inline.html,
        attachments,
        createdAt: new Date().toISOString(),
      });
      setBody(''); setPending([]); setAttachOpen(false); setBusy(false);
    } catch (e) { tell(e?.message || String(e), e?.name === 'NetworkError' || e?.name === 'TimeoutError' ? 'network' : 'error'); } finally { setBusy(false); }
  }

  const shown = isFieldStaff ? visible.filter((c) => (c.visibility === 'Internal') === internal) : visible;
  const nInternal = visible.filter((c) => c.visibility === 'Internal').length;
  const initials = (n) => (n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const mine = (c) => c.author === author;

  return (
    <div className="chat">
      {isFieldStaff && (
        <Segmented label="Who can see this" value={internal ? 'Internal' : 'Public'} onChange={(v) => setInternal(v === 'Internal')}
          options={[{ value: 'Public', label: 'Public', count: visible.length - nInternal }, { value: 'Internal', label: 'Internal', count: nInternal, tone: 'purple' }]} />
      )}
      {isFieldStaff && <small className="muted chat-hint">{internal ? 'Internal: only the EC and field staff see these notes.' : 'Public: the owner, helpdesk and assigned staff see these.'}</small>}
      {shown.length === 0 ? (
        <p className="muted chat-empty">No {isFieldStaff ? (internal ? 'internal notes' : 'public messages') : 'messages'} yet.</p>
      ) : (
        <div className="chat-list">
          {shown.map((c) => (
            <div key={c.id} className={`bubble${mine(c) ? ' mine' : ''}${c.authorRoleId === 'system' ? ' system' : ''}${c.visibility === 'Internal' ? ' internal' : ''}`}>
              <i className="av">{initials(c.author)}</i>
              <div className="bubble-body">
                <div className="bubble-head"><b>{c.author}</b>{c.visibility === 'Internal' && <span className="tag purple">Internal</span>}<small>{new Date(c.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div>
                <RichText html={c.body} />
                {(c.attachments || []).length > 0 && <div data-testid="chat-files"><AttachmentList items={c.attachments} /></div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {canPost && (
        <form onSubmit={submit} className="composer">
          <RichTextEditor value={body} onChange={setBody} placeholder={internal ? 'Add an internal note…' : 'Message the team…'} minHeight={48} />
          <button type="submit" className="btn send" disabled={busy}>{busy ? 'Posting…' : 'Post'}</button>
        </form>
      )}
    </div>
  );
}

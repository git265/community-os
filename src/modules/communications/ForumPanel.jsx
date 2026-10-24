import React, { useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canEdit } from '../../lib/access/permissions.js';
import AdminDelete from '../../components/AdminDelete.jsx';
import Modal from '../../components/Modal.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import RichText from '../../components/RichText.jsx';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';

const TEN_MIN_MS = 10 * 60 * 1000;

function Thread({ posts, parentId, topicId, currentUser, onReply, onReact, onDelete, depth = 0, superAdmin = false }) {
  const children = posts.filter((p) => (p.parentId || '') === parentId);
  if (children.length === 0) return null;
  return (
    <div className="thread">
      {children.map((p) => {
        const canDelete = superAdmin || currentUser && p.author === currentUser.name && Date.now() - new Date(p.createdAt).getTime() < TEN_MIN_MS;
        return (
          <div key={p.id} className={`thread-post${depth === 0 ? ' root' : ''}`}>
            <div><b>{p.author}</b> <small className="muted">{new Date(p.createdAt).toLocaleString()}</small></div>
            <RichText html={p.body} />
            <div className="reply-row">
              <button onClick={() => onReply(p.id)}>Reply</button>
              <button onClick={() => onReact(p)}>🙂 {p.reactions || 0}</button>
              {canDelete && <button onClick={() => onDelete(p)}>Delete</button>}
            </div>
            <Thread posts={posts} parentId={p.id} topicId={topicId} currentUser={currentUser} onReply={onReply} onReact={onReact} onDelete={onDelete} depth={depth + 1} superAdmin={superAdmin} />
          </div>
        );
      })}
    </div>
  );
}

const FORUM_CATEGORIES = ['General', 'Amenities', 'Security', 'Cultural Committee', 'Maintenance'];

export default function ForumPanel() {
  const { roleId, currentUser, schemaFor, hasPermission } = useApp();
  const { records: topics, save: saveTopic } = useCollection(COLLECTIONS.FORUM, 'Community Forum');
  const { records: posts, save: savePost, remove: removePost } = useCollection(COLLECTIONS.FORUM_POSTS, 'Forum Replies');

  const forumSchema = schemaFor(COLLECTIONS.FORUM);
  const canPost = forumSchema?.fields.some((f) => canEdit(f, roleId));
  const canModerate = roleId === 'super_admin' || hasPermission('MODERATE_FORUM');

  const [openTopicId, setOpenTopicId] = useState(() => { try { const t = sessionStorage.getItem('communityos:openTopic'); if (t) { setTimeout(() => sessionStorage.removeItem('communityos:openTopic'), 400); return t; } } catch { /* ignore */ } return null; });
  const [replyTo, setReplyTo] = useState(''); // '' = new root post
  const [replyBody, setReplyBody] = useState('');
  const [composing, setComposing] = useState(false);
  const [errs, setErrs] = useState({});
  const [replyErr, setReplyErr] = useState('');
  const [newTopic, setNewTopic] = useState({ title: '', category: 'General', kind: 'Discussion', pollOptionsText: '' });

  const openTopic = topics.find((t) => t.id === openTopicId);
  const topicPosts = posts.filter((p) => p.topicId === openTopicId);

  async function submitReply(e) {
    e.preventDefault();
    if (isEmptyHtml(replyBody)) return setReplyErr('Reply is required');
    if (String(replyBody).length > 5000) return setReplyErr('Keep the reply to about 5,000 characters (formatting counts too)');
    setReplyErr('');
    await savePost({
      topicId: openTopicId,
      parentId: replyTo,
      author: currentUser?.name || 'Anonymous',
      authorRoleId: roleId,
      body: replyBody,
      createdAt: new Date().toISOString(),
      reactions: 0,
    });
    await saveTopic({ ...openTopic, replies: topicPosts.length + 1 });
    setReplyBody('');
    setReplyTo('');
  }

  async function react(post) {
    await savePost({ ...post, reactions: (post.reactions || 0) + 1 });
  }

  async function deletePost(post) {
    await removePost(post.id);
    await saveTopic({ ...openTopic, replies: Math.max(0, (openTopic.replies || 1) - 1) });
  }

  async function vote(topic, index) {
    if (!currentUser) return;
    if ((topic.voters || []).includes(currentUser.name)) return;
    const options = topic.pollOptions.map((o, i) => (i === index ? { ...o, votes: o.votes + 1 } : o));
    await saveTopic({ ...topic, pollOptions: options, voters: [...(topic.voters || []), currentUser.name] });
  }

  async function submitNewTopic(e) {
    e.preventDefault();
    if (!newTopic.title.trim()) return setErrs({ title: 'Topic title is required' });
    if (newTopic.title.trim().length < 3 || newTopic.title.trim().length > 200) return setErrs({ title: 'A topic title has 3 to 200 characters' });
    if (newTopic.kind === 'Poll') {
      const opts = newTopic.pollOptionsText.split(',').map((x) => x.trim()).filter(Boolean);
      if (opts.length && (opts.length < 2 || opts.length > 12)) return setErrs({ title: 'A poll has 2 to 12 answers, separated by commas' });
      if (new Set(opts.map((x) => x.toLowerCase())).size !== opts.length) return setErrs({ title: 'Each poll answer is different' });
    }
    setErrs({});
    const base = { author: currentUser?.name || '', title: newTopic.title, category: newTopic.category, kind: newTopic.kind, replies: 0, pinned: false, status: 'Open' };
    if (newTopic.kind === 'Poll') {
      const options = newTopic.pollOptionsText.split(',').map((s) => s.trim()).filter(Boolean);
      base.pollOptions = (options.length > 0 ? options : ['Yes', 'No']).map((label) => ({ label, votes: 0 }));
      base.voters = [];
    }
    await saveTopic(base);
    setNewTopic({ title: '', category: 'General', kind: 'Discussion', pollOptionsText: '' });
    setComposing(false);
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Community forum</h2>
        <p className="muted" style={{ margin: "-4px 0 12px" }}>Start a discussion or a poll. Replies stay out of the audit trail.</p>
        {canPost && <button className="btn secondary" onClick={() => setComposing((v) => !v)}>+ New topic</button>}
      </div>

      {composing && (
        <form className="form-grid" style={{ margin: '12px 0', borderBottom: '1px solid var(--line)', paddingBottom: 14 }} onSubmit={submitNewTopic}>
          <div className={`field${errs.title ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}>
            <label>Topic title *</label>
            <input value={newTopic.title} onChange={(e) => setNewTopic((t) => ({ ...t, title: e.target.value }))} placeholder="Topic title" />
            {errs.title && <div className="field-error">{errs.title}</div>}
          </div>
          <div className="field">
            <label>Category</label>
            <select value={newTopic.category} onChange={(e) => setNewTopic((t) => ({ ...t, category: e.target.value }))}>
              {FORUM_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Kind</label>
            <select value={newTopic.kind} onChange={(e) => setNewTopic((t) => ({ ...t, kind: e.target.value }))}>
              <option>Discussion</option>
              <option>Poll</option>
            </select>
          </div>
          {newTopic.kind === 'Poll' && (
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Poll options (comma-separated)</label>
              <input value={newTopic.pollOptionsText} onChange={(e) => setNewTopic((t) => ({ ...t, pollOptionsText: e.target.value }))} placeholder="Support, Against, Need more info" />
            </div>
          )}
          <div className="form-actions">
            <button type="submit" className="btn">Post topic</button>
            <button type="button" className="btn secondary" onClick={() => setComposing(false)}>Cancel</button>
          </div>
        </form>
      )}

      {topics.length === 0 ? (
        <div className="empty">No topics yet.</div>
      ) : (
        <ul className="list">
          {[...topics].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).map((t) => (
            <li key={t.id} style={{ cursor: 'pointer' }} onClick={() => setOpenTopicId(t.id)}>
              <span>
                <b>{t.title}</b>{t.pinned && <span className="tag" style={{ marginLeft: 6 }}>Pinned</span>}
                <br /><small className="muted">{t.category} · {t.kind === 'Poll' ? 'Poll' : `${t.replies || 0} replies`}</small>
              </span>
              <span className="tag blue">{t.status}</span>
            </li>
          ))}
        </ul>
      )}

      {openTopic && (
        <Modal title={openTopic.title} subtitle="Community discussion. Replies are not part of the audit trail." onClose={() => { setOpenTopicId(null); setReplyTo(''); setReplyBody(''); }}>
          <p className="muted" style={{ marginTop: 0 }}>{openTopic.category} <span style={{ float: 'right' }}><AdminDelete collection={COLLECTIONS.FORUM} id={openTopic.id} label="topic" onDone={() => setOpenTopicId(null)} /></span></p>

          {openTopic.kind === 'Poll' && Array.isArray(openTopic.pollOptions) ? (
            <div>
              {(() => {
                const total = openTopic.pollOptions.reduce((s, o) => s + o.votes, 0) || 1;
                const voted = (openTopic.voters || []).includes(currentUser?.name);
                return openTopic.pollOptions.map((o, i) => (
                  <div key={o.label} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{o.label}</span>
                      <span className="muted">{Math.round((o.votes / total) * 100)}%</span>
                    </div>
                    <div className="poll-bar-track"><div className="poll-bar-fill" style={{ width: `${(o.votes / total) * 100}%` }} /></div>
                    {!voted && <button className="btn secondary" style={{ marginTop: 6, padding: '4px 10px', fontSize: 12 }} onClick={() => vote(openTopic, i)}>Vote</button>}
                  </div>
                ));
              })()}
            </div>
          ) : (
            <>
              <Thread posts={topicPosts} parentId="" topicId={openTopicId} currentUser={currentUser} onReply={setReplyTo} onReact={react} onDelete={deletePost} superAdmin={roleId === 'super_admin'} />
              <form onSubmit={submitReply} style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                {replyTo && <p className="muted" style={{ margin: '0 0 6px' }}>Replying to a post — <button type="button" onClick={() => setReplyTo('')} style={{ color: 'var(--blue)', background: 'none', padding: 0 }}>cancel</button></p>}
                <div className={`field${replyErr ? ' invalid' : ''}`}>
                  <label>Reply *</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}><RichTextEditor value={replyBody} onChange={(v) => { setReplyBody(v); if (replyErr) setReplyErr(''); }} placeholder="Write a reply…" minHeight={56} /></div>
                    <button type="submit" className="btn" style={{ alignSelf: 'flex-end' }}>Post</button>
                  </div>
                  {replyErr && <div className="field-error">{replyErr}</div>}
                </div>
              </form>
            </>
          )}

          {canModerate && (
            <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12, display: 'flex', gap: 8 }}>
              <button className="btn secondary" onClick={() => saveTopic({ ...openTopic, pinned: !openTopic.pinned })}>{openTopic.pinned ? 'Unpin' : 'Pin'} topic</button>
              <button className="btn secondary" onClick={() => saveTopic({ ...openTopic, status: openTopic.status === 'Open' ? 'Closed' : 'Open' })}>{openTopic.status === 'Open' ? 'Close' : 'Reopen'} topic</button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

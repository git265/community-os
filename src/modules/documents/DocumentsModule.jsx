import React, { useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import ServerTable from '../../components/ServerTable.jsx';
import Modal from '../../components/Modal.jsx';
import DynamicForm from '../../components/DynamicForm.jsx';
import FileUpload from '../../components/FileUpload.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { fileToBase64Url } from '../../lib/files/fileValidation.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { NONE, childrenOf, descendantIds, flatTree, pathOf, STARTER_FOLDERS } from '../../lib/docFolders.js';
import FilePreview from '../../components/FilePreview.jsx';
import Combobox from '../../components/Combobox.jsx';
import { DOC_GROUPS, DOC_VILLA_GROUP, docGroup } from '../../lib/docGroups.js';
import { getPrincipal } from '../../lib/security/principal.js';

async function download(row) {
  const f = await secureStorage.get(COLLECTIONS.FILES, row.fileId);
  if (!f) return;
  const a = document.createElement('a');
  a.href = f.dataUrl;
  a.download = row.fileName || 'document';
  a.click();
}

function UploadModal({ schema, onClose, folders = [], folderId = '' }) {
  const { save: saveDoc } = useCollection(COLLECTIONS.DOCUMENTS, 'Documents');
  const { save: saveFile } = useCollection(COLLECTIONS.FILES, 'Document files');
  const [picked, setPicked] = useState(null);
  const { records: properties } = useCollection(COLLECTIONS.PROPERTIES, 'Properties');
  const [form, setForm] = useState({ title: '', category: 'Association', version: 'v1.0', access: 'Everyone', unit: '', folderId: folderId && folderId !== NONE ? folderId : '' });
  const field = (k) => schema.fields.find((f) => f.key === k);
  const villaOptions = properties.map((p) => ({ value: p.unit, label: [p.unit, p.owner].filter(Boolean).join(' · ') }));
  const [errs, setErrs] = useState({});
  
  async function submit(e) {
    e.preventDefault();
    const er = {};
    if (!form.title.trim()) er.title = 'Document title is required';
    if (form.access === DOC_VILLA_GROUP && !form.unit) er.unit = 'Choose the villa this document belongs to';
    if (!picked) er.file = 'Choose a file — it must pass the upload checks';
    setErrs(er);
    if (Object.keys(er).length) return;
    const dataUrl = await fileToBase64Url(picked.file);
    const stored = await saveFile({ name: picked.file.name, mime: picked.file.type, size: picked.file.size, scanStatus: picked.validation.status, dataUrl });
    if (!stored) return;
    const doc = await saveDoc({
      ...form, fileId: stored.id, fileName: picked.file.name, fileSize: Math.ceil(picked.file.size / 1024), scanStatus: picked.validation.status === 'clean' ? 'Clean (server scan)' : 'Passed local checks',
    });
    if (doc) onClose();
  }

  return (
    <Modal title="Upload a document" subtitle="Add a file to the repository and choose who can see it. Files are checked for viruses and active content." onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className={`field${errs.title ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}><label>Document title *</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />{errs.title && <div className="field-error">{errs.title}</div>}</div>
        <div className="field"><label>Category</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{field('category').options.map((o) => <option key={o}>{o}</option>)}</select></div>
        <div className="field"><label>Folder</label><select aria-label="Folder" value={form.folderId} onChange={(e) => setForm({ ...form, folderId: e.target.value })}><option value="">Not in a folder</option>{flatTree(folders).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></div>
        <div className="field"><label>Version</label><input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} /></div>
        <div className="field"><label>Group *</label><select aria-label="Group" value={form.access} onChange={(e) => setForm({ ...form, access: e.target.value })}>{DOC_GROUPS.map((o) => <option key={o}>{o}</option>)}</select>
          <small className="muted">{form.access === DOC_VILLA_GROUP ? 'Only the owner / resident of the chosen villa (and document managers) can open it.' : form.access === 'Everyone' ? 'Every resident can open it.' : 'Only this group can open it.'}</small></div>
        <div className={`field${errs.unit ? ' invalid' : ''}`}><label>Villa / unit{form.access === DOC_VILLA_GROUP ? ' *' : ' (optional)'}</label>
          <Combobox value={form.unit} onChange={(v) => setForm({ ...form, unit: v })} options={villaOptions} allowCustom={false} placeholder="Search villa or owner…" invalid={!!errs.unit} />
          {errs.unit && <div className="field-error">{errs.unit}</div>}</div>
        <div className={`field${errs.file && !picked ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}>
          <label>File *</label>
          <FileUpload onAccepted={setPicked} onCleared={() => setPicked(null)} />
          {errs.file && !picked && <div className="field-error">{errs.file}</div>}
        </div>
        <div className="form-actions">
          <button type="submit" className="btn">Upload</button>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

const FILE_KIND = {
  pdf: { c: '#c7364a', bg: '#fee4e2', t: 'PDF' }, doc: { c: '#1d4ed8', bg: '#dbeafe', t: 'DOC' }, docx: { c: '#1d4ed8', bg: '#dbeafe', t: 'DOC' },
  xls: { c: '#15803d', bg: '#dcfce7', t: 'XLS' }, xlsx: { c: '#15803d', bg: '#dcfce7', t: 'XLS' }, csv: { c: '#15803d', bg: '#dcfce7', t: 'CSV' },
  ppt: { c: '#c2410c', bg: '#ffedd5', t: 'PPT' }, pptx: { c: '#c2410c', bg: '#ffedd5', t: 'PPT' }, txt: { c: '#475569', bg: '#f1f5f9', t: 'TXT' }, rtf: { c: '#475569', bg: '#f1f5f9', t: 'RTF' },
};
const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

export default function DocumentsModule() {
  const { roleId, schemaFor, roles = [] } = useApp();
  const { save, save: saveDoc } = useCollection(COLLECTIONS.DOCUMENTS, 'Documents');
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const { records: folders, save: saveFolder, remove: removeFolder } = useCollection(COLLECTIONS.DOC_FOLDERS, 'Document Folders');
  const { records: docs } = useCollection(COLLECTIONS.DOCUMENTS, 'Documents');
  const [folderId, setFolderId] = useState(''); // '' = all documents, NONE = not in a folder, else a folder id
  const [naming, setNaming] = useState(null); // { id?, parentId, name, accessRoles }
  const [folderErr, setFolderErr] = useState('');
  const schema = schemaFor(COLLECTIONS.DOCUMENTS);
  if (!schema) return null;
  const canUpload = canWriteCollection(COLLECTIONS.DOCUMENTS, getPrincipal());

  const countIn = (id) => { const ids = new Set(descendantIds(folders, id)); return docs.filter((d) => ids.has(d.folderId)).length; };
  const current = folders.find((f) => f.id === folderId);
  const crumbs = current ? pathOf(folders, current.id) : folderId === NONE ? ['Not in a folder'] : [];

  async function submitFolder(e) {
    e.preventDefault();
    const name = naming.name.trim();
    if (!name) { setFolderErr('Give the folder a name.'); return; }
    if (folders.some((f) => f.id !== naming.id && (f.parentId || '') === (naming.parentId || '') && f.name.toLowerCase() === name.toLowerCase())) { setFolderErr('A folder with this name already exists here.'); return; }
    const out = await saveFolder({ ...(naming.id ? folders.find((f) => f.id === naming.id) : {}), name, parentId: naming.parentId || '', accessRoles: naming.accessRoles || [] });
    if (out) { setNaming(null); setFolderErr(''); if (!naming.id) setFolderId(out.id); }
  }
  async function deleteFolder(f) {
    const subs = childrenOf(folders, f.id); const inside = docs.filter((d) => d.folderId === f.id);
    const msg = subs.length || inside.length ? `Delete the folder “${f.name}”? Its ${inside.length} document(s) and ${subs.length} sub-folder(s) move up to ${f.parentId ? 'the parent folder' : 'the top level'} — nothing is deleted.` : `Delete the empty folder “${f.name}”?`;
    if (!window.confirm(msg)) return;
    for (const sf of subs) await saveFolder({ ...sf, parentId: f.parentId || '' });
    for (const d of inside) await saveDoc({ ...d, folderId: f.parentId || '' });
    await removeFolder(f.id);
    setFolderId(f.parentId || '');
  }
  async function starter() { for (const n of STARTER_FOLDERS) await saveFolder({ name: n, parentId: '' }); }

  const TreeNode = ({ f, depth }) => (
    <>
      <button type="button" data-testid={`folder-${f.name}`} className={`chip-btn${folderId === f.id ? ' on' : ''}`} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', marginLeft: depth * 14, maxWidth: `calc(100% - ${depth * 14}px)`, textAlign: 'left' }} onClick={() => setFolderId(f.id)}>
        <span>{(f.accessRoles || []).length ? '🔒' : '📁'} {f.name}</span><small>{countIn(f.id)}</small>
      </button>
      {childrenOf(folders, f.id).map((c) => <TreeNode key={c.id} f={c} depth={depth + 1} />)}
    </>
  );

  const cardRender = (r) => {
    const ext = (r.fileName || '').split('.').pop().toLowerCase();
    const k = FILE_KIND[ext] || { c: '#64748b', bg: '#f1f5f9', t: ext ? ext.slice(0, 4).toUpperCase() : '📄' };
    const exp = r.expiry && new Date(r.expiry) < new Date();
    return (
      <div className="doc-card" data-testid="doc-card">
        <div className="doc-tile" style={{ background: k.bg, color: k.c }}>{k.t}</div>
        <div className="doc-body">
          <b className="doc-title">{r.title}</b>
          <div className="doc-meta"><span className="tag">{r.category}</span> <span className="muted">{r.version}</span>{r.access && r.access !== 'Everyone' && <span className="tag blue">🔒 {docGroup(r)}</span>}{r.unit && <span className="tag">{r.unit}</span>}{r.expiry && <span className={`tag ${exp ? 'red' : 'orange'}`}>{exp ? 'Expired' : 'Expires'} {r.expiry}</span>}</div>
          <small className="muted">{r.recordCreatedAt ? new Date(r.recordCreatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}{r.folderId ? ` · ${pathOf(folders, r.folderId).join(' / ')}` : ''}</small>
        </div>
        {r.fileId && <button type="button" className="btn secondary sm doc-open" aria-label={`Preview ${r.title}`} onClick={(e) => { e.stopPropagation(); setViewing({ fileId: r.fileId, name: r.fileName || r.title, mime: r.mime || '', size: (r.fileSize || 0) * 1024 }); }}>👁 View</button>}
      </div>
    );
  };

  const columns = [
    { key: 'title', label: 'Document' },
    { key: 'category', label: 'Category' },
    { key: 'folderId', label: 'Folder', sortable: false, render: (r) => (r.folderId ? pathOf(folders, r.folderId).join(' / ') || '—' : '—') },
    { key: 'version', label: 'Version' },
    { key: 'access', label: 'Group', render: (r) => docGroup(r) },
    { key: 'unit', label: 'Villa', render: (r) => r.unit || '—' },
    { key: 'recordCreatedAt', label: 'Uploaded', render: (r) => (r.recordCreatedAt ? new Date(r.recordCreatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—') },
    { key: 'expiry', label: 'Expiry', render: (r) => r.expiry || '—' },
    { key: 'fileName', label: 'File', sortable: false, render: (r) => (r.fileId ? <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); setViewing({ fileId: r.fileId, name: r.fileName || r.title, mime: r.mime || '', size: (r.fileSize || 0) * 1024 }); }}>👁 {r.fileName}</button> : '—') },
    { key: 'scanStatus', label: 'Scan', render: (r) => (r.scanStatus ? <span className="tag green">{r.scanStatus}</span> : '—') },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Document repository</h1>
          <p>Versioned, permissioned community documents. Uploads accept PDF, Word, Excel, PowerPoint, RTF and text files and are checked before they are stored.</p>
        </div>
        {canUpload && <button className="btn" onClick={() => setUploading(true)}>⬆ Upload</button>}
      </div>
      <div className="doc-layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 260px) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
        <div className="card doc-folders" data-testid="folder-tree">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button type="button" data-testid="folder-all" className={`chip-btn${folderId === '' ? ' on' : ''}`} style={{ display: 'flex', justifyContent: 'space-between' }} onClick={() => setFolderId('')}><span>🗂 All documents</span><small>{docs.length}</small></button>
            {childrenOf(folders).map((f) => <TreeNode key={f.id} f={f} depth={0} />)}
            <button type="button" data-testid="folder-none" className={`chip-btn${folderId === NONE ? ' on' : ''}`} style={{ display: 'flex', justifyContent: 'space-between' }} onClick={() => setFolderId(NONE)}><span>📄 Not in a folder</span><small>{docs.filter((d) => !d.folderId).length}</small></button>
          </div>
          {canUpload && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn secondary sm" data-testid="new-folder" onClick={() => { setFolderErr(''); setNaming({ parentId: current?.id || '', name: '', accessRoles: [] }); }}>+ {current ? 'Sub-folder' : 'Folder'}</button>
              {folders.length === 0 && <button type="button" className="btn secondary sm" onClick={starter}>Create starter folders</button>}
            </div>
          )}
        </div>
        <div>
          <div className="card" style={{ marginBottom: 10, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} data-testid="folder-crumbs">
            <b>🗂 <button type="button" className="link-btn" onClick={() => setFolderId('')}>All documents</button>{crumbs.map((c, i) => <span key={i}> › {c}</span>)}</b>
            {current && canUpload && <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button type="button" className="btn secondary sm" data-testid="rename-folder" onClick={() => { setFolderErr(''); setNaming({ id: current.id, parentId: current.parentId || '', name: current.name, accessRoles: current.accessRoles || [] }); }}>Rename / access</button>
              <button type="button" className="btn secondary sm" data-testid="delete-folder" onClick={() => deleteFolder(current)}>Delete folder</button>
            </span>}
          </div>
      <div className="card">
        <ServerTable
          collection={COLLECTIONS.DOCUMENTS}
          schema={schema}
          columns={columns}
          showId
          consumeNavSearch
          baseFilters={folderId ? { folderId } : undefined}
          baseSort={{ key: 'recordCreatedAt', dir: 'desc' }}
          filters={[{ key: 'category', label: 'All categories' }, ...(canUpload ? [{ key: 'access', label: 'All groups', options: DOC_GROUPS }] : [])]}
          dateFields={[{ key: 'recordCreatedAt', label: 'Uploaded' }, { key: 'expiry', label: 'Expiry' }]}
          onRowClick={setEditing}
          cardRender={cardRender}
          cardsAlways
        />
      </div>
        </div>
      </div>
      {viewing && <FilePreview meta={viewing} onClose={() => setViewing(null)} />}
      {uploading && <UploadModal schema={schema} folders={folders} folderId={folderId} onClose={() => setUploading(false)} />}
      {naming && (
        <Modal title={naming.id ? 'Rename folder' : naming.parentId ? `New sub-folder in ${pathOf(folders, naming.parentId).join(' / ')}` : 'New folder'} onClose={() => setNaming(null)}>
          <form onSubmit={submitFolder}>
            <div className={`field${folderErr ? ' invalid' : ''}`}><label>Folder name *</label><input autoFocus aria-label="Folder name" value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} />{folderErr && <div className="field-error">{folderErr}</div>}</div>
            <div className="field"><label>Who can open this folder</label>
              <div className="chip-row" data-testid="folder-roles">
                <label className={`chip-btn${(naming.accessRoles || []).length === 0 ? ' on' : ''}`}><input type="checkbox" style={{ display: 'none' }} checked={(naming.accessRoles || []).length === 0} onChange={() => setNaming({ ...naming, accessRoles: [] })} />Everyone who can open its documents</label>
                <label className={`chip-btn${(naming.accessRoles || []).includes('group:EC') ? ' on' : ''}`}><input type="checkbox" style={{ display: 'none' }} checked={(naming.accessRoles || []).includes('group:EC')} onChange={() => setNaming({ ...naming, accessRoles: toggleIn(naming.accessRoles || [], 'group:EC') })} />Executive Committee <small>· all EC roles</small></label>
                {roles.filter((r) => r.id !== 'super_admin').map((r) => <label key={r.id} className={`chip-btn${(naming.accessRoles || []).includes(r.id) ? ' on' : ''}`}><input type="checkbox" style={{ display: 'none' }} checked={(naming.accessRoles || []).includes(r.id)} onChange={() => setNaming({ ...naming, accessRoles: toggleIn(naming.accessRoles || [], r.id) })} />{r.name}</label>)}
              </div>
              <small className="muted">Choose roles to limit the folder (and every sub-folder and document in it) to them. A person also needs access to each document’s own group. Super Admin always sees everything.</small></div>
            <div className="form-actions"><button type="submit" className="btn">{naming.id ? 'Save' : 'Create folder'}</button><button type="button" className="btn secondary" onClick={() => setNaming(null)}>Cancel</button></div>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal title={editing.title || 'Document'} subtitle="Document details, version and access." onClose={() => setEditing(null)}>
          {canUpload && <div className="field" style={{ marginBottom: 10 }}><label>Folder</label><select aria-label="Move to folder" data-testid="move-folder" value={editing.folderId || ''} onChange={async (e) => { const d = await saveDoc({ ...editing, folderId: e.target.value }); if (d) setEditing(d); }}><option value="">Not in a folder</option>{flatTree(folders).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></div>}
          {editing.fileId && <p><button className="btn secondary" onClick={() => setViewing({ fileId: editing.fileId, name: editing.fileName || editing.title, mime: editing.mime || '', size: (editing.fileSize || 0) * 1024 })}>👁 Preview {editing.fileName}</button></p>}
          <DynamicForm schema={schema} roleId={roleId} record={editing} onSave={async (d) => { const s = await save(d); if (s) setEditing(null); }} onCancel={() => setEditing(null)} />
        </Modal>
      )}
    </div>
  );
}

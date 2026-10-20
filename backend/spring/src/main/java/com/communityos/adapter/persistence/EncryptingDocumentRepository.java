package com.communityos.adapter.persistence;

import com.communityos.crypto.FieldCrypto;
import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.domain.ScopeNode;
import com.communityos.port.DocumentRepository;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * Wraps the real repository: protected personal fields (see {@link FieldCrypto}) are encrypted on the way in and opened on the way out, for every adapter
 * alike. The audit trail is stored as it is (it never holds a secret: AuditTrail hides them). Nothing else in the code base knows encryption exists.
 */
public class EncryptingDocumentRepository implements DocumentRepository {
    private final DocumentRepository in;
    private final FieldCrypto crypto;

    public EncryptingDocumentRepository(DocumentRepository in, FieldCrypto crypto) { this.in = in; this.crypto = crypto; }

    private JsonNode seal(String c, JsonNode d) { return AuditTrail.COLLECTION.equals(c) ? d : crypto.encryptRecord(d); }
    private JsonNode open(JsonNode d) { return d == null ? null : crypto.decryptRecord(d); }
    private List<JsonNode> open(List<JsonNode> l) { return l.stream().map(this::open).toList(); }
    private PageResult open(PageResult p) { return new PageResult(open(p.rows()), p.total(), p.page(), p.pageSize(), p.pages(), p.approx()); }

    @Override public List<JsonNode> list(String t, String c) { return open(in.list(t, c)); }
    @Override public Optional<JsonNode> get(String t, String c, String id) { return in.get(t, c, id).map(this::open); }
    @Override public JsonNode upsert(String t, String c, String id, JsonNode d) { return open(in.upsert(t, c, id, seal(c, d))); }
    @Override public List<JsonNode> upsertAll(String t, String c, List<JsonNode> d) { return open(in.upsertAll(t, c, d.stream().map(x -> seal(c, x)).toList())); }
    @Override public boolean delete(String t, String c, String id) { return in.delete(t, c, id); }
    @Override public void replaceAll(String t, String c, List<JsonNode> d) { in.replaceAll(t, c, d.stream().map(x -> seal(c, x)).toList()); }
    @Override public PageResult query(String t, String c, QuerySpec s) { return open(in.query(t, c, s)); }
    @Override public PageResult queryScoped(String t, String c, QuerySpec s, ScopeNode scope) { return open(in.queryScoped(t, c, s, scope)); }
    @Override public List<JsonNode> listScoped(String t, String c, ScopeNode scope) { return open(in.listScoped(t, c, scope)); }
    @Override public Optional<JsonNode> getScoped(String t, String c, String id, ScopeNode scope) { return in.getScoped(t, c, id, scope).map(this::open); }
    @Override public void lock(String t, String c, Collection<String> ids) { in.lock(t, c, ids); }
    @Override public long nextShortNumber(String t, String c, long base) { return in.nextShortNumber(t, c, base); }
    @Override public long nextAuditNumber() { return in.nextAuditNumber(); }
    @Override public boolean supportsScope(String c) { return in.supportsScope(c); }
    @Override public List<String> tenants() { return in.tenants(); }
    @Override public void deleteTenant(String t) { in.deleteTenant(t); }
    @Override public String ping() { return in.ping(); }
}

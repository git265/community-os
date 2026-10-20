package com.communityos.crypto;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.adapter.persistence.EncryptingDocumentRepository;
import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Js;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The Java field encryption opens what the Node reference wrote (and the other way round: see docs/BACKEND.md), and hides secrets in the audit trail the same way. */
class FieldCryptoTest {
    final ObjectMapper json = new ObjectMapper();

    JsonNode gold() throws Exception {
        try (InputStream in = FieldCryptoTest.class.getResourceAsStream("/fieldcrypto/golden.json")) {
            if (in == null) throw new IllegalStateException("fieldcrypto/golden.json is missing: run `npm run gen:fieldcrypto` in backend/contract-server");
            return json.readTree(in);
        }
    }
    static String canon(JsonNode n) { return Js.stringify(n); }
    /** every encrypted value as the word ENC, so two ciphertexts of the same record (random IV) can be compared by where they are */
    static String shape(JsonNode n) { return canon(n).replaceAll("\"enc:v1:[^\"]*\"", "\"ENC\""); }

    @Test void javaOpensWhatNodeEncryptedWithTheCurrentAndWithARotatedKey() throws Exception {
        JsonNode g = gold();
        FieldCrypto k1 = new FieldCrypto(json, g.get("key1").asText(), null, g.get("fields").asText());
        FieldCrypto k2 = new FieldCrypto(json, g.get("key2").asText(), g.get("key1").asText(), g.get("fields").asText());
        for (int i = 0; i < g.get("plain").size(); i++) {
            assertEquals(canon(g.get("plain").get(i)), canon(k1.decryptRecord(g.get("encryptedWithKey1").get(i))), "record " + i + " with key 1");
            assertEquals(canon(g.get("plain").get(i)), canon(k2.decryptRecord(g.get("encryptedWithKey2").get(i))), "record " + i + " with key 2");
            assertEquals(canon(g.get("plain").get(i)), canon(k2.decryptRecord(g.get("encryptedWithKey1").get(i))), "old key still reads old data, record " + i);
        }
        assertThrows(IllegalStateException.class, () -> k1.decryptRecord(g.get("encryptedWithKey2").get(0)), "no key for it");
    }

    @Test void javaProtectsTheSameFieldsNodeDoes() throws Exception {
        JsonNode g = gold();
        FieldCrypto k1 = new FieldCrypto(json, g.get("key1").asText(), null, g.get("fields").asText());
        for (int i = 0; i < g.get("plain").size(); i++) {
            JsonNode mine = k1.encryptRecord(g.get("plain").get(i));
            assertEquals(shape(g.get("encryptedWithKey1").get(i)), shape(mine), "record " + i);
            assertEquals(canon(g.get("plain").get(i)), canon(k1.decryptRecord(mine)));
        }
        String all = canon(k1.encryptRecord(g.get("plain").get(0)));
        assertFalse(all.contains("ABCDE1234F"));
        assertTrue(all.contains("\"name\":\"Asha\""));
    }

    @Test void aTamperedValueIsRefusedAndNoKeyMeansNoEncryption() throws Exception {
        JsonNode g = gold();
        FieldCrypto k1 = new FieldCrypto(json, g.get("key1").asText(), null, "taxId");
        JsonNode e = k1.encryptRecord(json.readTree("{\"taxId\":\"ABCDE1234F\"}"));
        String s = e.get("taxId").asText();
        com.fasterxml.jackson.databind.node.ObjectNode bad = json.createObjectNode();
        bad.put("taxId", s.substring(0, s.length() - 4) + (s.endsWith("AAAA") ? "BBBB" : "AAAA"));
        assertThrows(IllegalStateException.class, () -> k1.decryptRecord(bad));
        FieldCrypto off = FieldCrypto.off(json);
        assertFalse(off.enabled());
        assertEquals("{\"taxId\":\"x\"}", canon(off.encryptRecord(json.readTree("{\"taxId\":\"x\"}"))));
        assertThrows(IllegalStateException.class, () -> new FieldCrypto(json, "abcd", null, null), "a short key is refused");
    }

    @Test void theRepositoryStoresCiphertextAndHandsBackPlainText() throws Exception {
        JsonNode g = gold();
        FieldCrypto k1 = new FieldCrypto(json, g.get("key1").asText(), null, "taxId");
        InMemoryDocumentRepository raw = new InMemoryDocumentRepository();
        DocumentRepository repo = new EncryptingDocumentRepository(raw, k1);
        JsonNode back = repo.upsert("t", "properties", "p1", json.readTree("{\"id\":\"p1\",\"taxId\":\"ABCDE1234F\",\"unit\":\"V-1\"}"));
        assertEquals("ABCDE1234F", back.get("taxId").asText());
        assertTrue(raw.get("t", "properties", "p1").orElseThrow().get("taxId").asText().startsWith("enc:v1:"), "what is stored");
        assertEquals("ABCDE1234F", repo.get("t", "properties", "p1").orElseThrow().get("taxId").asText());
        assertEquals("ABCDE1234F", repo.list("t", "properties").get(0).get("taxId").asText());
        repo.upsert("t", "properties", "p1", json.readTree("{\"id\":\"p1\",\"unit\":\"V-2\"}"));   // an update that leaves the field out keeps it (and its protection)
        assertEquals("ABCDE1234F", repo.get("t", "properties", "p1").orElseThrow().get("taxId").asText());
        assertEquals("V-2", repo.get("t", "properties", "p1").orElseThrow().get("unit").asText());
        raw.upsert("t", "properties", "old", json.readTree("{\"id\":\"old\",\"taxId\":\"written-before-the-key\"}"));
        assertEquals("written-before-the-key", repo.get("t", "properties", "old").orElseThrow().get("taxId").asText(), "plain values from before the key still read");
        repo.upsert("t", "audit", "a1", json.readTree("{\"id\":\"a1\",\"taxId\":\"kept as is\"}"));
        assertEquals("kept as is", raw.get("t", "audit", "a1").orElseThrow().get("taxId").asText(), "the audit trail is not encrypted");
    }

    @Test void secretsAreHiddenInTheAuditChangesLikeInNode() throws Exception {
        JsonNode g = gold();
        Set<String> extra = Set.of(g.get("extra").get(0).asText());
        assertEquals(canon(g.get("redacted")), canon(AuditTrail.redactChanges(g.get("changes"), extra)));
    }
}

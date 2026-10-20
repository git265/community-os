package com.communityos.platform;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.port.DocumentRepository;
import com.communityos.service.Tx;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

/** The cases of contract-server/test/platform.test.mjs, without HTTP. */
class PlatformServiceTest {
    final ObjectMapper json = new ObjectMapper();
    final DocumentRepository repo = new InMemoryDocumentRepository();
    final Clock clock = Clock.fixed(Instant.parse("2026-10-20T09:00:00Z"), ZoneOffset.UTC);
    final PlatformService p = new PlatformService(repo, new AuditTrail(repo, json, clock), json, clock, Tx.none(), "platform-key-for-tests-0123");
    JsonNode j(String s) throws Exception { return json.readTree(s); }

    @Test
    void withoutTheKeyNothingHappens() {
        assertEquals(401, assertThrows(PlatformService.Refused.class, () -> p.check("nope")).status);
        assertEquals(403, assertThrows(PlatformService.Refused.class, () -> new PlatformService(repo, null, json, clock, Tx.none(), "").check("x")).status);
        p.check("platform-key-for-tests-0123");
    }

    @Test
    void aNewCommunityGetsItsDefaultsAndAFirstSuperAdmin() throws Exception {
        PlatformService.Refused bad = assertThrows(PlatformService.Refused.class, () -> p.create(j("{\"name\":\"Palm\",\"slug\":\"admin\",\"adminName\":\"R\",\"adminEmail\":\"r@x\",\"adminPhone\":\"98450\"}")));
        assertEquals(400, bad.status);
        assertEquals("That address is reserved", bad.errors.get("slug"));
        assertTrue(bad.errors.containsKey("adminEmail") && bad.errors.get("adminPhone").contains("country code"));
        JsonNode out = p.create(j("{\"name\":\"Palm \\\"Meadows\\\"\",\"slug\":\"palm-meadows\",\"adminName\":\"Ravi\",\"adminEmail\":\"Ravi@Palm.in\",\"adminPhone\":\"+91 90080 12345\"}"));
        assertEquals("palm-meadows", out.get("community").get("slug").asText());
        JsonNode admin = repo.list("palm-meadows", "users").get(0);
        assertEquals("super_admin", admin.get("roleId").asText());
        assertEquals("+919008012345", admin.get("phone").asText());
        assertEquals("ravi@palm.in", admin.get("email").asText());
        assertEquals("2026-10-20T09:00:00.000Z", admin.get("recordCreatedAt").asText());
        assertTrue(repo.list("palm-meadows", "roles").size() >= 10);
        assertFalse(repo.list("palm-meadows", "taskTypes").isEmpty());
        assertEquals("Palm \"Meadows\"", repo.list("palm-meadows", "communityConfig").get(0).get("legalName").asText());
        assertEquals(1, p.list().get(0).get("people").asInt());
        assertEquals("That web address is already taken", assertThrows(PlatformService.Refused.class,
                () -> p.create(j("{\"name\":\"Again\",\"slug\":\"palm-meadows\",\"adminName\":\"R\",\"adminEmail\":\"r@x.in\",\"adminPhone\":\"+91 90080 12345\"}"))).errors.get("slug"));
        assertEquals("Communities", repo.list("palm-meadows", "audit").get(0).get("what").asText());
    }

    @Test
    void aCommunityCanBeSuspendedAndReactivated() throws Exception {
        p.create(j("{\"name\":\"Palm\",\"slug\":\"palm-x\",\"adminName\":\"R\",\"adminEmail\":\"r@x.in\",\"adminPhone\":\"+91 90080 12345\"}"));
        assertEquals("Suspended", p.setStatus("palm-x", "Suspended").get("status").asText());
        assertEquals("Active", p.setStatus("palm-x", "Active").get("status").asText());
        assertEquals(400, assertThrows(PlatformService.Refused.class, () -> p.setStatus("palm-x", "Gone")).status);
        assertEquals(404, assertThrows(PlatformService.Refused.class, () -> p.setStatus("nope-x", "Active")).status);
    }
}

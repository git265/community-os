package com.communityos;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

/** Runs the whole HTTP contract (docs/BACKEND.md) against the in-memory adapter: no database needed. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("memory")
class ApiContractTest {
    @Autowired MockMvc mvc;

    private static final String T = "X-Community-Id";

    @Test
    void healthIsOpenAndNamesTheProviders() throws Exception {
        mvc.perform(get("/api/health")).andExpect(status().isOk())
           .andExpect(jsonPath("$.status").value("UP")).andExpect(jsonPath("$.providers.files").value("local-disk"));
    }

    @Test
    void putMergesAndListsAndQueries() throws Exception {
        mvc.perform(put("/api/memos/d1").header(T, "t-one").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"d1\",\"status\":\"Open\",\"amount\":50}")).andExpect(status().isOk());
        mvc.perform(put("/api/memos/d1").header(T, "t-one").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"d1\",\"status\":\"Paid\"}")).andExpect(status().isOk())
           .andExpect(jsonPath("$.amount").value(50)).andExpect(jsonPath("$.status").value("Paid"));
        mvc.perform(post("/api/memos/bulk").header(T, "t-one").contentType(MediaType.APPLICATION_JSON).content("[{\"id\":\"d2\",\"amount\":9},{\"id\":\"d3\",\"amount\":100}]")).andExpect(status().isOk());
        mvc.perform(get("/api/memos/query").header(T, "t-one").param("sort", "amount:desc").param("pageSize", "2"))
           .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(3)).andExpect(jsonPath("$.rows[0].id").value("d3")).andExpect(jsonPath("$.pages").value(2));
    }

    @Test
    void communitiesAreIsolatedAndInputIsChecked() throws Exception {
        mvc.perform(put("/api/notes/n1").header(T, "t-a").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"n1\"}")).andExpect(status().isOk());
        mvc.perform(get("/api/notes").header(T, "t-b")).andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(get("/api/notes")).andExpect(status().isBadRequest());
        mvc.perform(put("/api/notes/n2").header(T, "t-a").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"other\"}")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/notes/query").header(T, "t-a").param("sort", "id'; drop table documents;--:asc")).andExpect(status().isOk()); // in memory: harmless; SQL adapter validates the name
        mvc.perform(get("/api/notes/missing").header(T, "t-a")).andExpect(status().isNotFound());
        mvc.perform(delete("/api/notes/n1").header(T, "t-a")).andExpect(status().isNoContent());
    }

    @Test
    void idsMayHaveSpacesAndSymbolsButNeverASlash() throws Exception {
        // the app writes ids such as "pulse-Handyman · Security"; the server must accept them (found by the UI regression)
        mvc.perform(put("/api/gatePulse/{id}", "pulse-Handyman · Security").header(T, "t-a").contentType(MediaType.APPLICATION_JSON)
            .content("{\"id\":\"pulse-Handyman · Security\"}")).andExpect(status().isOk());
        mvc.perform(get("/api/gatePulse/{id}", "pulse-Handyman · Security").header(T, "t-a")).andExpect(status().isOk());
        mvc.perform(put("/api/gatePulse/{id}", "a%2Fb").header(T, "t-a").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"a/b\"}")).andExpect(status().is4xxClientError());
    }

    @Test
    void fileBytesRoundTrip() throws Exception {
        mvc.perform(put("/api/files/f1").header(T, "t-a").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"f1\",\"name\":\"a.png\",\"size\":3}")).andExpect(status().isOk());   // the record that says the file exists
        mvc.perform(put("/api/files/f1/content").header(T, "t-a").contentType("image/png").content(new byte[] {1, 2, 3})).andExpect(status().isNoContent());
        mvc.perform(get("/api/files/f1/content").header(T, "t-a")).andExpect(status().isOk());
        mvc.perform(delete("/api/files/f1/content").header(T, "t-a")).andExpect(status().isNoContent());
        mvc.perform(get("/api/files/f1/content").header(T, "t-a")).andExpect(status().isNotFound());
    }

    @Test
    void everyWriteIsStampedAndAudited() throws Exception {
        mvc.perform(put("/api/memos/m1").header(T, "t-s").contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"m1\",\"title\":\"x\"}")).andExpect(status().isOk())
           .andExpect(jsonPath("$.recVersion").value(1)).andExpect(jsonPath("$.shortId").exists());
        mvc.perform(get("/api/audit").header(T, "t-s")).andExpect(status().isOk()).andExpect(jsonPath("$[0].action").value("Create"));
        mvc.perform(delete("/api/audit/x").header(T, "t-s")).andExpect(status().isForbidden());   // the audit trail is written by the server only
    }

    @Test
    void aPaymentIsPricedByTheServerAskedTwiceIsOneOrderAndSettlesBillAndLedger() throws Exception {
        mvc.perform(put("/api/dues/d1").header(T, "t-pay").contentType(MediaType.APPLICATION_JSON)
                .content("{\"id\":\"d1\",\"unit\":\"A-101\",\"amount\":120.5,\"status\":\"Unpaid\",\"category\":\"Maintenance\"}")).andExpect(status().isOk());
        String body = "{\"purpose\":\"due\",\"refs\":[\"d1\"],\"amount\":1}";   // the amount sent by the browser is ignored
        String a = mvc.perform(post("/api/payments/orders").header(T, "t-pay").contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isOk())
                .andExpect(jsonPath("$.amount").value(120.5)).andReturn().getResponse().getContentAsString();
        String b = mvc.perform(post("/api/payments/orders").header(T, "t-pay").contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        org.junit.jupiter.api.Assertions.assertEquals(a, b);
        String id = com.jayway.jsonpath.JsonPath.read(a, "$.orderId");
        mvc.perform(post("/api/payments/simulate/{id}", id).header(T, "t-pay").contentType(MediaType.APPLICATION_JSON).content("{\"outcome\":\"success\",\"method\":\"UPI\"}"))
           .andExpect(status().isOk()).andExpect(jsonPath("$.delivered").value(true));
        mvc.perform(get("/api/payments/orders/{id}", id).header(T, "t-pay")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("Paid"));
        mvc.perform(get("/api/dues/d1").header(T, "t-pay")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("Paid")).andExpect(jsonPath("$.paymentMode").value("UPI"));
        mvc.perform(get("/api/ledger").header(T, "t-pay")).andExpect(status().isOk()).andExpect(jsonPath("$[0].sourceId").value("due:d1"));
    }

    @Test
    void aForgedWebhookIsRefused() throws Exception {
        mvc.perform(post("/api/payments/webhook/simulated").contentType(MediaType.APPLICATION_JSON).header("X-Signature", "00")
                .content("{\"id\":\"EVT-1\",\"type\":\"payment.captured\",\"orderId\":\"ORD_X\",\"amount\":1}")).andExpect(status().isUnauthorized());
    }

    @Test
    void anIdempotencyKeyReplaysTheStoredAnswerAndRefusesADifferentRequest() throws Exception {
        String key = "key-abcdef12";
        mvc.perform(put("/api/memos/k1").header(T, "t-idem").header("Idempotency-Key", key).contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"k1\",\"title\":\"a\"}"))
           .andExpect(status().isOk()).andExpect(jsonPath("$.recVersion").value(1));
        mvc.perform(put("/api/memos/k1").header(T, "t-idem").header("Idempotency-Key", key).contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"k1\",\"title\":\"a\"}"))
           .andExpect(status().isOk()).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.header().string("Idempotent-Replay", "true")).andExpect(jsonPath("$.recVersion").value(1));
        mvc.perform(put("/api/memos/k1").header(T, "t-idem").header("Idempotency-Key", key).contentType(MediaType.APPLICATION_JSON).content("{\"id\":\"k1\",\"title\":\"b\"}"))
           .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("idempotency-mismatch"));
    }
}

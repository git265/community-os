package com.communityos.api.shared.web;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

/** The body limit by path, and which request ids are taken from the caller. */
class RequestGuardTest {
    @Test void limits() {
        assertEquals(256 * 1024, RequestGuardFilter.limitFor("POST", "/api/v1/webhooks/razorpay"));
        assertEquals(26 * RequestGuardFilter.MB, RequestGuardFilter.limitFor("POST", "/api/v1/files"));
        assertEquals(2 * RequestGuardFilter.MB, RequestGuardFilter.limitFor("POST", "/api/v1/files/1/attach"), "only the upload itself is large");
        assertEquals(13 * RequestGuardFilter.MB, RequestGuardFilter.limitFor("PUT", "/api/v1/assets/site-plans/1"));
        assertEquals(2 * RequestGuardFilter.MB, RequestGuardFilter.limitFor("POST", "/api/v1/dues"));
    }
    @Test void requestIds() {
        assertTrue(RequestGuardFilter.GOOD_ID.matcher("7d4f0a3e-5c1b-4d7e-9f00-123456789abc").matches());
        assertFalse(RequestGuardFilter.GOOD_ID.matcher("abc").matches(), "too short");
        assertFalse(RequestGuardFilter.GOOD_ID.matcher("x\r\nSet-Cookie: a=b").matches(), "no header injection into the log or the response");
    }
}

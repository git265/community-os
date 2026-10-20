package com.communityos.amenities;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.security.Js;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.ZoneId;
import org.junit.jupiter.api.Test;

/** The JavaScript habits the amenity maths depends on, written down so a change cannot quietly drop one. */
class AmenityEngineTest {
    static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    private static void same(double expected, double actual) { assertTrue(expected == actual, expected + " expected but was " + actual); }

    @Test
    void rupeesAreGroupedInLakhsAndCroresAndShowTwoDecimalsOnlyWhenNeeded() {
        assertEquals("₹1,500", AmenityEngine.inr(1500));
        assertEquals("₹12,34,567.50", AmenityEngine.inr(1234567.5));
        assertEquals("₹999.99", AmenityEngine.inr(999.99));
        assertEquals("₹0", AmenityEngine.inr(0));
        assertEquals("₹-250.50", AmenityEngine.inr(-250.5));
        assertEquals("₹1,00,00,000", AmenityEngine.inr(10000000));
    }

    @Test
    void roundingGoesHalfUpAndNumbersPrintTheJavaScriptWay() {
        same(1.01, AmenityEngine.round2(1.005 + 1e-9));
        same(2.5, AmenityEngine.round2(2.5));
        same(0.0, AmenityEngine.round2(Double.NaN));
        assertEquals("1000", Js.numberToString(1000.0));
        assertEquals("0.1", Js.numberToString(0.1));
        assertEquals("1.5e-7", Js.numberToString(1.5e-7));
        assertEquals("1e+21", Js.numberToString(1e21));
        assertEquals("123456789012345680000", Js.numberToString(123456789012345680000.0));
        assertEquals("-1234567.5", Js.numberToString(-1234567.5));
    }

    @Test
    void aBookingTimeIsLocalAndAnUnreadableDateIsNeverEarlierThanNow() {
        // 10:00 in India is 04:30 UTC
        assertEquals(java.time.Instant.parse("2026-10-20T04:30:00Z").toEpochMilli(), (long) AmenityEngine.parseLocal("2026-10-20T10:00:00", IST));
        assertTrue(Double.isNaN(AmenityEngine.parseLocal("tomorrowT10:00:00", IST)));
        assertTrue(Double.isNaN(AmenityEngine.parseLocal("2026-13-01T10:00:00", IST)));
        // like JavaScript, 30 February rolls over to 2 March and 24:00 is the next midnight
        same(AmenityEngine.parseLocal("2026-03-02T09:00:00", IST), AmenityEngine.parseLocal("2026-02-30T09:00:00", IST));
        same(AmenityEngine.parseLocal("2026-10-21T00:00:00", IST), AmenityEngine.parseLocal("2026-10-20T24:00:00", IST));
    }

    @Test
    void addOnItemsKeepTheJavaScriptOrderOfKeys() throws Exception {
        var picks = new ObjectMapper().readTree("{\"b\":1,\"2\":2,\"a\":3,\"1\":4}");
        StringBuilder order = new StringBuilder();
        Js.entries(picks).forEach(e -> order.append(e.getKey()));
        assertEquals("12ba", order.toString());   // whole-number keys first, ascending, then the rest as written
    }
}

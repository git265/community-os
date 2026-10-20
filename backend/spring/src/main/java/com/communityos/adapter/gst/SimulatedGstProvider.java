package com.communityos.adapter.gst;

import com.communityos.port.GstProvider;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Demo GST source with the same answers shape as the UI's built-in simulator. To go live, implement GstProvider against
 * your GST Suvidha Provider (GSP): lookupGstin -> taxpayer search API, lookupInvoice -> GSTR-2B/2A invoice match. Needs a
 * GSP account and the society's taxpayer authorisation. See docs/GST_API.md and docs/INTEGRATIONS.md.
 */
public class SimulatedGstProvider implements GstProvider {
    @Override public String id() { return "simulated"; }

    @Override public Map<String, Object> health() { return Map.of("ok", true, "provider", "Simulated GST service", "detail", "Demo answers only"); }

    @Override public Map<String, Object> lookupGstin(String gstin) {
        boolean valid = gstin != null && gstin.matches("^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("valid", valid);
        m.put("legalName", valid ? "(demo) name not looked up" : "");
        m.put("status", valid ? "Active" : "Not found");
        return m;
    }

    /** Same demo rule as the UI simulator: an invoice number ending in 0 or X was "not filed by the vendor". */
    @Override public Map<String, Object> lookupInvoice(Map<String, Object> body) {
        String no = String.valueOf(body.getOrDefault("invoiceNo", "")).trim();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("found", !no.isEmpty() && !no.matches(".*[0xX]$"));
        return m;
    }
}

package com.communityos.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import com.communityos.port.GstProvider;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** The three calls src/lib/finance/gstGateway.js makes in "Live" mode (docs/GST_API.md). */
@Tag(name = "GST")
@RestController
public class GstController {
    private final GstProvider gst;

    public GstController(GstProvider gst) { this.gst = gst; }

    @Operation(summary = "GST provider status", description = "")
    @GetMapping("/api/gst/health")
    public Map<String, Object> health() { return gst.health(); }

    @Operation(summary = "Look up a GSTIN", description = "")
    @GetMapping("/api/gst/gstin/{gstin}")
    public Map<String, Object> gstin(@PathVariable String gstin) { return gst.lookupGstin(gstin.toUpperCase()); }

    @Operation(summary = "Look up inward invoices", description = "")
    @PostMapping("/api/gst/inward/lookup")
    public Map<String, Object> inward(@RequestBody Map<String, Object> body) { return gst.lookupInvoice(body); }
}

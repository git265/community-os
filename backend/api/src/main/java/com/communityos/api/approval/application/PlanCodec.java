package com.communityos.api.approval.application;

import com.communityos.api.approval.domain.Plan;
import com.fasterxml.jackson.databind.ObjectMapper;

/** A plan as the JSON text stored on its record (and back). */
public final class PlanCodec {
    private final ObjectMapper json;
    public PlanCodec(ObjectMapper json) { this.json = json; }
    public String write(Plan p) { try { return p == null ? null : json.writeValueAsString(p); } catch (Exception e) { throw new IllegalStateException(e); } }
    public Plan read(String s) {
        if (s == null || s.isBlank()) return null;
        try { return json.readValue(s, Plan.class); }
        catch (Exception e) { throw new IllegalStateException("The stored approval plan cannot be read: " + e.getMessage(), e); }   // never drop decisions silently
    }
}

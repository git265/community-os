package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One write to judge. `old` is the stored record (null on create), `next` the incoming one (the stored record again on delete); `op` is
 * "create", "update" or "delete". `ctx` carries the community's approval settings and the clock.
 */
public record WriteCall(String collection, Principal p, Schema schema, JsonNode old, JsonNode next, String op, RuleContext ctx) {
    public boolean isDelete() { return "delete".equals(op); }
}

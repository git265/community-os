package com.communityos.api.shared.web;

import jakarta.servlet.http.HttpServletRequest;

/** The client's address and agent. Behind the load balancer, server.forward-headers-strategy=framework makes getRemoteAddr() the real client. */
public final class Clients {
    private Clients() {}
    public static String ip(HttpServletRequest r) { String a = r.getRemoteAddr(); return a == null || a.isBlank() ? "0.0.0.0" : a; }
    public static String agent(HttpServletRequest r) { String a = r.getHeader("User-Agent"); return a == null ? "" : a.substring(0, Math.min(300, a.length())); }
}

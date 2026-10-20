package com.communityos.people;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/** communityUrl(slug) of src/lib/community.js: the address of a community, by sub-domain (lapaloma.example.in) or path (host/c/lapaloma). */
public final class CommunityUrls {
    public static final String PLATFORM = "platform";
    private static final Pattern IP = Pattern.compile("^\\d{1,3}(?:\\.\\d{1,3}){3}$");

    /** @param publicUrl the address the app is served at (window.location of the browser; PUBLIC_APP_URL on a server) */
    public static String of(String publicUrl, String slug, String defaultCommunity) {
        URI u;
        try { u = URI.create(publicUrl.trim()); } catch (RuntimeException e) { u = URI.create("http://localhost:5173"); }
        String protocol = (u.getScheme() == null ? "http" : u.getScheme().toLowerCase(Locale.ROOT)) + ":";
        String hostname = u.getHost() == null ? "localhost" : u.getHost().toLowerCase(Locale.ROOT);
        int p = u.getPort();
        String port = p < 0 || (p == 80 && protocol.equals("http:")) || (p == 443 && protocol.equals("https:")) ? "" : String.valueOf(p);
        String host = hostname + (port.isEmpty() ? "" : ":" + port);
        if (usesSubdomains(hostname)) {
            String[] l = hostname.split("\\.", -1);
            l[0] = slug;
            return protocol + "//" + String.join(".", l) + (port.isEmpty() ? "" : ":" + port) + "/";
        }
        String base = protocol + "//" + host;
        if (PLATFORM.equals(slug)) return base + "/platform";
        if (slug.equals(defaultCommunity)) return base + "/";        // the path of a server-side address is always "/"
        return base + "/c/" + encodeURIComponent(slug);
    }

    static boolean usesSubdomains(String h) {
        if (IP.matcher(h).find() || h.equals("localhost") || !h.contains(".")) return false;
        return h.split("\\.", -1).length >= 3 || h.endsWith(".localhost");
    }

    /** JavaScript's encodeURIComponent. */
    public static String encodeURIComponent(String s) {
        StringBuilder b = new StringBuilder();
        for (byte x : s.getBytes(StandardCharsets.UTF_8)) {
            int c = x & 0xff;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || "-_.!~*'()".indexOf(c) >= 0) b.append((char) c);
            else b.append('%').append(String.format("%02X", c));
        }
        return b.toString();
    }

    private CommunityUrls() {}
}

package com.communityos.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Uploaded bytes are checked on the server (checkFileBytes / fileResponseHeaders in backend/contract-server/guards.mjs): the type must be on the
 * allow-list of src/lib/files/fileValidation.js (copied into rulebook/constants.json by `npm run gen:rulebook`), the first bytes must match it,
 * and the size must be within the limit. On the way out only allow-listed types are named; anything else is a download.
 */
public final class FileBytes {
    private FileBytes() {}

    public record Check(String type, String error) {}
    public record Served(String type, String disposition) {}
    private record Kind(List<String> mimes, List<int[]> magic) {}

    private static final List<Kind> KINDS = new ArrayList<>();
    private static long maxBytes = 10L * 1024 * 1024;
    static {
        try (InputStream in = FileBytes.class.getResourceAsStream("/rulebook/constants.json")) {
            JsonNode c = new ObjectMapper().readTree(in);
            maxBytes = c.path("maxBytes").asLong(maxBytes);
            for (JsonNode t : c.path("allowedTypes")) {
                List<String> mimes = new ArrayList<>(); t.path("mime").forEach((m) -> mimes.add(m.asText()));
                List<int[]> magic = null;
                if (t.path("magic").isArray()) { magic = new ArrayList<>(); for (JsonNode sig : t.path("magic")) { int[] s = new int[sig.size()]; for (int i = 0; i < s.length; i++) s[i] = sig.get(i).asInt(); magic.add(s); } }
                KINDS.add(new Kind(mimes, magic));
            }
        } catch (Exception e) { throw new IllegalStateException("rulebook/constants.json is missing or unreadable: run `npm run gen:rulebook`", e); }
    }

    private static String typeOf(String mime) { return mime == null ? "" : mime.split(";")[0].trim().toLowerCase(); }
    private static Kind kindOf(String type) { for (Kind k : KINDS) if (k.mimes().contains(type)) return k; return null; }

    public static Check check(byte[] bytes, String mime) {
        String type = typeOf(mime);
        if (bytes == null || bytes.length == 0) return new Check(null, "The file is empty.");
        if (bytes.length > maxBytes) return new Check(null, "The file is larger than " + Math.round(maxBytes / 1048576.0) + " MB.");
        Kind k = kindOf(type);
        if (k == null) return new Check(null, "Files of type \"" + (type.isEmpty() ? "unknown" : type) + "\" are not allowed.");
        if (k.magic() != null) {
            boolean ok = false;
            for (int[] sig : k.magic()) { boolean m = bytes.length >= sig.length; for (int i = 0; m && i < sig.length; i++) m = (bytes[i] & 0xff) == sig[i]; if (m) { ok = true; break; } }
            if (!ok) return new Check(null, "The file content does not match its type.");
        }
        return new Check(type, null);
    }

    public static Served served(String mime) {
        String type = typeOf(mime);
        boolean known = kindOf(type) != null;
        boolean inline = known && (type.startsWith("image/") || type.equals("application/pdf"));
        return new Served(known ? type : "application/octet-stream", inline ? "inline" : "attachment");
    }
}

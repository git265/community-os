package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.MissingNode;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * The few JavaScript behaviours the rule book relies on, so the Java rules decide exactly like the JS ones:
 * a missing field is "undefined" (different from null), `x || ''`, truthiness, `Number(x)`, and `JSON.stringify(a) !== JSON.stringify(b)`.
 */
public final class Js {
    private Js() {}

    public static final JsonNode MISSING = MissingNode.getInstance();

    /** record?.key : MISSING when the record or the field is absent. */
    public static JsonNode f(JsonNode rec, String key) {
        if (rec == null || !rec.isObject()) return MISSING;
        JsonNode v = rec.get(key);
        return v == null ? MISSING : v;
    }
    /** `o[key] = v`, except that an undefined value (MISSING) leaves the key out, as JSON.stringify would. */
    public static void set(com.fasterxml.jackson.databind.node.ObjectNode o, String key, JsonNode v) { if (v != null && !v.isMissingNode()) o.set(key, v); }

    /** array?.[i] : MISSING when out of range or not an array. */
    public static JsonNode at(JsonNode arr, int i) {
        if (arr == null || !arr.isArray() || i < 0 || i >= arr.size()) return MISSING;
        return arr.get(i);
    }
    public static boolean has(JsonNode rec, String key) { return !f(rec, key).isMissingNode(); }

    /** `String(x ?? '')` for display and comparisons where undefined and null both mean "nothing". */
    public static String str(JsonNode n) {
        if (n == null || n.isMissingNode() || n.isNull()) return "";
        if (n.isTextual()) return n.asText();
        if (n.isNumber()) return num(n.asDouble());
        if (n.isBoolean()) return n.asBoolean() ? "true" : "false";
        return n.toString();
    }
    public static String str(JsonNode rec, String key) { return str(f(rec, key)); }

    /** The text of a string field, or null when it is not a string (undefined / null / number ...). Use for `x === 'literal'` tests. */
    public static String text(JsonNode rec, String key) { JsonNode n = f(rec, key); return n.isTextual() ? n.asText() : null; }
    public static boolean is(JsonNode rec, String key, String literal) { return literal.equals(text(rec, key)); }

    /** JavaScript truthiness. */
    public static boolean truthy(JsonNode n) {
        if (n == null || n.isMissingNode() || n.isNull()) return false;
        if (n.isBoolean()) return n.asBoolean();
        if (n.isNumber()) { double d = n.asDouble(); return d != 0 && !Double.isNaN(d); }
        if (n.isTextual()) return !n.asText().isEmpty();
        return true;   // arrays and objects
    }
    public static boolean truthy(JsonNode rec, String key) { return truthy(f(rec, key)); }

    /** `Number(x) || 0`. */
    public static double number(JsonNode n) {
        if (n == null || n.isMissingNode() || n.isNull()) return 0;
        double d;
        if (n.isNumber()) d = n.asDouble();
        else if (n.isBoolean()) d = n.asBoolean() ? 1 : 0;
        else if (n.isTextual()) {
            String s = n.asText().trim();
            if (s.isEmpty()) return 0;
            try { d = Double.parseDouble(s); } catch (NumberFormatException e) { return 0; }
        } else return 0;
        return Double.isNaN(d) ? 0 : d;
    }
    public static double number(JsonNode rec, String key) { return number(f(rec, key)); }

    /** `Number(x)`: undefined -> NaN, null and '' -> 0, an unreadable text -> NaN. */
    public static double toNumber(JsonNode n) {
        if (n == null || n.isMissingNode()) return Double.NaN;
        if (n.isNull()) return 0;
        if (n.isNumber()) return n.asDouble();
        if (n.isBoolean()) return n.asBoolean() ? 1 : 0;
        if (n.isTextual()) {
            String s = n.asText().trim();
            if (s.isEmpty()) return 0;
            try { return Double.parseDouble(s); } catch (NumberFormatException e) { return Double.NaN; }
        }
        return Double.NaN;
    }

    /** `a === b` for two field values (strings, numbers, booleans; undefined !== null). */
    public static boolean strictEq(JsonNode a, JsonNode b) {
        boolean am = a == null || a.isMissingNode(); boolean bm = b == null || b.isMissingNode();
        if (am || bm) return am && bm;
        if (a.isNull() || b.isNull()) return a.isNull() && b.isNull();
        if (a.isNumber() && b.isNumber()) return a.asDouble() == b.asDouble();
        if (a.isTextual() && b.isTextual()) return a.asText().equals(b.asText());
        if (a.isBoolean() && b.isBoolean()) return a.asBoolean() == b.asBoolean();
        return false;   // objects and arrays are compared by reference in JS: never equal here
    }

    /** `JSON.stringify(x)`; null for undefined. Object keys keep their order; whole numbers print without ".0". */
    public static String stringify(JsonNode n) {
        if (n == null || n.isMissingNode()) return null;
        StringBuilder sb = new StringBuilder();
        write(n, sb);
        return sb.toString();
    }
    private static void write(JsonNode n, StringBuilder sb) {
        if (n.isNull()) sb.append("null");
        else if (n.isBoolean()) sb.append(n.asBoolean());
        else if (n.isNumber()) sb.append(num(n.asDouble()));
        else if (n.isTextual()) quote(n.asText(), sb);
        else if (n.isArray()) {
            sb.append('[');
            for (int i = 0; i < n.size(); i++) { if (i > 0) sb.append(','); JsonNode c = n.get(i); if (c.isMissingNode()) sb.append("null"); else write(c, sb); }
            sb.append(']');
        } else {
            sb.append('{');
            boolean first = true;
            for (Iterator<Map.Entry<String, JsonNode>> it = n.fields(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> e = it.next();
                if (!first) sb.append(',');
                first = false;
                quote(e.getKey(), sb); sb.append(':'); write(e.getValue(), sb);
            }
            sb.append('}');
        }
    }
    private static void quote(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                default -> { if (c < 0x20) sb.append(String.format("\\u%04x", (int) c)); else sb.append(c); }
            }
        }
        sb.append('"');
    }
    static String num(double d) { return numberToString(d); }

    /** JavaScript's Number.prototype.toString: 1000, 0.1, 1234567.5, 1e+21, 1.5e-7 (never "1000.0" or "1.5E-7"). */
    public static String numberToString(double d) {
        if (Double.isNaN(d)) return "NaN";
        if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "-Infinity";
        if (d == 0) return "0";
        String sign = d < 0 ? "-" : "";
        java.math.BigDecimal bd = new java.math.BigDecimal(Double.toString(Math.abs(d))).stripTrailingZeros();
        String digits = bd.unscaledValue().toString();
        int k = digits.length();
        int n = k - bd.scale();   // the position of the decimal point, counted from the first digit
        StringBuilder sb = new StringBuilder(sign);
        if (k <= n && n <= 21) { sb.append(digits); for (int i = 0; i < n - k; i++) sb.append('0'); }
        else if (0 < n && n <= 21) sb.append(digits, 0, n).append('.').append(digits, n, k);
        else if (-6 < n && n <= 0) { sb.append("0."); for (int i = 0; i < -n; i++) sb.append('0'); sb.append(digits); }
        else {
            int e = n - 1;
            sb.append(digits.charAt(0));
            if (k > 1) sb.append('.').append(digits, 1, k);
            sb.append('e').append(e < 0 ? '-' : '+').append(Math.abs(e));
        }
        return sb.toString();
    }

    /** JavaScript's String(x): undefined and null print as words, arrays join with commas, objects are "[object Object]". */
    public static String toStr(JsonNode n) {
        if (n == null || n.isMissingNode()) return "undefined";
        if (n.isNull()) return "null";
        if (n.isTextual()) return n.asText();
        if (n.isNumber()) return numberToString(n.asDouble());
        if (n.isBoolean()) return n.asBoolean() ? "true" : "false";
        if (n.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < n.size(); i++) { if (i > 0) sb.append(','); JsonNode c = n.get(i); if (!c.isNull() && !c.isMissingNode()) sb.append(toStr(c)); }
            return sb.toString();
        }
        return "[object Object]";
    }

    /** `String(x || '')`. */
    public static String orEmpty(JsonNode n) { return truthy(n) ? toStr(n) : ""; }

    /** JavaScript's String.prototype.trim(): also removes no-break spaces, the byte-order mark and other Unicode spaces. */
    public static String trim(String s) {
        int a = 0, b = s.length();
        while (a < b && isSpace(s.charAt(a))) a++;
        while (b > a && isSpace(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }
    /** What JavaScript's `\s` matches. */
    public static boolean isSpace(char c) {
        return c == ' ' || (c >= '\t' && c <= '\r') || c == '\u00a0' || c == '\u1680' || (c >= '\u2000' && c <= '\u200a') || c == '\u2028' || c == '\u2029' || c == '\u202f' || c == '\u205f' || c == '\u3000' || c == '\ufeff';
    }

    /** Object.entries(x): object fields (whole-number keys first, ascending), array items, the characters of a string; nothing for other values. */
    public static List<Map.Entry<String, JsonNode>> entries(JsonNode n) {
        List<Map.Entry<String, JsonNode>> out = new ArrayList<>();
        if (n == null || n.isMissingNode() || n.isNull()) return out;
        if (n.isArray()) { for (int i = 0; i < n.size(); i++) out.add(Map.entry(Integer.toString(i), n.get(i))); return out; }
        if (n.isTextual()) {
            String s = n.asText();
            for (int i = 0; i < s.length(); i++) out.add(Map.entry(Integer.toString(i), com.fasterxml.jackson.databind.node.TextNode.valueOf(String.valueOf(s.charAt(i)))));
            return out;
        }
        if (!n.isObject()) return out;
        List<Map.Entry<String, JsonNode>> ints = new ArrayList<>(), others = new ArrayList<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = n.fields(); it.hasNext(); ) { Map.Entry<String, JsonNode> e = it.next(); (isIndex(e.getKey()) ? ints : others).add(Map.entry(e.getKey(), e.getValue())); }
        ints.sort((a, b) -> Long.compare(Long.parseLong(a.getKey()), Long.parseLong(b.getKey())));
        out.addAll(ints); out.addAll(others);
        return out;
    }
    /** A JavaScript array index: "0", "17" (no leading zeros, below 2^32 - 1). */
    private static boolean isIndex(String k) {
        if (k.isEmpty() || k.length() > 10 || (k.length() > 1 && k.charAt(0) == '0')) return false;
        for (int i = 0; i < k.length(); i++) if (k.charAt(i) < '0' || k.charAt(i) > '9') return false;
        return Long.parseLong(k) < 4294967295L;
    }

    /** `JSON.stringify(a) !== JSON.stringify(b)` */
    public static boolean differs(JsonNode a, JsonNode b) {
        String x = stringify(a); String y = stringify(b);
        return x == null ? y != null : !x.equals(y);
    }

    /** The values of an array field as strings (non-arrays give an empty list). */
    public static List<String> strings(JsonNode rec, String key) {
        JsonNode a = f(rec, key);
        List<String> out = new ArrayList<>();
        if (a.isArray()) a.forEach((x) -> out.add(str(x)));
        return out;
    }
    public static List<JsonNode> list(JsonNode rec, String key) {
        JsonNode a = f(rec, key);
        List<JsonNode> out = new ArrayList<>();
        if (a.isArray()) a.forEach(out::add);
        return out;
    }
}

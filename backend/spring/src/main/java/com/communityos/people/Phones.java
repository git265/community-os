package com.communityos.people;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.InputStream;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Phone numbers, exactly as the browser checks them (src/lib/phone.js on libphonenumber-js 1.11.14 "min" metadata).
 *
 * <p>There is no libphonenumber jar in this build, so this is a port of the part of libphonenumber-js the app uses: parse a number that starts
 * with "+", decide whether it is possible / valid for its country, and format it internationally. It reads the same metadata file
 * (resources/phone/metadata.min.json, copied from node_modules), so the rules per country are identical. When the npm package is upgraded,
 * copy the new metadata file and re-run PhoneConformanceCheck (golden corpus from test/gen-people-golden.mjs).
 */
public final class Phones {

    /** The outcome of {@link #validate}: ok + E.164 + international format + country, or a message for the person typing it. */
    public record Result(boolean ok, String e164, String formatted, String country, String error) {
        static Result fail(String e) { return new Result(false, null, null, null, e); }
    }

    // ---------------------------------------------------------------- constants (libphonenumber-js constants.js)
    private static final String VALID_DIGITS = "0-9０-９٠-٩۰-۹";
    private static final String DASHES = "-‐-―−ー－";
    private static final String SLASHES = "／/";
    private static final String DOTS = "．.";
    private static final String WHITESPACE = "  ­​⁠　";
    private static final String BRACKETS = "()（）［］\\[\\]";
    private static final String TILDES = "~⁓∼～";
    private static final String VALID_PUNCTUATION = DASHES + SLASHES + DOTS + WHITESPACE + BRACKETS + TILDES;
    private static final String PLUS_CHARS = "+＋";
    private static final int MIN_LENGTH_FOR_NSN = 2, MAX_LENGTH_FOR_NSN = 17, MAX_LENGTH_COUNTRY_CODE = 3, MAX_INPUT = 250;
    private static final String DEFAULT_EXT_PREFIX = " ext. ";

    private static final Pattern START = Pattern.compile("[" + PLUS_CHARS + VALID_DIGITS + "]");
    private static final Pattern AFTER_END = Pattern.compile("[^" + VALID_DIGITS + "#]+$");
    private static final String EXTN = extensionPattern();
    private static final int CI = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;
    private static final String VALID_PHONE_NUMBER = "[" + PLUS_CHARS + "]{0,1}(?:[" + VALID_PUNCTUATION + "]*[" + VALID_DIGITS + "]){3,}["
            + VALID_PUNCTUATION + VALID_DIGITS + "]*";
    private static final Pattern VIABLE = Pattern.compile("^[" + VALID_DIGITS + "]{" + MIN_LENGTH_FOR_NSN + "}$|^" + VALID_PHONE_NUMBER
            + "(?:" + EXTN + ")?$", CI);
    private static final Pattern VIABLE_START = Pattern.compile("^[" + PLUS_CHARS + "]{0,1}(?:[" + VALID_PUNCTUATION + "]*[" + VALID_DIGITS
            + "]){1,2}$", CI);
    private static final Pattern EXTN_AT_END = Pattern.compile("(?:" + EXTN + ")$", CI);
    private static final Pattern PUNCT_RUN = Pattern.compile("[" + VALID_PUNCTUATION + "]+");
    private static final String PHONE_CONTEXT = ";phone-context=", RFC_PREFIX = "tel:", ISUB = ";isub=";
    private static final String RFC_DIGIT = "([" + VALID_DIGITS + "]|[\\-\\.\\(\\)]?)";
    private static final Pattern RFC_GLOBAL = Pattern.compile("^\\+" + RFC_DIGIT + "*[" + VALID_DIGITS + "]" + RFC_DIGIT + "*$");
    private static final Pattern RFC_DOMAIN = Pattern.compile("^([" + VALID_DIGITS + "]+((\\-)*[" + VALID_DIGITS + "])*\\.)*[a-zA-Z]+((\\-)*["
            + VALID_DIGITS + "])*\\.?$");
    private static final String[] NON_FIXED = { "MOBILE", "PREMIUM_RATE", "TOLL_FREE", "SHARED_COST", "VOIP", "PERSONAL_NUMBER", "PAGER", "UAN", "VOICEMAIL" };

    private static String extensionPattern() {
        String digits = "([" + VALID_DIGITS + "]{1,%s})";
        String sepBefore = "[  \\t,]*", after = "[:\\.．]?[  \\t,-]*", suffix = "#?";
        String explicit = "(?:e?xt(?:ensi(?:ó?|ó))?n?|ｅ?ｘｔｎ?|доб|anexo)";
        String ambiguous = "(?:[xｘ#＃~～]|int|ｉｎｔ)";
        String noComma = "[  \\t]*";
        return ";ext=" + digits.formatted("20")
                + "|" + sepBefore + explicit + after + digits.formatted("20") + suffix
                + "|" + sepBefore + ambiguous + after + digits.formatted("9") + suffix
                + "|" + "[- ]+" + digits.formatted("6") + "#"
                + "|" + noComma + "(?:,{2}|;)" + after + digits.formatted("15") + suffix
                + "|" + noComma + "(?:,)+" + after + digits.formatted("9") + suffix;
    }

    // ---------------------------------------------------------------- metadata
    private static final JsonNode META = load();
    private static final Map<String, Pattern> PATTERNS = new java.util.concurrent.ConcurrentHashMap<>();

    private static JsonNode load() {
        try (InputStream in = Phones.class.getResourceAsStream("/phone/metadata.min.json")) {
            if (in == null) throw new IllegalStateException("phone/metadata.min.json is missing from the classpath");
            return new ObjectMapper().readTree(in);
        } catch (java.io.IOException e) { throw new IllegalStateException(e); }
    }

    private static Pattern re(String p) { return PATTERNS.computeIfAbsent(p, Pattern::compile); }
    private static boolean matchesEntirely(String text, String p) { return re("(?:" + p + ")").matcher(text == null ? "" : text).matches(); }
    /** JS {@code text.search(p) === 0}. */
    private static boolean startsWith(String text, String p) { return re(p).matcher(text).lookingAt(); }
    private static String str(JsonNode n) { return n == null || n.isNull() || !n.isTextual() ? null : n.asText(); }
    private static JsonNode at(JsonNode a, int i) { return a == null || !a.isArray() || i >= a.size() ? null : a.get(i); }
    private static boolean truthy(JsonNode n) {
        if (n == null || n.isNull()) return false;
        if (n.isNumber()) return n.asDouble() != 0;
        if (n.isTextual()) return !n.asText().isEmpty();
        if (n.isBoolean()) return n.asBoolean();
        return true;
    }
    private static int[] lengths(JsonNode n) {
        if (n == null || !n.isArray()) return null;
        int[] r = new int[n.size()];
        for (int i = 0; i < r.length; i++) r[i] = n.get(i).asInt();
        return r;
    }

    private static List<String> codesFor(String callingCode) {
        JsonNode c = META.path("country_calling_codes").get(callingCode);
        if (c == null) return null;
        if (c.size() == 1 && c.get(0).asText().length() == 3) return null;
        List<String> out = new ArrayList<>();
        c.forEach(x -> out.add(x.asText()));
        return out;
    }
    private static boolean hasCallingCode(String cc) { return codesFor(cc) != null || META.path("nonGeographic").has(cc); }
    private static JsonNode planForCallingCode(String cc) {
        List<String> codes = codesFor(cc);
        if (codes != null) return META.path("countries").get(codes.get(0));
        return META.path("nonGeographic").get(cc);
    }

    /** One selected numbering plan (libphonenumber-js NumberingPlan for metadata version 4). */
    private record Plan(JsonNode m) {
        String callingCode() { return m.get(0).asText(); }
        String nationalNumberPattern() { return str(at(m, 2)); }
        int[] possibleLengths() { return lengths(at(m, 3)); }
        Plan main() { return new Plan(planForCallingCode(callingCode())); }
        JsonNode formats() {
            JsonNode f = at(m, 4);
            if (f != null && f.isArray()) return f;
            JsonNode d = at(main().m, 4);
            return d != null && d.isArray() ? d : com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode();
        }
        String nationalPrefix() { return str(at(m, 5)); }
        String nationalPrefixForParsing() { String p = str(at(m, 7)); return p != null && !p.isEmpty() ? p : nationalPrefix(); }
        String nationalPrefixTransformRule() { return str(at(m, 8)); }
        String leadingDigits() { return str(at(m, 10)); }
        JsonNode types() { return at(m, 11); }
        boolean hasTypes() { JsonNode t = types(); return t != null && !t.isNull() && !(t.isArray() && t.size() == 0) && truthy(t); }
        String ext() { String e = str(at(m, 13)); return e != null && !e.isEmpty() ? e : DEFAULT_EXT_PREFIX; }
        /** [pattern, possibleLengths?] or null. */
        JsonNode type(String name) {
            if (!hasTypes()) return null;
            int i = switch (name) {
                case "FIXED_LINE" -> 0; case "MOBILE" -> 1; case "TOLL_FREE" -> 2; case "PREMIUM_RATE" -> 3; case "PERSONAL_NUMBER" -> 4;
                case "VOICEMAIL" -> 5; case "UAN" -> 6; case "PAGER" -> 7; case "VOIP" -> 8; case "SHARED_COST" -> 9; default -> -1;
            };
            JsonNode t = i < 0 ? null : at(types(), i);
            return truthy(t) ? t : null;
        }
        String typePattern(JsonNode t) { return str(at(t, 0)); }
        int[] typeLengths(JsonNode t) { int[] l = lengths(at(t, 1)); return l != null ? l : possibleLengths(); }
    }
    private static Plan country(String c) { return new Plan(META.path("countries").get(c)); }

    // ---------------------------------------------------------------- parse
    /** A parsed number (the fields of libphonenumber-js PhoneNumber that phone.js reads). */
    record Parsed(String countryCallingCode, String nationalNumber, String country, String ext) {
        String number() { return "+" + countryCallingCode + nationalNumber; }
    }

    private static final class NotANumber extends Exception { NotANumber() { super(null, null, false, false); } }

    /** parsePhoneNumberFromString(text) with no default country: null where it returns undefined. */
    static Parsed parse(String text) {
        try { return parseOrThrow(text); } catch (NotANumber e) { return null; }
    }

    private static Parsed parseOrThrow(String text) throws NotANumber {
        String[] numberExt = parseInput(text);
        if (numberExt == null || numberExt[0] == null || numberExt[0].isEmpty()) throw new NotANumber();
        String formatted = numberExt[0], ext = numberExt[1];

        String number = incomplete(formatted);
        // extractCountryCallingCode (no default country: only the "+" form is understood)
        if (number.isEmpty() || number.charAt(0) != '+' || (number.length() > 1 && number.charAt(1) == '0')) throw new NotANumber();
        String cc = null, rest = null;
        for (int i = 2; i - 1 <= MAX_LENGTH_COUNTRY_CODE && i <= number.length(); i++) {
            String c = number.substring(1, i);
            if (hasCallingCode(c)) { cc = c; rest = number.substring(i); break; }
        }
        if (cc == null) throw new NotANumber();
        Plan plan = new Plan(planForCallingCode(cc));
        if (rest.isEmpty()) throw new NotANumber();

        String national = extractNationalNumber(incomplete(rest), plan);
        String country = null;
        List<String> possible = codesFor(cc);
        if (possible != null) {
            if (possible.size() == 1) country = possible.get(0);
            else for (String c : possible) {
                Plan p = country(c);
                if (p.leadingDigits() != null && !p.leadingDigits().isEmpty()) { if (startsWith(national, p.leadingDigits())) { country = c; break; } }
                else if (numberType(national, p) != null) { country = c; break; }
            }
        }
        if (national.length() < MIN_LENGTH_FOR_NSN || national.length() > MAX_LENGTH_FOR_NSN) throw new NotANumber();
        return new Parsed(cc, national, country, ext);
    }

    /** parseInput: RFC 3966 unwrapping, extraction of the number from surrounding text, viability, extension. Returns {number, ext}. */
    private static String[] parseInput(String text) throws NotANumber {
        String number;
        int pc = text.indexOf(PHONE_CONTEXT);
        String context = null;
        if (pc >= 0) {
            int start = pc + PHONE_CONTEXT.length();
            if (start >= text.length()) context = "";
            else { int end = text.indexOf(';', start); context = end >= 0 ? text.substring(start, end) : text.substring(start); }
        }
        if (context != null && (context.isEmpty() || !(RFC_GLOBAL.matcher(context).find() || RFC_DOMAIN.matcher(context).find()))) throw new NotANumber();
        if (context == null) {
            number = extractFormatted(text);
            if (number == null) number = "";
        } else {
            number = context.startsWith("+") ? context : "";
            int tel = text.indexOf(RFC_PREFIX);
            int from = tel >= 0 ? tel + RFC_PREFIX.length() : 0;
            number += jsSubstring(text, from, pc);
        }
        int isub = number.indexOf(ISUB);
        if (isub > 0) number = number.substring(0, isub);
        if (number.isEmpty()) return null;
        if (!(number.length() >= MIN_LENGTH_FOR_NSN && VIABLE.matcher(number).find())) {
            if (VIABLE_START.matcher(number).find()) throw new NotANumber(); // TOO_SHORT
            return null;
        }
        Matcher m = EXTN_AT_END.matcher(number);
        if (m.find()) {
            for (int g = 1; g <= m.groupCount(); g++) {
                String v = m.group(g);
                if (v != null && !v.isEmpty()) return new String[] { number.substring(0, m.start()), v };
            }
            return new String[] { null, null }; // JS: undefined -> parse treats as not a number
        }
        return new String[] { number, null };
    }

    /** JS String.prototype.substring (swaps arguments, clamps). */
    private static String jsSubstring(String s, int a, int b) {
        a = Math.max(0, Math.min(a, s.length())); b = Math.max(0, Math.min(b, s.length()));
        return s.substring(Math.min(a, b), Math.max(a, b));
    }

    private static String extractFormatted(String text) throws NotANumber {
        if (text.isEmpty()) return null;
        if (text.length() > MAX_INPUT) throw new NotANumber(); // TOO_LONG
        Matcher m = START.matcher(text);
        if (!m.find()) return null;
        return AFTER_END.matcher(text.substring(m.start())).replaceFirst("");
    }

    /** parseIncompletePhoneNumber: digits (any script) to ASCII, "+" only as the first character. */
    private static String incomplete(String s) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '+') { if (out.length() == 0) out.append('+'); else continue; }
            else { int d = digit(c); if (d >= 0) out.append((char) ('0' + d)); }
        }
        return out.toString();
    }
    private static int digit(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= '０' && c <= '９') return c - '０';
        if (c >= '٠' && c <= '٩') return c - '٠';
        if (c >= '۰' && c <= '۹') return c - '۰';
        return -1;
    }

    private static String extractNationalNumber(String number, Plan plan) {
        String nn = number;
        String npp = plan.nationalPrefixForParsing();
        if (!number.isEmpty() && npp != null && !npp.isEmpty()) {
            Pattern prefix = re("^(?:" + npp + ")");
            Matcher m = prefix.matcher(number);
            if (m.find()) {
                int groups = m.groupCount();
                String last = groups > 0 ? m.group(groups) : null;
                boolean captured = groups > 0 && last != null && !last.isEmpty();
                String rule = plan.nationalPrefixTransformRule();
                if (rule != null && !rule.isEmpty() && captured) nn = prefix.matcher(number).replaceFirst(jsReplacement(rule));
                else nn = number.substring(m.group(0).length());
            }
        }
        if (!nn.equals(number)) {
            String pat = plan.nationalNumberPattern();
            if (matchesEntirely(number, pat) && !matchesEntirely(nn, pat)) return number;
            if (plan.possibleLengths() != null) {
                String len = checkLength(nn, plan.possibleLengths());
                if (len.equals("TOO_SHORT") || len.equals("INVALID_LENGTH")) return number;
            }
        }
        return nn;
    }

    /** A JS replacement string ("$1 $2", "0$1") for Matcher.replaceFirst: "$n" stays, a lone "$" becomes literal. */
    private static String jsReplacement(String r) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < r.length(); i++) {
            char c = r.charAt(i);
            if (c == '$' && i + 1 < r.length() && Character.isDigit(r.charAt(i + 1))) b.append('$');
            else if (c == '$' || c == '\\') b.append('\\').append(c);
            else b.append(c);
        }
        return b.toString();
    }

    private static String checkLength(String nn, int[] lengths) {
        if (lengths == null) return "IS_POSSIBLE";
        int n = nn.length();
        if (lengths[0] == n) return "IS_POSSIBLE";
        if (lengths[0] > n) return "TOO_SHORT";
        if (lengths[lengths.length - 1] < n) return "TOO_LONG";
        for (int i = 1; i < lengths.length; i++) if (lengths[i] == n) return "IS_POSSIBLE";
        return "INVALID_LENGTH";
    }

    private static boolean isType(String nn, String type, Plan p) {
        JsonNode t = p.type(type);
        String pat = t == null ? null : p.typePattern(t);
        if (pat == null || pat.isEmpty()) return false;
        int[] l = p.typeLengths(t);
        if (l != null) { boolean in = false; for (int x : l) if (x == nn.length()) { in = true; break; } if (!in) return false; }
        return matchesEntirely(nn, pat);
    }

    private static String numberType(String nn, Plan p) {
        if (!matchesEntirely(nn, p.nationalNumberPattern())) return null;
        if (isType(nn, "FIXED_LINE", p)) {
            JsonNode mobile = p.type("MOBILE");
            if (mobile != null && "".equals(p.typePattern(mobile))) return "FIXED_LINE_OR_MOBILE";
            if (mobile == null) return "FIXED_LINE_OR_MOBILE";
            if (isType(nn, "MOBILE", p)) return "FIXED_LINE_OR_MOBILE";
            return "FIXED_LINE";
        }
        for (String t : NON_FIXED) if (isType(nn, t, p)) return t;
        return null;
    }

    static boolean isPossible(Parsed n) {
        Plan p = new Plan(planForCallingCode(n.countryCallingCode()));
        if (p.possibleLengths() != null) return checkLength(n.nationalNumber(), p.possibleLengths()).equals("IS_POSSIBLE");
        return META.path("nonGeographic").has(n.countryCallingCode());
    }

    static boolean isValid(Parsed n) {
        Plan p = n.country() != null ? country(n.country()) : new Plan(planForCallingCode(n.countryCallingCode()));
        if (p.hasTypes()) return numberType(n.nationalNumber(), p) != null;
        return matchesEntirely(n.nationalNumber(), p.nationalNumberPattern());
    }

    static String formatInternational(Parsed n) {
        Plan p = n.country() != null ? country(n.country()) : new Plan(planForCallingCode(n.countryCallingCode()));
        String nn = n.nationalNumber();
        String body = nn;
        for (JsonNode f : p.formats()) {
            JsonNode lead = at(f, 2);
            if (lead != null && lead.isArray() && lead.size() > 0 && !startsWith(nn, lead.get(lead.size() - 1).asText())) continue;
            if (matchesEntirely(nn, f.get(0).asText())) {
                String intl = str(at(f, 5));
                if (intl == null || intl.isEmpty()) intl = f.get(1).asText();
                body = PUNCT_RUN.matcher(re(f.get(0).asText()).matcher(nn).replaceFirst(jsReplacement(intl))).replaceAll(" ").trim();
                break;
            }
        }
        String out = "+" + p.callingCode() + " " + body;
        return n.ext() != null && !n.ext().isEmpty() ? out + p.ext() + n.ext() : out;
    }

    // ---------------------------------------------------------------- phone.js
    private static final String ASC = "01234567890123456789", DESC = "98765432109876543210";
    private static final Pattern SAME_DIGIT = Pattern.compile("^(\\d)\\1+$");

    static boolean placeholder(String national) {
        String d = national.replaceAll("\\D", "");
        if (d.length() < 6) return false;
        if (SAME_DIGIT.matcher(d).find()) return true;
        if (ASC.contains(d) || DESC.contains(d)) return true;
        return d.chars().distinct().count() <= 2 && d.length() >= 8;
    }

    /** JS String.prototype.trim: strips WhiteSpace and LineTerminator code points (wider than Java's trim / strip). */
    static String jsTrim(String s) {
        int a = 0, b = s.length();
        while (a < b && jsSpace(s.charAt(a))) a++;
        while (b > a && jsSpace(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }
    private static boolean jsSpace(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\u000B' || c == '\f' || c == ' ' || c == ' '
                || (c >= ' ' && c <= ' ') || c == ' ' || c == ' ' || c == ' ' || c == ' ' || c == '　' || c == '﻿';
    }

    /** validatePhone(raw) from src/lib/phone.js. */
    public static Result validate(String raw) {
        String text = jsTrim(raw == null ? "" : raw);
        if (text.isEmpty()) return Result.fail("Phone number is required");
        if (!text.startsWith("+")) return Result.fail("Start with the country code, e.g. +91 98450 71234");
        Parsed p;
        try { p = parse(text); } catch (RuntimeException e) { p = null; }
        if (p == null) return Result.fail("This is not a recognisable phone number — check the country code and digits");
        boolean possible = isPossible(p);
        if (p.country() == null && !possible) return Result.fail("Unknown country code");
        if (!possible) return Result.fail("Wrong number of digits for " + (p.country() != null ? p.country() : "this country"));
        if (!isValid(p)) return Result.fail(("Not a valid " + (p.country() != null ? p.country() : "") + " number — check the digits (area / mobile prefix)").replaceFirst("  ", " "));
        if (placeholder(p.nationalNumber())) return Result.fail("This looks like a placeholder number — enter the real one");
        return new Result(true, p.number(), formatInternational(p), p.country() != null ? p.country() : "", null);
    }

    /** phoneKey(raw): E.164 when valid, else the digits and "+" signs only. */
    public static String key(String raw) {
        Result v = validate(raw);
        return v.ok() ? v.e164() : (raw == null ? "" : raw).replaceAll("[^\\d+]", "");
    }

    /** maskPhone(e164). */
    public static String mask(String e164) {
        return e164 == null || e164.isEmpty() ? "" : e164.substring(0, Math.min(3, e164.length())) + "••••••" + e164.substring(Math.max(0, e164.length() - 3));
    }

    private Phones() {}
}

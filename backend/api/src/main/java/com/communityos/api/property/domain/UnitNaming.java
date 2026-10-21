package com.communityos.api.property.domain;

import com.communityos.api.shared.domain.DomainException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * How unit numbers are written. The same rules run in the app (src/lib/unitNaming.js) so a form can say what is wrong before saving.
 *
 * Every unit number: no spaces at either end, single spaces inside, 1-40 characters of letters, digits, space, '.', '/' and '-', starting and
 * ending with a letter or digit. Two numbers that differ only in case are the same unit.
 *
 * A naming pattern (the community's, or a block's own) adds a shape. It is plain text with these parts:
 *   {n}        a number, any length ("Villa {n}" -> Villa 7, Villa 135)
 *   {n:3}      a number of exactly 3 digits, zero-padded ("A-{n:3}" -> A-007)
 *   {floor}    a floor number, any length; {floor:2} exactly 2 digits
 *   {letter}   one letter ("{n}{letter}" -> 12B)
 *   {block}    the unit's block code (or, without a code, its name)
 * The text around the parts is matched ignoring case. A pattern needs at least one of {n}, {floor} or {letter}.
 * Examples: "Villa {n}", "{block}-{floor}{n:2}" (A-1204 = block A, floor 12, flat 04), "T{n}/{n:4}" is not allowed (two {n}).
 */
public final class UnitNaming {
    public static final int MAX = 40;
    static final Pattern CHARS = Pattern.compile("[A-Za-z0-9]([A-Za-z0-9 ./-]*[A-Za-z0-9])?");
    static final Pattern TOKEN = Pattern.compile("\\{(n|floor|letter|block)(?::([1-6]))?}");
    private UnitNaming() {}

    /** The number as it is stored: trimmed, single spaces. */
    public static String normalize(String s) { return s == null ? "" : s.strip().replaceAll("\\s+", " "); }
    /** The key two numbers are compared by (case and spacing ignored). */
    public static String key(String s) { return normalize(s).toLowerCase(Locale.ROOT); }

    /** A pattern someone wants to save: refuses unknown parts, repeated parts and patterns with nothing that varies. Returns it trimmed (or null). */
    public static String checkPattern(String pattern) {
        if (pattern == null || pattern.isBlank()) return null;
        String p = pattern.strip();
        if (p.length() > 60) throw new DomainException.RuleViolated("bad-pattern", "A naming pattern is at most 60 characters");
        String rest = TOKEN.matcher(p).replaceAll("");
        if (rest.contains("{") || rest.contains("}")) throw new DomainException.RuleViolated("bad-pattern", "Use only {n}, {n:3}, {floor}, {floor:2}, {letter} and {block} in a naming pattern");
        if (!rest.isEmpty() && !rest.matches("[A-Za-z0-9 ./-]*")) throw new DomainException.RuleViolated("bad-pattern", "A naming pattern may contain letters, digits, space, '.', '/' and '-' around its parts");
        List<String> seen = new ArrayList<>(); Matcher m = TOKEN.matcher(p); boolean varies = false;
        while (m.find()) {
            if (seen.contains(m.group(1))) throw new DomainException.RuleViolated("bad-pattern", "{" + m.group(1) + "} appears twice in the naming pattern");
            seen.add(m.group(1)); varies |= !"block".equals(m.group(1));
        }
        if (!varies) throw new DomainException.RuleViolated("bad-pattern", "A naming pattern needs {n}, {floor} or {letter} - otherwise every unit would have the same number");
        return p;
    }

    /** The regular expression a pattern stands for, with the block's code (or name) put in for {block}. */
    static Pattern regex(String pattern, String block) {
        StringBuilder out = new StringBuilder("(?i)"); Matcher m = TOKEN.matcher(pattern); int at = 0;
        while (m.find()) {
            out.append(Pattern.quote(pattern.substring(at, m.start())));
            String w = m.group(2);
            out.append(switch (m.group(1)) {
                case "n", "floor" -> w == null ? "[0-9]+" : "[0-9]{" + w + "}";
                case "letter" -> "[A-Za-z]";
                default -> Pattern.quote(block == null ? "" : block);
            });
            at = m.end();
        }
        out.append(Pattern.quote(pattern.substring(at)));
        return Pattern.compile(out.toString());
    }

    /** What is wrong with a number, or null. `pattern` may be null; `block` is the block's code or name (for {block}). */
    public static String problem(String unitNo, String pattern, String block) {
        String u = normalize(unitNo);
        if (u.isEmpty()) return "Enter the unit number";
        if (u.length() > MAX) return "A unit number is at most " + MAX + " characters";
        if (!CHARS.matcher(u).matches()) return "Use letters, digits, space, '.', '/' and '-' in a unit number, starting and ending with a letter or digit";
        if (pattern != null && !pattern.isBlank()) {
            if (pattern.contains("{block}") && (block == null || block.isBlank())) return "This naming pattern uses {block}: put the unit in a block first";
            if (!regex(pattern, block).matcher(u).matches()) return "“" + u + "” does not follow the naming pattern “" + pattern + "”" + (example(pattern, block) == null ? "" : " (for example " + example(pattern, block) + ")");
        }
        return null;
    }
    /** Refuses a number that breaks the rules; returns it as it is stored. */
    public static String check(String unitNo, String pattern, String block) {
        String why = problem(unitNo, pattern, block);
        if (why != null) throw new DomainException.RuleViolated("bad-unit-number", why);
        return normalize(unitNo);
    }

    /** The number for {n} = n (and {floor} = floor) in a pattern, for adding units in bulk. Null when the pattern needs a part not given. */
    public static String make(String pattern, String block, Integer floor, int n) {
        StringBuilder out = new StringBuilder(); Matcher m = TOKEN.matcher(pattern); int at = 0;
        while (m.find()) {
            out.append(pattern, at, m.start());
            String w = m.group(2);
            switch (m.group(1)) {
                case "n" -> out.append(pad(n, w));
                case "floor" -> { if (floor == null) return null; out.append(pad(floor, w)); }
                case "letter" -> { return null; }
                default -> { if (block == null || block.isBlank()) return null; out.append(block); }
            }
            at = m.end();
        }
        return normalize(out.append(pattern.substring(at)).toString());
    }
    static String example(String pattern, String block) { String b = block == null || block.isBlank() ? "A" : block; String e = make(pattern, b, 1, 1); return e == null ? make(pattern.replace("{letter}", "B"), b, 1, 1) : e; }
    private static String pad(int v, String w) { return w == null ? String.valueOf(v) : String.format("%0" + w + "d", v); }
}

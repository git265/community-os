package com.communityos.api.docs.domain;

import com.communityos.api.shared.domain.DomainException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * What may be uploaded, decided from the bytes, not from what the browser says: the extension must be an allowed kind, the content must carry
 * that kind's signature, text must be text, and active content (scripts in a PDF, macros, the EICAR test virus) is refused. The stored type is
 * the one the server worked out. A virus scanner, when configured, runs after these checks. Videos (phone clips) are allowed up to 10 MB.
 */
public final class FileRules {
    private FileRules() {}
    public static final long MAX_BYTES = 25L * 1024 * 1024, MAX_VIDEO_BYTES = 10L * 1024 * 1024;
    /** at: where the signature starts (an MP4 / MOV says "ftyp" from byte 4); max: the largest file of this kind. */
    record Kind(List<String> ext, String mime, String label, byte[][] magic, boolean text, int at, long max) {
        Kind(List<String> ext, String mime, String label, byte[][] magic, boolean text) { this(ext, mime, label, magic, text, 0, MAX_BYTES); }
        boolean video() { return mime.startsWith("video/"); }
    }
    static byte[] b(int... xs) { byte[] o = new byte[xs.length]; for (int i = 0; i < xs.length; i++) o[i] = (byte) xs[i]; return o; }
    static final byte[] OLE = b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), ZIP = b(0x50, 0x4b, 0x03, 0x04), FTYP = b('f', 't', 'y', 'p');
    static final List<Kind> KINDS = List.of(
        new Kind(List.of("pdf"), "application/pdf", "PDF", new byte[][] {b(0x25, 0x50, 0x44, 0x46)}, false),
        new Kind(List.of("xls"), "application/vnd.ms-excel", "Excel (.xls)", new byte[][] {OLE}, false),
        new Kind(List.of("xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Excel (.xlsx)", new byte[][] {ZIP}, false),
        new Kind(List.of("doc"), "application/msword", "Word (.doc)", new byte[][] {OLE}, false),
        new Kind(List.of("docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word (.docx)", new byte[][] {ZIP}, false),
        new Kind(List.of("ppt"), "application/vnd.ms-powerpoint", "PowerPoint (.ppt)", new byte[][] {OLE}, false),
        new Kind(List.of("pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PowerPoint (.pptx)", new byte[][] {ZIP}, false),
        new Kind(List.of("rtf"), "application/rtf", "Rich text", new byte[][] {b(0x7b, 0x5c, 0x72, 0x74, 0x66)}, false),
        new Kind(List.of("txt"), "text/plain", "Text", null, true),
        new Kind(List.of("csv"), "text/csv", "CSV", null, true),
        new Kind(List.of("png"), "image/png", "PNG image", new byte[][] {b(0x89, 0x50, 0x4e, 0x47)}, false),
        new Kind(List.of("jpg", "jpeg"), "image/jpeg", "JPEG image", new byte[][] {b(0xff, 0xd8, 0xff)}, false),
        new Kind(List.of("gif"), "image/gif", "GIF image", new byte[][] {b(0x47, 0x49, 0x46, 0x38)}, false),
        new Kind(List.of("webp"), "image/webp", "WebP image", new byte[][] {b(0x52, 0x49, 0x46, 0x46)}, false),
        new Kind(List.of("mp4", "m4v"), "video/mp4", "MP4 video", new byte[][] {FTYP}, false, 4, MAX_VIDEO_BYTES),
        new Kind(List.of("mov"), "video/quicktime", "QuickTime video", new byte[][] {FTYP, b('m', 'o', 'o', 'v'), b('m', 'd', 'a', 't'), b('w', 'i', 'd', 'e'), b('f', 'r', 'e', 'e')}, false, 4, MAX_VIDEO_BYTES),
        new Kind(List.of("3gp"), "video/3gpp", "3GP video", new byte[][] {FTYP}, false, 4, MAX_VIDEO_BYTES),
        new Kind(List.of("webm"), "video/webm", "WebM video", new byte[][] {b(0x1a, 0x45, 0xdf, 0xa3)}, false, 0, MAX_VIDEO_BYTES));
    static final String EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    static final Pattern PDF_ACTIVE = Pattern.compile("/(JavaScript|JS|Launch|EmbeddedFile|OpenAction)\\b");

    /** A checked upload: its clean name and the type the server worked out. */
    public record Checked(String fileName, String mime, boolean image) {}

    public static Checked check(String fileName, byte[] bytes) {
        String name = cleanName(fileName);
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        Kind k = KINDS.stream().filter((x) -> x.ext().contains(ext)).findFirst()
            .orElseThrow(() -> new DomainException.RuleViolated("type-not-allowed", "." + (ext.isEmpty() ? "?" : ext) + " files are not allowed. Allowed: images, videos (MP4, MOV, WebM, 3GP), PDF, Word, Excel, PowerPoint, RTF, text / CSV"));
        rule(bytes != null && bytes.length > 0, "empty", "The file is empty");
        rule(bytes.length <= k.max(), "too-large", (k.video() ? "A video" : "A file") + " may be up to " + (k.max() / 1024 / 1024) + " MB");
        if (k.magic() != null) {
            boolean match = false;
            for (byte[] sig : k.magic()) match |= startsWith(bytes, sig, k.at());
            rule(match, "not-what-it-says", "The content is not a real " + k.label() + " (its signature does not match)");
            if ("webp".equals(ext)) rule(bytes.length > 12 && new String(bytes, 8, 4, StandardCharsets.ISO_8859_1).equals("WEBP"), "not-what-it-says", "The content is not a real WebP image");
        }
        if (k.text()) for (int i = 0; i < Math.min(bytes.length, 8192); i++) rule(bytes[i] != 0, "binary-in-text", "Binary data in a text file");
        String text = new String(bytes, StandardCharsets.ISO_8859_1);
        if (text.contains(EICAR)) throw new DomainException.RuleViolated("infected", "Malware signature found (EICAR test virus) - the file was not stored");
        if ("pdf".equals(ext)) rule(!PDF_ACTIVE.matcher(text).find(), "active-content", "The PDF contains active content (scripts, launch actions or embedded files)");
        if (List.of("docx", "xlsx", "pptx").contains(ext)) rule(!text.contains("vbaProject.bin"), "macros", "The file contains macros");
        if (List.of("doc", "xls", "ppt").contains(ext)) rule(!text.contains("_VBA_PROJECT") && !text.contains("Macros\u0000"), "macros", "The file contains macros");
        return new Checked(name, k.mime(), k.mime().startsWith("image/"));
    }
    /** Only the last part of a path, no control characters, at most 255 characters (the extension kept). */
    public static String cleanName(String fileName) {
        String n = fileName == null ? "" : fileName.replace('\\', '/');
        n = n.substring(n.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}\"<>|:*?]", "").strip();
        rule(!n.isEmpty() && !n.equals(".") && !n.equals(".."), "name-required", "The file needs a name");
        if (n.length() > 255) { int dot = n.lastIndexOf('.'); String ext = dot > 0 && n.length() - dot <= 10 ? n.substring(dot) : ""; n = n.substring(0, 255 - ext.length()) + ext; }
        return n;
    }
    static boolean startsWith(byte[] bytes, byte[] sig) { return startsWith(bytes, sig, 0); }
    static boolean startsWith(byte[] bytes, byte[] sig, int at) {
        if (bytes.length < at + sig.length) return false;
        for (int i = 0; i < sig.length; i++) if (bytes[at + i] != sig[i]) return false;
        return true;
    }
    static void rule(boolean ok, String code, String message) { if (!ok) throw new DomainException.RuleViolated(code, message); }
}

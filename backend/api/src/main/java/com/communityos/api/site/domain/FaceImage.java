package com.communityos.api.site.domain;

import com.communityos.api.shared.crypto.Crypto;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.HexFormat;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;

/**
 * The face a terminal gets: the stored photo (a JPEG or PNG data URL) as a plain JPEG, longest side 640 px, under 190 KB (Hikvision takes up to
 * 200 KB). A drawn avatar (SVG) or anything that does not decode is not a face: null.
 */
public final class FaceImage {
    private FaceImage() {}
    public static final int MAX_SIDE = 640, MAX_BYTES = 190_000, MIN_SIDE = 60;

    public static String forDevice(String photo) {
        byte[] raw = bytes(photo);
        if (raw == null) return null;
        BufferedImage img;
        try { img = ImageIO.read(new ByteArrayInputStream(raw)); } catch (IOException | RuntimeException e) { return null; }
        if (img == null || img.getWidth() < MIN_SIDE || img.getHeight() < MIN_SIDE) return null;
        double k = Math.min(1.0, (double) MAX_SIDE / Math.max(img.getWidth(), img.getHeight()));
        int w = Math.max(1, (int) Math.round(img.getWidth() * k)), h = Math.max(1, (int) Math.round(img.getHeight() * k));
        BufferedImage rgb = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = rgb.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setColor(Color.WHITE); g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h, null); g.dispose();
        for (float q : new float[] {0.85f, 0.7f, 0.55f, 0.4f}) {
            byte[] out = jpeg(rgb, q);
            if (out != null && out.length <= MAX_BYTES) return Base64.getEncoder().encodeToString(out);
        }
        return null;
    }
    /** A short fingerprint of the stored photo: a new photo means the devices need it again. */
    public static String hash(String photo) { return photo == null ? null : HexFormat.of().formatHex(Crypto.sha256(photo), 0, 12); }

    /** The photo's bytes, if it is a JPEG or PNG (as a data URL or bare base64). */
    public static byte[] bytes(String photo) {
        if (photo == null || photo.isBlank()) return null;
        String b64 = photo.strip();
        if (b64.startsWith("data:")) {
            int comma = b64.indexOf(',');
            if (comma < 0) return null;
            String head = b64.substring(5, comma).toLowerCase();
            if (!head.endsWith(";base64") || !(head.startsWith("image/jpeg") || head.startsWith("image/jpg") || head.startsWith("image/png"))) return null;
            b64 = b64.substring(comma + 1);
        }
        try { return Base64.getMimeDecoder().decode(b64); } catch (IllegalArgumentException e) { return null; }
    }
    static byte[] jpeg(BufferedImage img, float quality) {
        ImageWriter w = ImageIO.getImageWritersByFormatName("jpeg").next();
        try (ByteArrayOutputStream bytes = new ByteArrayOutputStream(); MemoryCacheImageOutputStream out = new MemoryCacheImageOutputStream(bytes)) {
            ImageWriteParam p = w.getDefaultWriteParam(); p.setCompressionMode(ImageWriteParam.MODE_EXPLICIT); p.setCompressionQuality(quality);
            w.setOutput(out); w.write(null, new IIOImage(img, null, null), p); out.flush();
            return bytes.toByteArray();
        } catch (IOException e) { return null; } finally { w.dispose(); }
    }
}

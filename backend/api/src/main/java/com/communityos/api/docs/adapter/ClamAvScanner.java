package com.communityos.api.docs.adapter;

import com.communityos.api.docs.application.port.VirusScanner;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * ClamAV (free, open source) through its daemon, clamd, over TCP: the INSTREAM command sends the bytes in chunks and clamd answers
 * "stream: OK" or "stream: <signature> FOUND". Nothing is written to disk on either side. When clamd cannot be reached or does not answer
 * in time the verdict is UNAVAILABLE: the file stays Pending (not served to others) and the rescan job tries again.
 * Run it next to the API (docker image clamav/clamav, port 3310); its signatures update themselves (freshclam).
 */
public final class ClamAvScanner implements VirusScanner {
    private static final Logger log = LoggerFactory.getLogger(ClamAvScanner.class);
    static final int CHUNK = 64 * 1024;
    private final String host; private final int port; private final Duration timeout;
    public ClamAvScanner(String host, int port, Duration timeout) { this.host = host; this.port = port; this.timeout = timeout; }

    @Override public Verdict scan(byte[] bytes) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), (int) Math.min(5000, timeout.toMillis()));
            s.setSoTimeout((int) timeout.toMillis());
            DataOutputStream out = new DataOutputStream(s.getOutputStream());
            out.write("zINSTREAM\0".getBytes(StandardCharsets.US_ASCII));
            for (int at = 0; at < bytes.length; at += CHUNK) { int n = Math.min(CHUNK, bytes.length - at); out.writeInt(n); out.write(bytes, at, n); }
            out.writeInt(0);
            out.flush();
            return verdict(read(s.getInputStream()));
        } catch (IOException e) {
            log.warn("virus scanner not reachable at {}:{} - file kept as Pending: {}", host, port, e.toString());
            return new Verdict(Result.UNAVAILABLE, null);
        }
    }
    /** clamd's answer: "stream: OK", "stream: Win.Test.EICAR_HDB-1 FOUND", or an error ("... ERROR", e.g. the size limit). */
    static Verdict verdict(String reply) {
        String r = reply == null ? "" : reply.strip();
        if (r.endsWith("FOUND")) { String sig = r.substring(r.indexOf(':') + 1, r.length() - "FOUND".length()).strip(); return new Verdict(Result.INFECTED, sig.isEmpty() ? "a virus" : sig); }
        if (r.endsWith("OK")) return new Verdict(Result.CLEAN, null);
        log.warn("virus scanner answered {} - file kept as Pending", r);
        return new Verdict(Result.UNAVAILABLE, null);
    }
    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) > 0 && b.size() < 1024; ) b.write(c);      // the answer ends with \0
        return b.toString(StandardCharsets.US_ASCII);
    }
}

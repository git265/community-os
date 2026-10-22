package com.communityos.api.docs;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.docs.adapter.ClamAvScanner;
import com.communityos.api.docs.application.port.VirusScanner;
import java.io.DataInputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/** The clamd INSTREAM conversation against a stand-in daemon: chunks in, a verdict back; no daemon is "not scanned", never "clean". */
class ClamAvTest {
    /** A one-connection clamd: reads zINSTREAM and the chunks, answers FOUND when the bytes hold the word VIRUS. */
    static int fakeClamd(ServerSocket server) {
        Thread t = new Thread(() -> {
            try (Socket s = server.accept()) {
                DataInputStream in = new DataInputStream(s.getInputStream());
                byte[] cmd = new byte[10]; in.readFully(cmd);
                StringBuilder all = new StringBuilder();
                for (int n; (n = in.readInt()) > 0; ) { byte[] b = new byte[n]; in.readFully(b); all.append(new String(b, StandardCharsets.ISO_8859_1)); }
                String reply = !"zINSTREAM\0".equals(new String(cmd, StandardCharsets.US_ASCII)) ? "UNKNOWN COMMAND" : all.indexOf("VIRUS") >= 0 ? "stream: Test.Virus FOUND" : "stream: OK";
                s.getOutputStream().write((reply + "\0").getBytes(StandardCharsets.US_ASCII));
            } catch (Exception e) { /* the test reports it */ }
        });
        t.setDaemon(true); t.start();
        return server.getLocalPort();
    }
    @Test void scans() throws Exception {
        try (ServerSocket s1 = new ServerSocket(0)) {
            byte[] big = new byte[200_000]; java.util.Arrays.fill(big, (byte) 'a');   // more than one chunk
            assertEquals(VirusScanner.Result.CLEAN, new ClamAvScanner("127.0.0.1", fakeClamd(s1), Duration.ofSeconds(5)).scan(big).result());
        }
        try (ServerSocket s2 = new ServerSocket(0)) {
            VirusScanner.Verdict v = new ClamAvScanner("127.0.0.1", fakeClamd(s2), Duration.ofSeconds(5)).scan("xx VIRUS xx".getBytes());
            assertEquals(VirusScanner.Result.INFECTED, v.result()); assertEquals("Test.Virus", v.signature());
        }
        int closed; try (ServerSocket s3 = new ServerSocket(0)) { closed = s3.getLocalPort(); }
        assertEquals(VirusScanner.Result.UNAVAILABLE, new ClamAvScanner("127.0.0.1", closed, Duration.ofSeconds(2)).scan(new byte[]{1}).result(), "no daemon: not scanned, kept Pending");
    }
}

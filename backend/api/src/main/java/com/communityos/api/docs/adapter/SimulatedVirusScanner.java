package com.communityos.api.docs.adapter;

import com.communityos.api.docs.application.port.VirusScanner;
import java.nio.charset.StandardCharsets;

/**
 * Development only (cos.files.scanner=simulated, refused in prod): stands in for ClamAV. It finds the EICAR antivirus test file (so the
 * "infected" path can be tried end to end) and calls everything else clean. A real scanner adapter replaces it in production.
 */
public final class SimulatedVirusScanner implements VirusScanner {
    static final String EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    @Override public Verdict scan(byte[] bytes) {
        String s = new String(bytes, StandardCharsets.ISO_8859_1);
        return s.contains(EICAR) ? new Verdict(Result.INFECTED, "EICAR-Test-File (simulated scanner)") : new Verdict(Result.CLEAN, null);
    }
}

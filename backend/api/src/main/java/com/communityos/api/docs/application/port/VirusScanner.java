package com.communityos.api.docs.application.port;

/** An antivirus engine (ClamAV ...). Without one, files pass the server's own checks and stay "Pending" (not scanned). */
public interface VirusScanner {
    enum Result { CLEAN, INFECTED, UNAVAILABLE }
    record Verdict(Result result, String signature) {}
    Verdict scan(byte[] bytes);
    VirusScanner NONE = (b) -> new Verdict(Result.UNAVAILABLE, null);
}

package com.communityos.evoting;

/**
 * The memory of the second factor: the code that was sent, the proof it earned, and the one ballot-box write a roll mark allows.
 * In the JavaScript these are three Maps in the server process; here they survive a restart (table evoting_state).
 */
public interface EVotingState {
    record Challenge(String salt, String hash, long exp, int tries, long sentAt) {}

    Challenge challenge(String tenant, String key, boolean forUpdate);
    void saveChallenge(String tenant, String key, Challenge c);
    void deleteChallenge(String tenant, String key);

    void saveProof(String tenant, String token, String key, long exp);
    /** Takes the proof OUT (a proof is single use, valid or not). @return the key it was issued for and its expiry, or null when there is no such proof */
    ProofHit takeProof(String tenant, String token);
    record ProofHit(String key, long exp) {}

    void grantAllowance(String tenant, String key);
    boolean hasAllowance(String tenant, String key);
    void clearAllowance(String tenant, String key);
}

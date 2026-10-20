package com.communityos.evoting;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** No database (unit tests, profile `memory`): the three Maps of the JavaScript. */
public class InMemoryEVotingState implements EVotingState {
    private final Map<String, Challenge> challenges = new HashMap<>();
    private final Map<String, ProofHit> proofs = new HashMap<>();
    private final Set<String> allowance = new HashSet<>();

    private static String k(String tenant, String key) { return tenant + "\u0000" + key; }

    @Override public synchronized Challenge challenge(String t, String key, boolean forUpdate) { return challenges.get(k(t, key)); }
    @Override public synchronized void saveChallenge(String t, String key, Challenge c) { challenges.put(k(t, key), c); }
    @Override public synchronized void deleteChallenge(String t, String key) { challenges.remove(k(t, key)); }
    @Override public synchronized void saveProof(String t, String token, String key, long exp) { proofs.put(k(t, token), new ProofHit(key, exp)); }
    @Override public synchronized ProofHit takeProof(String t, String token) { return token == null ? null : proofs.remove(k(t, token)); }
    @Override public synchronized void grantAllowance(String t, String key) { allowance.add(k(t, key)); }
    @Override public synchronized boolean hasAllowance(String t, String key) { return allowance.contains(k(t, key)); }
    @Override public synchronized void clearAllowance(String t, String key) { allowance.remove(k(t, key)); }
}

package com.communityos.evoting;

import com.communityos.service.Tx;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * PostgreSQL (table evoting_state, backend/db/V6). Proofs are stored as the SHA-256 of the token, so a copy of the table cannot be used to vote.
 * Taking a proof is its OWN transaction and one DELETE ... RETURNING: a proof is used up even when the vote that presented it is then refused
 * (the JavaScript deletes it first), and two requests can never both use it.
 */
public class JdbcEVotingState implements EVotingState {
    private final JdbcTemplate jdbc;
    private final Tx tx;

    public JdbcEVotingState(JdbcTemplate jdbc, Tx tx) { this.jdbc = jdbc; this.tx = tx; }

    @Override public Challenge challenge(String t, String key, boolean forUpdate) {
        List<Challenge> r = jdbc.query("SELECT salt, hash, exp, tries, sent_at FROM evoting_state WHERE tenant=? AND kind='challenge' AND k=?" + (forUpdate ? " FOR UPDATE" : ""),
                (rs, i) -> new Challenge(rs.getString("salt"), rs.getString("hash"), rs.getLong("exp"), rs.getInt("tries"), rs.getLong("sent_at")), t, key);
        return r.isEmpty() ? null : r.get(0);
    }

    @Override public void saveChallenge(String t, String key, Challenge c) {
        jdbc.update("INSERT INTO evoting_state (tenant, kind, k, salt, hash, exp, tries, sent_at) VALUES (?, 'challenge', ?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (tenant, kind, k) DO UPDATE SET salt=EXCLUDED.salt, hash=EXCLUDED.hash, exp=EXCLUDED.exp, tries=EXCLUDED.tries, sent_at=EXCLUDED.sent_at",
                t, key, c.salt(), c.hash(), c.exp(), c.tries(), c.sentAt());
        jdbc.update("DELETE FROM evoting_state WHERE exp > 0 AND exp < ?", c.sentAt() - 3_600_000L);   // tidy up what expired an hour ago
    }

    @Override public void deleteChallenge(String t, String key) { jdbc.update("DELETE FROM evoting_state WHERE tenant=? AND kind='challenge' AND k=?", t, key); }

    @Override public void saveProof(String t, String token, String key, long exp) {
        jdbc.update("INSERT INTO evoting_state (tenant, kind, k, hash, exp) VALUES (?, 'proof', ?, ?, ?) ON CONFLICT (tenant, kind, k) DO UPDATE SET hash=EXCLUDED.hash, exp=EXCLUDED.exp",
                t, EVotingRules.sha256Hex(token), key, exp);
    }

    @Override public ProofHit takeProof(String t, String token) {
        if (token == null) return null;
        List<ProofHit> r = tx.runIndependent(() -> jdbc.query("DELETE FROM evoting_state WHERE tenant=? AND kind='proof' AND k=? RETURNING hash, exp",
                (rs, i) -> new ProofHit(rs.getString("hash"), rs.getLong("exp")), t, EVotingRules.sha256Hex(token)));
        return r.isEmpty() ? null : r.get(0);
    }

    @Override public void grantAllowance(String t, String key) {
        jdbc.update("INSERT INTO evoting_state (tenant, kind, k) VALUES (?, 'allowance', ?) ON CONFLICT DO NOTHING", t, key);
    }

    @Override public boolean hasAllowance(String t, String key) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM evoting_state WHERE tenant=? AND kind='allowance' AND k=?)", Boolean.class, t, key));
    }

    @Override public void clearAllowance(String t, String key) { jdbc.update("DELETE FROM evoting_state WHERE tenant=? AND kind='allowance' AND k=?", t, key); }
}

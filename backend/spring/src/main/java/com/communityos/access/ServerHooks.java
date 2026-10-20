package com.communityos.access;

import com.communityos.config.AppProperties;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The switch for writes the Node server checks and this server cannot. Today nothing is left on it: the money caps on releases, payments, invoices and
 * task approvals, one poll answer per villa, amenity booking prices, refunds and deposits, and e-voting (eligibility, the second factor, immutability,
 * the sealed hash-chained box) are all ported (MoneyGuard / PollRules / AmenityRules / EVotingGuard, run by SecureRecordService). The mechanism stays so
 * that the next Node-only check can be put behind it: with app.security.unported-hooks=refuse a write to a guarded collection is REFUSED with a plain
 * message; `allow` lets it through without the check (logged as a warning each time). docs/BACKEND.md section 10.
 */
@Component
public class ServerHooks {
    private static final Logger log = LoggerFactory.getLogger(ServerHooks.class);

    /** Collections where the Node server's extra checks protect money or votes. */
    static final Set<String> GUARDED = Set.of();
    /** Collections where the check only normalises data or sends messages: not blocked, but named in the log. Empty since round 76 (property and meeting
     *  hooks: com.communityos.people; ticket, approval and invoice messages: com.communityos.notify). */
    static final Set<String> CONVENIENCE = Set.of();

    private final boolean allow;
    private final Set<String> guarded;

    @org.springframework.beans.factory.annotation.Autowired
    public ServerHooks(AppProperties props) { this(props, GUARDED); }

    /** The collections to guard are a parameter so the switch itself stays tested while nothing is left to guard. */
    public ServerHooks(AppProperties props, Set<String> guarded) { this.allow = "allow".equals(props.security().unportedHooks()); this.guarded = Set.copyOf(guarded); }

    /** @return the reason to refuse this write, or null when it may go on */
    public String refusal(String collection, JsonNode old, JsonNode next) {
        if (guarded.contains(collection)) {
            if (allow) { log.warn("unported-hooks=allow: {} write goes ahead without the Node server's extra checks", collection); return null; }
            return "This change is checked by rules (" + what(collection) + ") that are not available on this server yet. Ask your administrator.";
        }
        if (CONVENIENCE.contains(collection)) log.debug("{} write: notifications / normalisation that the Node server performs are not run here", collection);
        return null;
    }

    private static String what(String collection) {
        return "extra server-side checks";
    }

    public List<String> guardedCollectionNames() { return guarded.stream().sorted().toList(); }
    public static List<String> guardedCollections() { return GUARDED.stream().sorted().toList(); }
}

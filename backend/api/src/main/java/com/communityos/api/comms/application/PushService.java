package com.communityos.api.comms.application;

import com.communityos.api.comms.application.port.PushSender;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import java.util.HashMap;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** A member's push subscriptions (one per browser / device): the app registers one after the person allows notifications, and removes it at sign-out. */
public final class PushService {
    static final String SUBSCRIBE = """
        INSERT INTO comms.push_subscription (community_id, membership_id, endpoint, p256dh, auth, user_agent)
        VALUES (platform.current_community(), platform.current_actor(), :endpoint, :p256dh, :auth, :ua)
        ON CONFLICT (community_id, endpoint) DO UPDATE SET membership_id = EXCLUDED.membership_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent""";
    static final String UNSUBSCRIBE = "DELETE FROM comms.push_subscription WHERE endpoint = :endpoint AND membership_id = platform.current_actor()";
    static final String MINE = "SELECT count(*) FROM comms.push_subscription WHERE membership_id = platform.current_actor()";
    public record Key(String publicKey, String provider) {}

    private final NamedParameterJdbcTemplate jdbc; private final PushSender sender;
    public PushService(NamedParameterJdbcTemplate jdbc, PushSender sender) { this.jdbc = jdbc; this.sender = sender; }

    /** What the browser needs to subscribe (null key: this server sends no Web Push). */
    public Key key() { return new Key(sender == null ? null : sender.publicKey(), sender == null ? "none" : sender.name()); }

    public void subscribe(Caller c, String endpoint, String p256dh, String auth, String userAgent) {
        if (c.membership() == null || c.category() == Caller.Category.System) throw new AccessDenied("Sign in to get notifications on this device");
        if (endpoint == null || !endpoint.startsWith("https://") || endpoint.length() > 1000) throw new DomainException.RuleViolated("bad-endpoint", "That is not a push subscription");
        if (p256dh == null || !p256dh.matches("[A-Za-z0-9_-]{80,100}") || auth == null || !auth.matches("[A-Za-z0-9_-]{16,32}"))
            throw new DomainException.RuleViolated("bad-keys", "The subscription's keys are not valid");
        Map<String, Object> p = new HashMap<>(); p.put("endpoint", endpoint); p.put("p256dh", p256dh); p.put("auth", auth);
        p.put("ua", userAgent == null ? null : userAgent.length() > 300 ? userAgent.substring(0, 300) : userAgent);
        jdbc.update(SUBSCRIBE, p);
    }
    public void unsubscribe(Caller c, String endpoint) { if (c.membership() != null && endpoint != null) jdbc.update(UNSUBSCRIBE, Map.of("endpoint", endpoint)); }
    public long devices(Caller c) { return c.membership() == null ? 0 : jdbc.queryForObject(MINE, Map.of(), Long.class); }
}

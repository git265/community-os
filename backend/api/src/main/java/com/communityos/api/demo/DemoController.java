package com.communityos.api.demo;

import com.communityos.api.identity.application.AuthService;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.CallerLoader;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Development and demos only (exists only with cos.demo.enabled, which the prod profile refuses): load the La Paloma demo into a community,
 * list who can be shown, and sign in as one of them without a code. Nothing here is reachable in a production deployment.
 */
@RestController
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(name = "cos.demo.enabled", havingValue = "true")
@Tag(name = "Demo (development only)")
public class DemoController {
    public record Role(String id, String name, String category) {}
    public record UnitOwner(String unit, String owner) {}
    public record Person(UUID id, String name, String roleId, List<String> extraRoleIds, List<String> units, String unit, String status) {}
    public record Roster(List<Role> roles, List<UnitOwner> units, List<Person> people) {}
    public record SignInRequest(@NotNull UUID communityId, UUID membershipId, @Size(max = 60) String roleCode, @Size(max = 40) String unit, String client) {}

    static final String COMMUNITY = "SELECT id FROM platform.community WHERE slug = :slug";
    static final String SUPER_ADMIN = """
        SELECT m.id, m.person_id FROM identity.membership m JOIN identity.membership_role mr ON mr.community_id = m.community_id AND mr.membership_id = m.id
        JOIN identity.role r ON r.community_id = m.community_id AND r.id = mr.role_id
        WHERE m.community_id = CAST(:c AS uuid) AND m.status = 'Active' AND r.code = 'super_admin' ORDER BY m.created_at LIMIT 1""";
    static final String ROLES = """
        SELECT r.code, r.name, g.category FROM identity.role r JOIN identity.role_group g ON g.community_id = r.community_id AND g.id = r.group_id
        WHERE r.community_id = CAST(:c AS uuid) ORDER BY g.category, r.name""";
    static final String UNITS = """
        SELECT u.unit_no, (SELECT o.full_name FROM property.occupant o WHERE o.community_id = u.community_id AND o.unit_id = u.id AND o.relation IN ('Owner', 'Co-owner') AND o.to_date IS NULL
                           ORDER BY o.is_primary DESC LIMIT 1) AS owner
        FROM property.unit u WHERE u.community_id = CAST(:c AS uuid) AND u.status = 'Active' ORDER BY length(u.unit_no), u.unit_no""";
    static final String PEOPLE = """
        SELECT m.id, m.person_id, m.display_name,
               (SELECT r.code FROM identity.membership_role mr JOIN identity.role r ON r.id = mr.role_id WHERE mr.community_id = m.community_id AND mr.membership_id = m.id ORDER BY mr.is_primary DESC LIMIT 1) AS role,
               (SELECT string_agg(r.code, ',') FROM identity.membership_role mr JOIN identity.role r ON r.id = mr.role_id WHERE mr.community_id = m.community_id AND mr.membership_id = m.id AND NOT mr.is_primary) AS extra,
               (SELECT string_agg(u.unit_no, ',' ORDER BY u.unit_no) FROM property.occupant o JOIN property.unit u ON u.community_id = o.community_id AND u.id = o.unit_id
                 WHERE o.community_id = m.community_id AND o.person_id = m.person_id AND o.to_date IS NULL) AS units
        FROM identity.membership m WHERE m.community_id = CAST(:c AS uuid) AND m.status = 'Active' ORDER BY m.display_name LIMIT 500""";

    private final NamedParameterJdbcTemplate platform; private final CallerLoader callers; private final DemoData demo; private final AuthService auth;
    public DemoController(@org.springframework.beans.factory.annotation.Qualifier("platform") NamedParameterJdbcTemplate platform, CallerLoader callers, DemoData demo, AuthService auth) { this.platform = platform; this.callers = callers; this.demo = demo; this.auth = auth; }

    UUID community(String slug) { return platform.query(COMMUNITY, Map.of("slug", slug), (rs, i) -> rs.getObject("id", UUID.class)).stream().findFirst().orElseThrow(() -> new DomainException.NotFound("Community")); }

    /** Load the demo into the community (as its first Super Admin); a second call says it is already there. */
    @PostMapping("/api/v1/demo/load/{slug}")
    public DemoData.Result load(@PathVariable String slug) {
        UUID c = community(slug);
        UUID[] admin = platform.query(SUPER_ADMIN, Map.of("c", c.toString()), (rs, i) -> new UUID[] {rs.getObject("id", UUID.class), rs.getObject("person_id", UUID.class)}).stream().findFirst()
            .orElseThrow(() -> new DomainException.RuleViolated("no-admin", "The community has no Super Admin to load the demo as - run the seed first"));
        Caller caller = callers.load(new PersonId(admin[1]), new CommunityId(c), new MembershipId(admin[0])).orElseThrow();
        return demo.load(new CommunityId(c), caller);
    }

    @GetMapping("/api/v1/demo/roster/{slug}")
    public Roster roster(@PathVariable String slug) {
        Map<String, Object> p = Map.of("c", community(slug).toString());
        return new Roster(platform.query(ROLES, p, (rs, i) -> new Role(rs.getString("code"), rs.getString("name"), rs.getString("category"))),
            platform.query(UNITS, p, (rs, i) -> new UnitOwner(rs.getString("unit_no"), rs.getString("owner") == null ? "-" : rs.getString("owner"))),
            platform.query(PEOPLE, p, (rs, i) -> {
                List<String> units = split(rs.getString("units"));
                return new Person(rs.getObject("id", UUID.class), rs.getString("display_name"), rs.getString("role"), split(rs.getString("extra")), units, units.isEmpty() ? null : units.get(0), "Active");
            }));
    }

    /** Sign in as a member of the roster (by id), or as the first member with a role (and unit). Tokens as from a real sign-in. */
    @PostMapping("/api/v1/demo/sign-in")
    public ResponseEntity<Map<String, Object>> signIn(@Valid @RequestBody SignInRequest b, HttpServletRequest req) {
        Map<String, Object> p = Map.of("c", b.communityId().toString());
        record Row(UUID id, UUID person, String role, List<String> extra, List<String> units) {}
        Row who = platform.query(PEOPLE, p, (rs, i) -> new Row(rs.getObject("id", UUID.class), rs.getObject("person_id", UUID.class), rs.getString("role"), split(rs.getString("extra")),
            split(rs.getString("units")))).stream().filter((x) -> b.membershipId() != null ? x.id().equals(b.membershipId())
            : (b.roleCode() != null && (b.roleCode().equals(x.role()) || x.extra().contains(b.roleCode())) && (b.unit() == null || b.unit().isBlank() || x.units().contains(b.unit()))))
            .findFirst().orElseThrow(() -> new DomainException.NotFound("A member like that"));
        AuthService.Tokens t = auth.demoSignIn(new PersonId(who.person()), new CommunityId(b.communityId()), new MembershipId(who.id()),
            new AuthService.Client(req.getHeader("User-Agent"), req.getRemoteAddr()));
        boolean mobile = "mobile".equals(b.client());
        ResponseEntity.BodyBuilder out = ResponseEntity.ok().header("Cache-Control", "no-store");
        if (!mobile) out = out.header("Set-Cookie", ResponseCookie.from("cos_refresh", t.refreshToken()).httpOnly(true).secure(true).sameSite("Strict").path("/api/v1/auth")
            .maxAge(Duration.between(Instant.now(), t.refreshExpiresAt())).build().toString());
        return out.body(Map.of("status", "signed-in", "accessToken", t.accessToken(), "expiresAt", t.accessExpiresAt().toString()));
    }
    static List<String> split(String s) { return s == null || s.isBlank() ? List.of() : List.of(s.split(",")); }
}

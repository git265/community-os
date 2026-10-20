package com.communityos.security;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;

/**
 * The per-request settings the rules need besides the principal: community-configurable data (who gives the final approval, custom document
 * groups, utility names) and the clock. Immutable; a request builds one from the community's rows ({@link RuleContextLoader}).
 * In the Node server the same values are module globals refreshed before each write; here nothing is shared between requests.
 */
public record RuleContext(List<String> secondStepRoles, boolean finalCanDecideEC, Set<String> utilityNames, List<DocGroup> customDocGroups,
                          Clock clock, Constants constants) {

    public static final List<String> DEFAULT_SECOND_STEP = List.of("treasurer", "president");

    /** A community-defined document group: who it is for. */
    public record DocGroup(String name, List<String> roles) {}

    public RuleContext {
        secondStepRoles = secondStepRoles == null || secondStepRoles.isEmpty() ? DEFAULT_SECOND_STEP : List.copyOf(secondStepRoles);
        utilityNames = utilityNames == null ? Set.of() : Set.copyOf(utilityNames);
        customDocGroups = customDocGroups == null ? List.of() : List.copyOf(customDocGroups);
        clock = clock == null ? Clock.systemUTC() : clock;
    }

    public static RuleContext defaults(Constants constants) {
        return new RuleContext(DEFAULT_SECOND_STEP, true, Set.copyOf(constants.utilityTypes()), List.of(), Clock.systemUTC(), constants);
    }

    public RuleContext withApprovers(List<String> second, boolean finalCanDecideEC) { return new RuleContext(second, finalCanDecideEC, utilityNames, customDocGroups, clock, constants); }
    public RuleContext withClock(Clock c) { return new RuleContext(secondStepRoles, finalCanDecideEC, utilityNames, customDocGroups, c, constants); }
    public RuleContext withUtilityNames(Set<String> names) { return new RuleContext(secondStepRoles, finalCanDecideEC, names, customDocGroups, clock, constants); }
    public RuleContext withDocGroups(List<DocGroup> g) { return new RuleContext(secondStepRoles, finalCanDecideEC, utilityNames, g, clock, constants); }

    /** Today as yyyy-mm-dd (UTC, like `new Date().toISOString().slice(0, 10)`). */
    public String today() { return LocalDate.now(clock.withZone(ZoneOffset.UTC)).toString(); }
}

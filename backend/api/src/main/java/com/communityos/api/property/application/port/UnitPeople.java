package com.communityos.api.property.application.port;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * The people of a unit over time (property.occupant) and what follows from someone coming or going: their membership, the unit's gate
 * access, and the unit's history (property.unit_change). Nothing here deletes a row: a person who leaves gets the day they left.
 */
public interface UnitPeople {
    /** One person on a unit. current = no to_date. memberStatus: their membership here (null when they have none). */
    record Person(UUID occupantId, UUID personId, UUID membershipId, String name, String phone, String email, String relation, boolean primary,
                  boolean portalAccess, LocalDate from, LocalDate to, String memberStatus) {
        public boolean current() { return to == null; }
        public boolean owner() { return "Owner".equals(relation) || "Co-owner".equals(relation); }
    }
    /** The unit's people, current first (with withPast, those who left too, latest first). */
    List<Person> people(UUID unit, boolean withPast);

    UUID addOccupant(UUID unit, UUID person, String relation, String name, String phone, String email, boolean primary, LocalDate from);
    /** The same person, new details (name, e-mail, relation, primary owner or not). */
    void updateOccupant(UUID occupantId, String name, String email, String relation, boolean primary);
    /** Ends current rows (to_date = on); returns how many. */
    int endOccupants(List<UUID> occupantIds, LocalDate on);

    /** A person's membership in this community. */
    record Membership(UUID id, String status, long version, Set<String> roleCodes) {}
    Optional<Membership> membership(UUID person);
    UUID addMembership(UUID person, String displayName);
    void setMemberStatus(UUID membership, String status);
    /** Gives the role (by code) when the member has no role at all yet. */
    void giveRoleIfNone(UUID membership, String roleCode);
    /** Does the person live in or own another unit here (a current row elsewhere)? */
    boolean hasOtherHome(UUID person, UUID exceptUnit);

    /** What the gate stops when a household leaves: its household staff, its passes, its cars; and the unit's own gate rule goes back to the defaults. */
    record GateEnded(int links, int passes, int vehicles, boolean ruleReset) {}
    GateEnded endGateAccess(UUID unit);

    /** What stays open when people leave (warned about, kept): the unit's unpaid bills, their future bookings, the requests they raised. */
    record Leftovers(BigDecimal duesOutstanding, int unpaidBills, int futureBookings, int openTickets) {}
    Leftovers leftovers(UUID unit, List<UUID> leavingMemberships, LocalDate today);

    /** The unit's occupancy and who its bills go to (null: unchanged). false when the unit moved on meanwhile. */
    void setOccupancy(UUID unit, String occupancy, String billTo);

    /** A line of the unit's history. */
    record Change(UUID id, String shortId, UUID unitId, String kind, LocalDate on, List<Map<String, Object>> out, List<Map<String, Object>> in, String occupancyBefore,
                  String occupancyAfter, BigDecimal duesOutstanding, Map<String, Object> summary, String note, String by, Instant at) {}
    UUID recordChange(UUID unit, String kind, LocalDate on, List<Map<String, Object>> out, List<Map<String, Object>> in, String occupancyBefore, String occupancyAfter,
                      BigDecimal duesOutstanding, Map<String, Object> summary, String note);
    List<Change> changes(UUID unit);
}

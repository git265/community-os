package com.communityos.api.maintenance.application.port;

import com.communityos.api.shared.domain.Ids.MembershipId;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** The field staff register: members who work a trade's queue, their shift and whether they are clocked in. */
public interface FieldStaffRepository {
    record FieldStaff(UUID id, String shortId, MembershipId membership, String name, String trade, String shift, String phone, boolean clockedIn, long version) {}
    List<FieldStaff> all();
    Optional<FieldStaff> byId(UUID id);
    FieldStaff insert(MembershipId member, String name, String trade, String shift, String phone);
    boolean setClockedIn(UUID id, boolean in, long version);
}

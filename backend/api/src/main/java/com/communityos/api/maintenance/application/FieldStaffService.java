package com.communityos.api.maintenance.application;

import com.communityos.api.maintenance.application.port.FieldStaffRepository;
import com.communityos.api.maintenance.application.port.FieldStaffRepository.FieldStaff;
import com.communityos.api.maintenance.application.port.MaintenanceDirectory;
import com.communityos.api.maintenance.domain.Ticket;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.util.List;
import java.util.UUID;

/** Field staff register. Residents and vendors do not see it (it holds phone numbers); a member clocks themselves in and out. */
public final class FieldStaffService {
    private final FieldStaffRepository staff; private final MaintenanceDirectory directory; private final AuditWriter audit; private final Tx tx;
    public FieldStaffService(FieldStaffRepository staff, MaintenanceDirectory directory, AuditWriter audit, Tx tx) { this.staff = staff; this.directory = directory; this.audit = audit; this.tx = tx; }

    public List<FieldStaff> list(Caller c) { return TicketPolicy.canSeeInternal(c) ? staff.all() : List.of(); }

    public FieldStaff add(Caller c, MembershipId member, String trade, String shift, String phone) {
        if (!(c.isSuperAdmin() || c.has(Permission.MANAGE_FIELD_DUTIES))) throw new AccessDenied("You cannot manage field staff");
        if (!Ticket.CATEGORIES.contains(trade)) throw new DomainException.RuleViolated("bad-trade", "Pick a trade from the list");
        if (shift != null && !List.of("Morning", "Afternoon", "Night").contains(shift)) throw new DomainException.RuleViolated("bad-shift", "Morning, Afternoon or Night");
        String name = directory.memberName(member).orElseThrow(() -> new DomainException.RuleViolated("unknown-member", "Add the person as a member first"));
        return tx.inTx(() -> {
            FieldStaff f;
            try { f = staff.insert(member, name, trade, shift, phone == null || phone.isBlank() ? null : phone.strip()); }
            catch (org.springframework.dao.DuplicateKeyException e) { throw new DomainException.Conflict("This member is already field staff; they"); }
            audit.write(c, AuditWriter.Action.Create, "maintenance.field_staff", f.id(), f.shortId(), null, "Added " + name + " to field staff (" + trade + ")", List.of());
            return f;
        });
    }

    public FieldStaff clock(Caller c, UUID id, boolean in, long version) {
        FieldStaff f = staff.byId(id).filter((x) -> TicketPolicy.canSeeInternal(c)).orElseThrow(AccessDenied.NotVisible::new);
        boolean self = f.membership() != null && f.membership().equals(c.membership());
        if (!(self || c.isSuperAdmin() || c.has(Permission.MANAGE_FIELD_DUTIES))) throw new AccessDenied("You can only clock yourself in or out");
        return tx.inTx(() -> {
            if (!staff.setClockedIn(id, in, version)) throw new DomainException.Conflict(f.name() + "'s record");
            audit.write(c, AuditWriter.Action.Update, "maintenance.field_staff", f.id(), f.shortId(), null, f.name() + (in ? " clocked in" : " clocked out"),
                List.of(new AuditWriter.Change("clockedIn", String.valueOf(f.clockedIn()), String.valueOf(in))));
            return staff.byId(id).orElseThrow();
        });
    }
}

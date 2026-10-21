package com.communityos.api;

import com.communityos.api.billing.application.port.ChargeCategories;
import com.communityos.api.billing.application.port.DueRepository;
import com.communityos.api.billing.application.port.InboundEvents;
import com.communityos.api.billing.application.port.JournalWriter;
import com.communityos.api.billing.application.port.OrderLocator;
import com.communityos.api.billing.application.port.PaymentOrderRepository;
import com.communityos.api.billing.application.port.PaymentRepository;
import com.communityos.api.billing.application.port.UnitLookup;
import com.communityos.api.billing.domain.BillingEvents.Allocation;
import com.communityos.api.billing.domain.ChargeCategory;
import com.communityos.api.billing.domain.Due;
import com.communityos.api.billing.domain.Journal;
import com.communityos.api.billing.domain.PaymentOrder;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainEvent;
import com.communityos.api.shared.domain.Ids.BlockId;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.DueId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.OrderId;
import com.communityos.api.shared.domain.Ids.PaymentId;
import com.communityos.api.shared.domain.Ids.PersonId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.domain.Money;
import com.communityos.api.shared.events.DomainEventHandler;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.web.Page;
import com.communityos.api.shared.web.PageQuery;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** Test fixtures: callers, categories, and in-memory adapters that behave like the JDBC ones (versions, uniqueness, scope filtering). */
public final class Fixtures {
    private Fixtures() {}
    public static final CommunityId COMMUNITY = new CommunityId(UUID.fromString("00000000-0000-0000-0000-0000000000c1"));
    public static final UnitId UNIT_A = new UnitId(UUID.fromString("00000000-0000-0000-0000-0000000000a1"));
    public static final UnitId UNIT_B = new UnitId(UUID.fromString("00000000-0000-0000-0000-0000000000b1"));
    public static final BlockId BLOCK_1 = new BlockId(UUID.fromString("00000000-0000-0000-0000-000000000b01"));
    public static final BlockId BLOCK_2 = new BlockId(UUID.fromString("00000000-0000-0000-0000-000000000b02"));
    public static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-20T06:00:00Z"), ZoneId.of("Asia/Kolkata"));
    public static final ChargeCategory MAINTENANCE = new ChargeCategory(UUID.randomUUID(), "Maintenance", "Maintenance", false, new BigDecimal("18"), UUID.randomUUID(), true);
    public static final ChargeCategory WATER = new ChargeCategory(UUID.randomUUID(), "Water", "Water", true, BigDecimal.ZERO, UUID.randomUUID(), true);

    public static Caller caller(Caller.Category cat, Set<String> roles, Set<UnitId> units, Set<BlockId> blocks, Permission... perms) {
        Set<Permission> p = perms.length == 0 ? Set.of() : EnumSet.of(perms[0], perms);
        return new Caller(new PersonId(UUID.randomUUID()), new MembershipId(UUID.randomUUID()), COMMUNITY, "Test " + cat, cat, roles, p, units, blocks, null, Set.of());
    }
    public static Caller owner(UnitId... units) { return caller(Caller.Category.Resident, Set.of("owner"), Set.of(units), Set.of()); }
    public static Caller treasurer() { return caller(Caller.Category.EC, Set.of("treasurer"), Set.of(), Set.of(), Permission.MANAGE_DUES, Permission.MANAGE_LEDGER); }
    public static Caller utilityClerk() { return caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of(), Permission.MANAGE_UTILITY_BILLING); }
    public static Caller helpdesk() { return caller(Caller.Category.Staff, Set.of("helpdesk"), Set.of(), Set.of(), Permission.MANAGE_TICKETS); }
    public static Caller superAdmin() { return caller(Caller.Category.EC, Set.of("super_admin"), Set.of(), Set.of()); }

    public static Due due(UnitId unit, BlockId block, ChargeCategory cat, String amount, LocalDate dueDate) {
        Due d = Due.raise(COMMUNITY, unit, block, unit == UNIT_A ? "Villa 1" : "Villa 2", cat, LocalDate.of(2026, 10, 1), null, Money.of(amount), dueDate, CLOCK.instant());
        d.pullEvents();
        return d;
    }

    /** In-memory bills: applies the Spec's in-memory predicate exactly where the SQL would apply its WHERE clause. */
    public static final class Dues implements DueRepository, ChargeCategories, UnitLookup {
        public final Map<DueId, Due> rows = new LinkedHashMap<>();
        public final Map<UnitId, BlockId> units = new LinkedHashMap<>(Map.of(UNIT_A, BLOCK_1, UNIT_B, BLOCK_2));
        private int n;
        public Due add(Due d) { insert(d); return d; }
        @Override public Page<Due> find(Spec<Due> s, Filter f, PageQuery p) {
            List<Due> l = rows.values().stream().filter(s::matches).filter((d) -> f.unit() == null || f.unit().equals(d.unit())).toList();
            return new Page<>(l, l.size(), p.limit(), p.offset());
        }
        @Override public Optional<Due> findById(DueId id, Spec<Due> s) { return Optional.ofNullable(rows.get(id)).filter(s::matches); }
        @Override public List<Due> lockForSettlement(Collection<DueId> ids) {
            return ids.stream().map(rows::get).filter(java.util.Objects::nonNull).sorted(java.util.Comparator.comparing(Due::dueDate)).toList();
        }
        @Override public List<Due> lockOpenOfUnit(UnitId u) {
            return rows.values().stream().filter((d) -> u.equals(d.unit()) && d.status().isOpen()).sorted(java.util.Comparator.comparing(Due::dueDate)).toList();
        }
        @Override public void insert(Due d) { d.numbered(String.format("DUE-%04d", ++n)); d.stored(1); rows.put(d.id(), d); }
        @Override public boolean save(Due d) { d.stored(d.version() + 1); return true; }
        @Override public Optional<ChargeCategory> byCode(String code) { return List.of(MAINTENANCE, WATER).stream().filter((c) -> c.code().equals(code)).findFirst(); }
        @Override public Optional<UnitRef> find(UnitId id) { return Optional.ofNullable(units.get(id)).map((b) -> new UnitRef(id, b, id == UNIT_A ? "Villa 1" : "Villa 2", true)); }
    }

    public static final class Orders implements PaymentOrderRepository {
        public final Map<OrderId, PaymentOrder> rows = new LinkedHashMap<>();
        private int n;
        @Override public Optional<PaymentOrder> findById(OrderId id) { return Optional.ofNullable(rows.get(id)); }
        @Override public Optional<PaymentOrder> findForUpdate(OrderId id) { return findById(id); }
        @Override public Optional<PaymentOrder> findByIdempotencyKey(MembershipId payer, String key) {
            return rows.values().stream().filter((o) -> o.payer().equals(payer) && o.idempotencyKey().equals(key)).findFirst();
        }
        @Override public Optional<PaymentOrder> findByProviderRefForUpdate(String p, String ref) { return rows.values().stream().filter((o) -> ref.equals(o.providerOrderRef())).findFirst(); }
        @Override public void insert(PaymentOrder o) { o.numbered("ORD-" + (++n)); o.stored(1); rows.put(o.id(), o); }
        @Override public boolean save(PaymentOrder o) { o.stored(o.version() + 1); return true; }
    }

    public static final class Payments implements PaymentRepository {
        public final Map<PaymentId, Receipt> rows = new LinkedHashMap<>();
        public final Map<PaymentId, NewPayment> raw = new LinkedHashMap<>();
        public final List<Object[]> credits = new ArrayList<>();
        public boolean simulateRace;
        private int n;
        @Override public Optional<Receipt> findByProviderRef(String provider, String ref) {
            return raw.values().stream().filter((p) -> ref != null && ref.equals(p.providerRef()) && java.util.Objects.equals(provider, p.provider())).map((p) -> rows.get(p.id())).findFirst();
        }
        @Override public String insert(NewPayment p) {
            if (p.providerRef() != null && raw.values().stream().anyMatch((x) -> p.providerRef().equals(x.providerRef()))) throw new AlreadyRecorded();
            if (simulateRace) { simulateRace = false; PaymentId other = PaymentId.random(); raw.put(other, new NewPayment(other, p.order(), p.unit(), p.amount(), p.method(), p.provider(), p.providerRef(), p.receivedAt(), null));
                rows.put(other, new Receipt(other, "RCP-RACE", p.unit(), p.order(), p.amount(), p.method(), p.provider(), p.receivedAt(), List.of(), Money.ZERO)); throw new AlreadyRecorded(); }
            raw.put(p.id(), p);
            String no = String.format("RCP-%04d", ++n);
            rows.put(p.id(), new Receipt(p.id(), no, p.unit(), p.order(), p.amount(), p.method(), p.provider(), p.receivedAt(), List.of(), Money.ZERO));
            return no;
        }
        @Override public void allocate(PaymentId id, List<Allocation> a) { Receipt r = rows.get(id); rows.put(id, new Receipt(r.id(), r.receiptNo(), r.unit(), r.order(), r.amount(), r.method(), r.provider(), r.receivedAt(), a, r.toCredit())); }
        @Override public void creditUnit(UnitId unit, Money amount, PaymentId source, String reason) { credits.add(new Object[]{unit, amount, source}); }
        @Override public Optional<Receipt> findById(PaymentId id) { return Optional.ofNullable(rows.get(id)); }
        /** signed credit rows: unit, amount, sourceType, sourceId */
        public final List<Object[]> creditRows = new ArrayList<>();
        public final Map<PaymentId, String> claimed = new LinkedHashMap<>();
        @Override public void creditRow(UnitId unit, Money amount, String sourceType, java.util.UUID sourceId, String reason) { creditRows.add(new Object[]{unit, amount, sourceType, sourceId}); }
        @Override public Money lockCreditBalance(UnitId unit) {
            Money m = Money.ZERO;
            for (Object[] r : credits) if (r[0].equals(unit)) m = m.plus((Money) r[1]);
            for (Object[] r : creditRows) if (r[0].equals(unit)) m = m.plus((Money) r[1]);
            return m;
        }
        @Override public Optional<Money> claim(PaymentId payment, UnitId unit, String purpose, String targetType, java.util.UUID targetId) {
            NewPayment p = raw.get(payment);
            if (p == null || !p.unit().equals(unit) || claimed.containsKey(payment)) return Optional.empty();
            claimed.put(payment, targetType + ":" + targetId);
            return Optional.of(p.amount());
        }
        @Override public Optional<PaymentId> ofOrder(com.communityos.api.shared.domain.Ids.OrderId order) {
            return raw.values().stream().filter((p) -> order.equals(p.order())).map(NewPayment::id).findFirst();
        }
    }

    public static final class Journals implements JournalWriter { public final List<Journal.Entry> entries = new ArrayList<>(); @Override public void post(Journal.Entry e) { entries.add(e); } }
    public static final class Audit implements AuditWriter {
        public final List<String> lines = new ArrayList<>();
        @Override public void write(Caller c, Action a, String entity, UUID id, String shortId, UUID unit, String summary, List<Change> changes) { lines.add(a + " " + entity + " " + summary); }
    }
    public static final class Outbox implements com.communityos.api.shared.events.OutboxWriter { public final List<DomainEvent> events = new ArrayList<>(); @Override public void append(DomainEvent e) { events.add(e); } }
    public static final class Platform implements OrderLocator, InboundEvents {
        public final Orders orders; public final Map<String, Boolean> inbound = new LinkedHashMap<>();
        public Platform(Orders orders) { this.orders = orders; }
        @Override public Optional<Located> byProviderRef(String p, String ref) { return orders.rows.values().stream().filter((o) -> ref.equals(o.providerOrderRef())).map((o) -> new Located(o.community(), o.id())).findFirst(); }
        @Override public List<Located> openOlderThan(Instant before, int limit) { return orders.rows.values().stream().filter((o) -> !o.status().isFinal()).map((o) -> new Located(o.community(), o.id())).toList(); }
        @Override public boolean alreadyProcessed(String p, String e) { return Boolean.TRUE.equals(inbound.get(p + ":" + e)); }
        @Override public void received(String p, String e, UUID c, String t) { inbound.putIfAbsent(p + ":" + e, false); }
        @Override public void markProcessed(String p, String e) { inbound.put(p + ":" + e, true); }
    }

    public static DomainEvents events(List<DomainEventHandler<?>> handlers, Outbox outbox) { return new DomainEvents(handlers, outbox); }
}

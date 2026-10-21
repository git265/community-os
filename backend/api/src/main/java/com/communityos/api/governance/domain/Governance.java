package com.communityos.api.governance.domain;

import com.communityos.api.shared.crypto.Crypto;
import com.communityos.api.shared.domain.DomainException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Meetings and ballots, and the pure rules of e-voting: the roll's fingerprint, the hash chain of the box and the count. */
public final class Governance {
    private Governance() {}
    public static final String INTERNAL = "Internal (committee only)";
    public static final String PUBLISHED = "Published to residents";
    public static final List<String> MEETING_STATUSES = List.of("Scheduled", "Completed", "Cancelled");
    public static final List<String> FOR_AGAINST = List.of("For", "Against", "Abstain");
    public static final String GENESIS = "0".repeat(64);

    // ---- meetings ------------------------------------------------------------------------------------------------------------------------------
    public static final class Meeting {
        public UUID id; public String shortId; public String title; public String committee; public LocalDate date; public LocalTime startTime; public LocalTime endTime;
        public String location; public String status = "Scheduled"; public String visibility = INTERNAL; public Instant publishedAt; public UUID publishedById;
        public String agenda; public String minutes; public Instant minutesAt; public UUID minutesById; public String cancelReason;
        public Instant createdAt; public Instant updatedAt; public long version;
        public boolean published() { return PUBLISHED.equals(visibility); }

        /** The shape of a meeting (the service adds the rules that depend on today and on what it was). */
        public void check() {
            if (title == null || title.isBlank() || title.length() > 200) throw rule("bad-title", "A meeting needs a title (up to 200 characters)");
            if (committee == null || committee.isBlank() || committee.length() > 80) throw rule("bad-committee", "Say which committee meets");
            if (date == null) throw rule("bad-date", "A meeting needs a date");
            if (startTime == null) throw rule("bad-time", "A meeting needs a start time");
            if (endTime != null && !endTime.isAfter(startTime)) throw rule("bad-time", "The meeting must end after it starts");
            if (!MEETING_STATUSES.contains(status)) throw rule("bad-status", "Status is Scheduled, Completed or Cancelled");
            if (!INTERNAL.equals(visibility) && !PUBLISHED.equals(visibility)) throw rule("bad-visibility", "A meeting is internal or published to residents");
            if (location != null && location.length() > 300) throw rule("bad-location", "The location is up to 300 characters");
            if ((agenda != null && agenda.length() > 100_000) || (minutes != null && minutes.length() > 100_000)) throw rule("too-long", "The agenda and the minutes are up to 100,000 characters each");
            if (blank(minutes)) minutes = null;
            if (blank(agenda)) agenda = null;
        }
    }

    // ---- ballots -------------------------------------------------------------------------------------------------------------------------------
    public static final class Ballot {
        public UUID id; public String shortId; public String title; public String description; public String kind = "Resolution"; public List<String> options = List.of();
        public LocalDate opensOn; public LocalDate closesOn; public BigDecimal quorumPct = BigDecimal.valueOf(50); public BigDecimal passPct = BigDecimal.valueOf(50);
        public String status = "Draft"; public String rollHash; public Instant openedAt; public UUID openedById; public Instant closedAt; public UUID closedById;
        public String chainHead; public int votesCast; public Integer votesCounted; public UUID meetingId; public int rollSize;
        public Instant createdAt; public long version;
        public boolean draft() { return "Draft".equals(status); }
        public boolean open() { return "Open".equals(status); }
        public boolean closed() { return "Closed".equals(status); }
        /** Voting is possible today (status and window). "" when yes, otherwise why not. */
        public String windowWhyNot(LocalDate today) {
            if (draft()) return "Voting has not opened yet";
            if (closed()) return "Voting is closed";
            if (opensOn != null && today.isBefore(opensOn)) return "Voting opens on " + opensOn;
            if (closesOn != null && today.isAfter(closesOn)) return "The voting window has ended";
            return "";
        }

        /** A draft's shape: tidies the options and refuses what could never be voted on. */
        public void check() {
            if (title == null || title.isBlank() || title.length() > 200) throw rule("bad-title", "A ballot needs a question (up to 200 characters)");
            if (description != null && description.length() > 20_000) throw rule("too-long", "The details are up to 20,000 characters");
            if (!"Resolution".equals(kind) && !"Choose one".equals(kind)) throw rule("bad-kind", "A ballot is a Resolution or Choose one");
            LinkedHashSet<String> opts = new LinkedHashSet<>();
            for (String o : options == null ? List.<String>of() : options) if (o != null && !o.isBlank()) opts.add(o.strip());
            if (opts.isEmpty() && "Resolution".equals(kind)) opts.addAll(FOR_AGAINST);
            if (opts.stream().anyMatch((o) -> o.length() > 80)) throw rule("bad-options", "An option is up to 80 characters");
            if (opts.size() < 2 || opts.size() > 10) throw rule("bad-options", "A ballot needs between 2 and 10 different options");
            if ("Resolution".equals(kind) && !(opts.contains("For") && opts.contains("Against")))
                throw rule("bad-options", "A Resolution needs “For” and “Against” among its options (add more, e.g. Abstain); use “Choose one” for other questions");
            options = List.copyOf(opts);
            if (opensOn == null || closesOn == null) throw rule("bad-dates", "A ballot needs the day voting opens and the day it closes");
            if (closesOn.isBefore(opensOn)) throw rule("bad-dates", "The closing date must be on or after the opening date");
            if (quorumPct == null) quorumPct = BigDecimal.ZERO;
            if (passPct == null) passPct = BigDecimal.valueOf(50);
            if (quorumPct.signum() < 0 || quorumPct.compareTo(BigDecimal.valueOf(100)) > 0 || passPct.signum() < 0 || passPct.compareTo(BigDecimal.valueOf(100)) > 0)
                throw rule("bad-pct", "Quorum and pass threshold are percentages between 0 and 100");
        }
    }

    /** One unit on the frozen roll, with the owners who may cast its vote. */
    public record Owner(UUID occupantId, UUID personId, String name, String phoneLast4) {}
    public record Elector(UUID unitId, String unitNo, List<Owner> owners) {
        public boolean mayVote(UUID personId) { return personId != null && owners.stream().anyMatch((o) -> personId.equals(o.personId())); }
    }

    /** The roll's fingerprint: one line per unit (by unit number) with its owners' person ids (sorted); an owner with no sign-in is "-". */
    public static String rollHash(List<Elector> roll) {
        StringBuilder sb = new StringBuilder();
        roll.stream().sorted(Comparator.comparing(Elector::unitNo)).forEach((e) -> {
            sb.append(e.unitNo()).append('|');
            sb.append(String.join(",", e.owners().stream().map((o) -> o.personId() == null ? "-" : o.personId().toString()).sorted().toList())).append('\n');
        });
        return sha256Hex(sb.toString());
    }

    // ---- the box ---------------------------------------------------------------------------------------------------------------------------------
    public record BoxRow(int seq, String receipt, String choice, String prevHash, String hash) {}
    /** The same chain the app checks: sha256(prev | seq | receipt | choice). */
    public static String chainHash(String prev, int seq, String receipt, String choice) { return sha256Hex(prev + "|" + seq + "|" + receipt + "|" + choice); }
    public static BoxRow next(String head, int votesCast, String receipt, String choice) {
        String prev = head == null ? GENESIS : head;
        int seq = votesCast + 1;
        return new BoxRow(seq, receipt, choice, prev, chainHash(prev, seq, receipt, choice));
    }
    public record Chain(boolean ok, String head, int count, int brokenAt) {}
    public static Chain verify(List<BoxRow> rows) {
        List<BoxRow> sorted = rows.stream().sorted(Comparator.comparingInt(BoxRow::seq)).toList();
        String prev = GENESIS;
        for (int i = 0; i < sorted.size(); i++) {
            BoxRow r = sorted.get(i);
            if (r.seq() != i + 1 || !prev.equals(r.prevHash()) || !chainHash(prev, r.seq(), r.receipt(), r.choice()).equals(r.hash())) return new Chain(false, prev, sorted.size(), i + 1);
            prev = r.hash();
        }
        return new Chain(true, prev, sorted.size(), 0);
    }

    public record Tally(Map<String, Integer> counts, int cast, int rollSize, boolean quorumMet, String outcome, BigDecimal turnoutPct) {}
    /** The count, as the app has always shown it: a resolution passes when For is more than the threshold of For + Against, with a quorum of units. */
    public static Tally tally(Ballot b, List<BoxRow> rows) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String o : b.options) counts.put(o, 0);
        for (BoxRow r : rows) counts.merge(r.choice(), 1, Integer::sum);
        int cast = rows.size(), size = b.rollSize;
        boolean quorum = size > 0 && BigDecimal.valueOf(cast).multiply(BigDecimal.valueOf(100)).compareTo(b.quorumPct.multiply(BigDecimal.valueOf(size))) >= 0;
        String outcome;
        if ("Resolution".equals(b.kind)) {
            int f = counts.getOrDefault("For", 0), a = counts.getOrDefault("Against", 0);
            boolean passes = f + a > 0 && BigDecimal.valueOf(f).multiply(BigDecimal.valueOf(100)).compareTo(b.passPct.multiply(BigDecimal.valueOf(f + a))) > 0;
            outcome = !quorum ? "No quorum" : passes ? "Passed" : "Not passed";
        } else {
            List<Map.Entry<String, Integer>> top = new ArrayList<>(counts.entrySet());
            top.sort((x, y) -> y.getValue() - x.getValue());
            outcome = !quorum ? "No quorum" : !top.isEmpty() && top.get(0).getValue() > 0 && (top.size() < 2 || top.get(0).getValue() > top.get(1).getValue()) ? "Winner: " + top.get(0).getKey() : "Tie / no votes";
        }
        BigDecimal turnout = size == 0 ? BigDecimal.ZERO : BigDecimal.valueOf(cast * 100L).divide(BigDecimal.valueOf(size), 1, RoundingMode.HALF_UP);
        return new Tally(java.util.Collections.unmodifiableMap(counts), cast, size, quorum, outcome, turnout);
    }

    public static String sha256Hex(String s) { return HexFormat.of().formatHex(Crypto.sha256(s)); }
    static boolean blank(String s) { return s == null || s.replaceAll("<[^>]*>", "").replace("&nbsp;", " ").isBlank(); }
    static DomainException.RuleViolated rule(String code, String message) { return new DomainException.RuleViolated(code, message); }
}

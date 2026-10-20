package com.communityos.evoting;

import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.communityos.service.Tx;
import com.communityos.web.BadRequestException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.InputStream;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.zip.GZIPInputStream;

/**
 * Replays what the real JavaScript e-voting code (src/lib/evoting.js) did in ~6,500 voting sessions (backend/contract-server/test/gen-evoting-golden.mjs,
 * `npm run gen:evoting`): the same steps, the same clock and the same random bytes, so the Java must send the same code, issue the same proof, give the
 * same receipt and extend the hash chain with the same hashes. Reports every step where it answers differently.
 */
public final class EVotingConformanceCheck {
    static final String T = "palm";
    private final ObjectMapper json = new ObjectMapper();
    private final List<String> problems = new ArrayList<>();
    private int steps, refused, sessions, votes;

    public static void main(String[] args) throws Exception {
        EVotingConformanceCheck c = new EVotingConformanceCheck();
        c.run();
        System.out.println("sessions=" + c.sessions + " steps=" + c.steps + " refused=" + c.refused + " votesChained=" + c.votes + " mismatches=" + c.problems.size());
        c.problems.stream().limit(args.length > 0 ? Integer.parseInt(args[0]) : 12).forEach(System.out::println);
        System.exit(c.problems.isEmpty() ? 0 : 1);
    }

    List<String> problems() { return problems; }
    int steps() { return steps; }
    int refused() { return refused; }
    int votes() { return votes; }

    /** xorshift32, one byte = bits 8..15 of the state: the generator the JavaScript run used. */
    static final class Xorshift implements RandomSource {
        int s;
        Xorshift(int seed) { s = seed; }
        @Override public byte[] bytes(int n) {
            byte[] b = new byte[n];
            for (int i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; b[i] = (byte) ((s >>> 8) & 0xff); }
            return b;
        }
    }

    static final class MutableClock extends Clock {
        long ms;
        MutableClock(long ms) { this.ms = ms; }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(ms); }
    }

    private static Principal principal(JsonNode p) {
        if (p == null || p.isNull()) return null;
        return new Principal(Js.text(p, "roleId"), null, Js.text(p, "name"), Js.text(p, "unit"), List.of());
    }

    void run() throws Exception {
        JsonNode gold;
        try (InputStream in = EVotingConformanceCheck.class.getResourceAsStream("/evoting/golden.json.gz")) {
            if (in == null) throw new IllegalStateException("evoting/golden.json.gz is missing: run `npm run gen:evoting` in backend/contract-server");
            gold = json.readTree(new GZIPInputStream(in));
        }
        int si = 0;
        for (JsonNode s : gold.get("sessions")) {
            sessions++; si++;
            InMemoryDocumentRepository repo = new InMemoryDocumentRepository();
            EVotingState state = new InMemoryEVotingState();
            MutableClock clock = new MutableClock(s.get("now").asLong());
            RandomSource random = new Xorshift(s.get("seed").asInt());
            OtpService otp = new OtpService(state, repo, Tx.none(), clock, random, null, "echo");
            int k = 0;
            for (JsonNode st : s.get("steps")) {
                k++; steps++;
                JsonNode op = st.get("op"), want = st.get("out");
                String where = "session " + si + " step " + k + " (" + op.get("t").asText() + (op.has("collection") ? " " + op.get("collection").asText() : "") + ")";
                try { step(repo, state, clock, random, otp, op, want, where); }
                catch (RuntimeException e) { problems.add(where + ": Java threw " + e); }
            }
        }
    }

    private void step(InMemoryDocumentRepository repo, EVotingState state, MutableClock clock, RandomSource random, OtpService otp, JsonNode op, JsonNode want, String where) {
        String t = op.get("t").asText();
        switch (t) {
            case "adv" -> clock.ms += op.get("ms").asLong();
            case "set" -> repo.upsert(T, op.get("collection").asText(), op.get("row").get("id").asText(), op.get("row"));
            case "req" -> {
                String err = null, code = null, last4 = null;
                try { OtpService.Sent s = otp.request(T, principal(op.get("p")), op.get("ballotId").asText()); code = s.code(); last4 = s.phoneLast4(); }
                catch (BadRequestException e) { err = e.getMessage(); }
                if (err != null) { refused++; if (!want.has("err") || !want.get("err").asText().equals(err)) problems.add(where + ": JS " + want + " but Java refused with: " + err); }
                else if (want.has("err") || !want.path("code").asText("").equals(code) || !want.path("phoneLast4").asText("").equals(last4))
                    problems.add(where + ": JS " + want + " but Java sent code " + code + " phone " + last4);
            }
            case "ver" -> {
                String err = null, proof = null;
                try { proof = otp.verify(T, principal(op.get("p")), op.get("ballotId").asText(), op.get("code").asText(null)); }
                catch (BadRequestException e) { err = e.getMessage(); }
                if (err != null) { refused++; if (!want.has("err") || !want.get("err").asText().equals(err)) problems.add(where + ": JS " + want + " but Java refused with: " + err); }
                else if (want.has("err") || !want.path("proof").asText("").equals(proof)) problems.add(where + ": JS " + want + " but Java issued proof " + proof);
            }
            case "wr", "life" -> {
                String collection = "life".equals(t) ? "ballots" : op.get("collection").asText();
                JsonNode recordIn = op.get("record");
                ObjectNode record = (ObjectNode) recordIn.deepCopy();
                JsonNode old = null;
                if ("life".equals(t)) {
                    if (op.hasNonNull("existing")) { old = op.get("existing"); repo.upsert(T, "ballots", old.get("id").asText(), old); }
                    for (JsonNode r : op.get("box")) repo.upsert(T, "ballotBox", r.get("id").asText(), r);
                } else if (op.hasNonNull("existingId")) old = repo.get(T, collection, op.get("existingId").asText()).orElse(null);
                EVotingGuard.Result r = EVotingGuard.preWrite(T, collection, record, old, principal(op.get("p")), (c) -> repo.list(T, c), state, clock, random);
                if (r.error() != null) {
                    refused++;
                    if (!want.has("error") || !want.get("error").asText().equals(r.error())) problems.add(where + ": JS " + abbreviate(want) + " but Java refused with: " + r.error());
                    return;
                }
                if (want.has("error") || want.has("threw")) { problems.add(where + ": JS " + abbreviate(want) + " but Java allowed it with " + r.patch()); return; }
                record.setAll(r.patch());
                r.remove().forEach(record::remove);
                String gotPatch = Js.stringify(r.patch());
                if (!gotPatch.equals(Js.stringify(want.get("patch")))) problems.add(where + ": patch differs. JS " + Js.stringify(want.get("patch")) + " Java " + gotPatch);
                TreeSet<String> wantRemoved = new TreeSet<>(), gotRemoved = new TreeSet<>(r.remove());
                want.get("removed").forEach((x) -> wantRemoved.add(x.asText()));
                if (!wantRemoved.equals(gotRemoved)) problems.add(where + ": removed fields differ. JS " + wantRemoved + " Java " + gotRemoved);
                if (!Js.stringify(record).equals(Js.stringify(want.get("merged")))) problems.add(where + ": stored row differs. JS " + Js.stringify(want.get("merged")) + " Java " + Js.stringify(record));
                if (!"life".equals(t)) repo.upsert(T, collection, record.get("id").asText(), record);
                if ("ballotBox".equals(collection)) votes++;
            }
            default -> problems.add(where + ": unknown step");
        }
    }

    private static String abbreviate(JsonNode n) { String s = n.toString(); return s.length() > 160 ? s.substring(0, 160) + "..." : s; }
}

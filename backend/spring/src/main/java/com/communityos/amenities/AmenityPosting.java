package com.communityos.amenities;

import static com.communityos.amenities.AmenityEngine.inr;
import static com.communityos.amenities.AmenityEngine.round2;

import com.communityos.security.Constants;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.communityos.port.DocumentRepository;
import com.communityos.service.audit.AuditTrail;
import com.communityos.service.audit.Stamps;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * What happens AFTER a booking is stored: the money is posted. The fee (income, with its GST) and the refundable deposit (held, not income) go to
 * the Payments Cross-check as separate lines, unit credit is used and returned in the unit's credit account, and refunds are posted. A port of
 * amenityPostWrite in src/lib/amenityServer.js, and then the notifications (queued e-mail / SMS / WhatsApp rows and the in-app bell, see AmenityNotifier).
 *
 * Runs inside the booking's own transaction: if a posting fails, the booking is not saved (the Node server saved the booking anyway and only logged the failure).
 * Residents cannot write the ledger or the credit account, so these are system postings.
 */
public class AmenityPosting {
    private static final Logger log = LoggerFactory.getLogger(AmenityPosting.class);
    public static final String SYSTEM = AmenitySystem.SYSTEM;
    private final DocumentRepository repo;
    private final AuditTrail audit;
    private final ObjectMapper json;
    private final Clock clock;
    private final Constants constants;
    private final AmenitySystem system;
    private final AmenityNotifier notifier;   // null: no messages (the money postings only)

    public AmenityPosting(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Constants constants, AmenityNotifier notifier) {
        this.repo = repo; this.audit = audit; this.json = json; this.clock = clock; this.constants = constants; this.notifier = notifier;
        this.system = notifier != null ? notifier.system() : new AmenitySystem(repo, audit, clock, constants);
    }

    public AmenityPosting(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Constants constants) { this(repo, audit, json, clock, constants, null); }

    private void tell(String tenant, String event, JsonNode booking, JsonNode settings, String reason, Map<String, String> extra) {
        if (notifier == null) return;
        try { notifier.notify(tenant, event, booking, settings, reason, extra); }
        catch (RuntimeException e) { log.warn("Could not queue the {} messages for booking {}: {}", event, Js.toStr(Js.f(booking, "shortId")), e.toString()); }   // a broken template must not undo a booking
    }
    private static JsonNode f(JsonNode r, String k) { return Js.f(r, k); }

    /** @param action what the booking just did (create, cancel, ...): nothing is posted for a plain edit */
    public void postWrite(String tenant, JsonNode next, String action) {
        if (action == null || action.isEmpty()) return;
        JsonNode settings = repo.list(tenant, "amenitySettings").stream().findFirst().orElse(json.createObjectNode());
        Run run = new Run(tenant, next, account(tenant, settings));
        switch (action) {
            case "create" -> {
                // unit credit is taken (reserved) the moment the booking is made, even if the rest is still to be paid at the office
                if (Js.number(next, "creditApplied") > 0) run.credits("Debit", Js.toNumber(f(next, "creditApplied")), "Used on booking " + Js.toStr(f(next, "shortId")) + " (" + Js.toStr(f(next, "amenity")) + ")");
                if (Js.is(next, "paymentStatus", "Paid")) run.postReceipt();
                tell(tenant, Js.is(next, "paymentStatus", "Pending") ? "booking_pending" : "booking_confirmed", next, settings, "", null);
            }
            case "receive_payment" -> { run.postReceipt(); tell(tenant, "payment_received", next, settings, "", null); }
            case "cancel" -> {
                boolean toAccount = Js.is(next, "refundStatus", "Credited to unit account") && Js.toNumber(f(next, "refundAmount")) > 0;
                if (toAccount) {
                    run.credits("Credit", Js.toNumber(f(next, "refundAmount")), "Refund for cancelled booking " + Js.toStr(f(next, "shortId")) + " (" + Js.toStr(f(next, "amenity")) + ")");
                    if (!Js.truthy(next, "creditRestored")) run.creditedToUnit("refundcredit", f(next, "refundAmount"), "Refund of cancelled booking");
                } else if (Js.is(next, "refundStatus", "Refund due") && !Js.is(next, "paymentStatus", "Cancelled"))
                    run.ledgerRow("Cancelled booking " + run.tag + " — refund of " + inr(f(next, "refundAmount")) + " awaiting payment (retained " + inr(f(next, "retainedAmount")) + ")",
                            "Debit", 0, null, "amenity:" + run.id + ":cancelled", true, null);
                tell(tenant, "booking_cancelled", next, settings, "", null);
                if (toAccount) tell(tenant, "refund_processed", next, settings, "", null);
            }
            case "refund_to_credit" -> {
                run.credits("Credit", Js.toNumber(f(next, "refundAmount")), "Refund for cancelled booking " + Js.toStr(f(next, "shortId")) + " (" + Js.toStr(f(next, "amenity")) + ")");
                run.creditedToUnit("refundcredit", f(next, "refundAmount"), "Refund of cancelled booking");
                tell(tenant, "refund_processed", next, settings, "", null);
            }
            case "mark_refund_paid" -> { run.ledgerRow("Refund " + run.tag + " — cancelled booking · " + Js.orEmpty(f(next, "refundPayoutMode")) + (Js.truthy(next, "refundRef") ? " " + Js.toStr(f(next, "refundRef")) : ""),
                    "Debit", Js.toNumber(f(next, "refundAmount")), null, "amenity:" + run.id + ":refund", false, null);
                tell(tenant, "refund_processed", next, settings, "", null); }
            case "settle_deposit" -> {
                if (Js.is(next, "depositRefundStatus", "Credited to unit account") && Js.toNumber(f(next, "depositReturned")) > 0) {
                    run.credits("Credit", Js.toNumber(f(next, "depositReturned")), "Security deposit returned for " + Js.toStr(f(next, "shortId")) + " (" + Js.toStr(f(next, "amenity")) + ")");
                    run.creditedToUnit("depositcredit", f(next, "depositReturned"), "Security deposit returned");
                }
                tell(tenant, "deposit_settled", next, settings, depositReason(next), null);
            }
            case "mark_deposit_paid" -> { run.ledgerRow("Security deposit returned " + run.tag + " · " + Js.orEmpty(f(next, "depositRefundMode")) + (Js.truthy(next, "depositRefundRef") ? " " + Js.toStr(f(next, "depositRefundRef")) : ""),
                    "Debit", Js.toNumber(f(next, "depositReturned")), null, "amenity:" + run.id + ":depositpaid", false, null);
                tell(tenant, "refund_processed", next, settings, "", Map.of("refund", inr(f(next, "depositReturned")))); }
            default -> { }
        }
    }

    private static final java.util.regex.Pattern TAGS = java.util.regex.Pattern.compile("<[^>]*>");
    private static final java.util.regex.Pattern SPACES = java.util.regex.Pattern.compile("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+");

    /** "Deducted ₹300: broken glass pane" when something was kept back from the deposit, else nothing. */
    private static String depositReason(JsonNode next) {
        if (!Js.truthy(next, "depositDeductionReason")) return "";
        String plain = Js.trim(SPACES.matcher(TAGS.matcher(Js.toStr(f(next, "depositDeductionReason"))).replaceAll(" ")).replaceAll(" "));
        return "Deducted " + inr(f(next, "depositDeduction")) + ": " + plain;
    }

    private JsonNode account(String tenant, JsonNode settings) {
        if (Js.truthy(settings, "receiptAccount")) return f(settings, "receiptAccount");
        List<JsonNode> banks = repo.list(tenant, "bankAccounts");
        JsonNode name = banks.isEmpty() ? Js.MISSING : f(banks.get(0), "name");
        return Js.truthy(name) ? name : json.getNodeFactory().textNode("Maintenance");
    }

    /** One booking's postings, with a memo of the ledger lines that already exist (so a retry never posts a line twice). */
    private final class Run {
        final String tenant; final JsonNode next; final JsonNode account; final String id; final String tag;
        private Set<String> have;

        Run(String tenant, JsonNode next, JsonNode account) {
            this.tenant = tenant; this.next = next; this.account = account;
            this.id = Js.toStr(f(next, "id"));
            this.tag = Js.toStr(f(next, "shortId")) + " · " + Js.toStr(f(next, "amenity")) + " · " + Js.toStr(f(next, "date")) + " · " + Js.toStr(f(next, "unit"));
        }

        /** `gst != null` in the JavaScript: a booking with no GST amount at all gets a fee line without the GST columns. */
        boolean hasGst() { JsonNode g = f(next, "gstAmount"); return !(g.isMissingNode() || g.isNull()); }

        boolean ledgerHas(String sourceId) {
            if (have == null) { have = new HashSet<>(); for (JsonNode l : repo.list(tenant, "ledger")) if (Js.truthy(l, "sourceId") && l.get("sourceId").isTextual()) have.add(l.get("sourceId").asText()); }
            return have.contains(sourceId);
        }

        void postReceipt() {
            double creditUsed = round2(next, "creditApplied");
            if (Js.toNumber(f(next, "feeTotal")) > 0 && !ledgerHas("amenity:" + id + ":fee"))
                ledgerRow("Amenity booking " + tag + " — fee (taxable " + inr(f(next, "baseAmount")) + " + GST " + inr(f(next, "gstAmount")) + ")", "Credit", Js.toNumber(f(next, "feeTotal")),
                        hasGst() ? new double[] {Js.number(next, "baseAmount"), Js.number(next, "gstAmount")} : null, "amenity:" + id + ":fee", false, f(next, "gstRate"));
            if (Js.toNumber(f(next, "depositAmount")) > 0 && !ledgerHas("amenity:" + id + ":deposit"))
                ledgerRow("Amenity booking " + tag + " — refundable security deposit", "Credit", Js.toNumber(f(next, "depositAmount")), null, "amenity:" + id + ":deposit", false, null);
            // paid from the unit's credit balance: no cash arrives, so the receipt is offset by a non-cash debit and the books still show the booking
            if (creditUsed > 0 && !ledgerHas("amenity:" + id + ":creditused"))
                ledgerRow((creditUsed >= round2(next, "totalPayable") ? "Paid" : "Part-paid") + " from unit credit (non-cash) " + tag, "Debit", creditUsed, null, "amenity:" + id + ":creditused", true, null);
        }

        /** Money returned to the unit's credit balance: cash stays in the fund, so a matching non-cash credit is posted beside the refund debit. */
        void creditedToUnit(String key, JsonNode amount, String what) {
            if (!(Js.toNumber(amount) > 0) || ledgerHas("amenity:" + id + ":" + key)) return;
            ledgerRow(what + " — credited to unit account (non-cash) " + tag, "Debit", Js.toNumber(amount), null, "amenity:" + id + ":" + key, true, null);
            ledgerRow("Held as unit credit (liability) " + tag, "Credit", Js.toNumber(amount), null, "amenity:" + id + ":" + key + ":held", true, null);
        }

        /** A line in the unit's credit account (a refund or deposit credited, or credit used on a booking). */
        void credits(String type, double amount, String reason) {
            ObjectNode row = json.createObjectNode();
            put(row, "unit", f(next, "unit")); row.put("type", type); row.set("amount", AmenityEngine.num(round2(amount))); row.put("reason", reason);
            put(row, "bookingId", f(next, "id")); put(row, "bookingNo", f(next, "shortId")); row.put("date", today());
            systemPut("unitCredits", row, null);
        }

        /** @param gst {taxable, gst} for a fee line (the rate comes with it), else null */
        void ledgerRow(String description, String type, double amount, double[] gst, String sourceId, boolean nonCash, JsonNode gstRate) {
            ObjectNode row = json.createObjectNode();
            row.put("date", today()); put(row, "account", account); row.put("description", description); row.put("category", "Amenities"); row.put("module", "Amenities");
            row.put("sourceType", "booking"); row.put("reconStatus", "Unreconciled"); row.put("type", type); row.set("amount", AmenityEngine.num(round2(amount))); row.put("vendor", "");
            row.put("sourceId", sourceId); row.put("unit", Js.truthy(f(next, "unit")) ? Js.toStr(f(next, "unit")) : ""); row.put("bookingNo", Js.truthy(f(next, "shortId")) ? Js.toStr(f(next, "shortId")) : "");
            if (nonCash) row.put("nonCash", true);
            if (gst != null) { row.set("baseAmount", AmenityEngine.num(round2(gst[0]))); put(row, "gstRate", gstRate); row.set("gstAmount", AmenityEngine.num(round2(gst[1]))); }
            row.set("attachments", json.createArrayNode());
            systemPut("ledger", row, description);
            if (have != null) have.add(sourceId);
        }

        private void put(ObjectNode o, String k, JsonNode v) { if (v != null && !v.isMissingNode()) o.set(k, v); }
        private String today() { return Stamps.iso(clock).substring(0, 10); }

        private void systemPut(String collection, ObjectNode row, String summary) { system.put(tenant, collection, row, summary); }
    }
}

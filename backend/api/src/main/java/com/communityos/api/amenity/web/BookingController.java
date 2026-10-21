package com.communityos.api.amenity.web;

import com.communityos.api.amenity.application.BookingService;
import com.communityos.api.amenity.application.port.BookingRepository;
import com.communityos.api.amenity.domain.AmenityType;
import com.communityos.api.amenity.domain.Booking;
import com.communityos.api.amenity.domain.Pricing;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.shared.web.Idempotency;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Bookings: book, list, availability, and the actions after (each its own request type: exactly what that step needs). */
@RestController
@Tag(name = "Amenities")
public class BookingController {
    /** A booking request: what to book and how it is paid. Prices, GST, deposits, statuses and the refund policy are the server's. */
    public record BookRequest(@NotNull UUID amenityTypeId, UUID unitId, @NotNull LocalDate date, @Size(max = 40) String slot, @Size(max = 40) String paymentMode, UUID prepaymentId,
                              Boolean useCredit, @Pattern(regexp = "Unit|Association") String bookedFor, @Size(max = 120) String association, Boolean freeOfCharge,
                              @Size(max = 500) String waiveReason, @Size(max = 30) Map<UUID, Integer> extras) {}
    public record CancelRequest(@Size(max = 500) String reason, Boolean refundToCredit, Boolean waive, BigDecimal refundOverride) {}
    public record PaymentRequest(@NotNull @Size(max = 30) String mode, @Size(max = 100) String reference) {}
    public record PayoutRequest(@Size(max = 30) String mode, @Size(max = 100) String reference, Boolean initiate) {}
    public record DepositRequest(BigDecimal deduction, @Size(max = 2000) String reason, @Size(max = 30) String payoutMode) {}
    public record FeeRequest(@NotNull BigDecimal fee, @NotNull @Size(min = 3, max = 500) String reason) {}

    public record BookingResponse(UUID id, String shortId, UUID amenityTypeId, String amenity, UUID unitId, String unitNo, LocalDate date, String slot, Instant startAt, String status,
                                  String paymentMode, String paymentStatus, String bookedFor, String association, BigDecimal rate, String rateUnit, BigDecimal baseAmount,
                                  BigDecimal gstRate, BigDecimal gstAmount, String gstMode, BigDecimal feeTotal, BigDecimal depositAmount, BigDecimal totalPayable, List<Pricing.Line> extras,
                                  BigDecimal extrasTotal, List<AmenityType.Tier> policySnapshot, boolean chargeWaived, BigDecimal waivedAmount, String waiveReason, BigDecimal creditApplied,
                                  BigDecimal paidAmount, Instant paidAt, String paymentRef, String depositStatus, String refundStatus, BigDecimal refundAmount, String cancelReason,
                                  Instant cancelledAt, String cancelledBy, Instant completedAt, BigDecimal refundPct, BigDecimal refundFeeAmount, BigDecimal depositReturned,
                                  BigDecimal retainedAmount, String refundTo, Instant refundPaidAt, String refundPayoutMode, String refundRef, BigDecimal depositDeduction,
                                  String depositDeductionReason, Instant depositSettledAt, String depositRefundMode, String depositRefundStatus, Instant depositRefundPaidAt,
                                  String depositRefundRef, BigDecimal feeCorrectedFrom, String feeCorrectionReason, String bookedBy, BigDecimal owed, Instant createdAt,
                                  Instant updatedAt, long version) {
        static BookingResponse of(Booking b) {
            Booking.State s = b.state();
            return new BookingResponse(s.id, s.shortId, s.amenityTypeId, s.amenityName, s.unit == null ? null : s.unit.value(), s.unitNo, s.date, s.slot, s.startAt, s.status, s.paymentMode,
                s.paymentStatus, s.bookedFor, s.association, s.rate, s.rateUnit, s.baseAmount, s.gstRate, s.gstAmount, s.gstMode, s.feeTotal, s.depositAmount, s.totalPayable, s.extras,
                s.extrasTotal, s.policy, s.chargeWaived, s.waivedAmount, s.waiveReason, s.creditApplied, s.paidAmount, s.paidAt, s.paymentRef, s.depositStatus, s.refundStatus,
                s.refundAmount, s.cancelReason, s.cancelledAt, s.cancelledByName, s.completedAt, s.refundPct, s.refundFeeAmount, s.depositReturned, s.retainedAmount, s.refundTo,
                s.refundPaidAt, s.refundPayoutMode, s.refundRef, s.depositDeduction, s.depositDeductionReason, s.depositSettledAt, s.depositRefundMode, s.depositRefundStatus,
                s.depositRefundPaidAt, s.depositRefundRef, s.feeCorrectedFrom, s.feeCorrectionReason, s.bookedByName, b.owed(), s.createdAt, s.updatedAt, s.version);
        }
    }

    private final BookingService bookings; private final Idempotency idempotency;
    public BookingController(BookingService bookings, Idempotency idempotency) { this.bookings = bookings; this.idempotency = idempotency; }

    @GetMapping("/api/v1/amenities/bookings")
    public List<BookingResponse> list(@RequestParam(required = false) UUID amenityTypeId, @RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to,
                                      @RequestParam(required = false) String status, @RequestParam(required = false) UUID unit, @RequestParam(defaultValue = "false") boolean openMoney) {
        return bookings.list(CallerHolder.require(), new BookingRepository.Filter(amenityTypeId, from, to, status, unit, openMoney)).stream().map(BookingResponse::of).toList();
    }
    @GetMapping("/api/v1/amenities/bookings/{id}")
    public ResponseEntity<BookingResponse> get(@PathVariable UUID id) { return tagged(bookings.get(CallerHolder.require(), id)); }
    @GetMapping("/api/v1/amenities/availability")
    public List<BookingRepository.Taken> availability(@RequestParam(required = false) UUID amenityTypeId, @RequestParam LocalDate from, @RequestParam LocalDate to) {
        return bookings.availability(CallerHolder.require(), amenityTypeId, from, to);
    }

    @PostMapping("/api/v1/amenities/bookings")
    public ResponseEntity<BookingResponse> book(@Valid @RequestBody BookRequest b, @RequestHeader(name = "Idempotency-Key", required = false) String key) {
        Caller c = CallerHolder.require();
        Idempotency.Reply<BookingResponse> r = idempotency.run(c, key, "POST /api/v1/amenities/bookings", b, BookingResponse.class, 201, () -> BookingResponse.of(bookings.book(c,
            new BookingService.Book(b.amenityTypeId(), b.unitId() == null ? null : new UnitId(b.unitId()), b.date(), b.slot(), b.paymentMode(), b.prepaymentId(),
                Boolean.TRUE.equals(b.useCredit()), b.bookedFor() == null ? "Unit" : b.bookedFor(), b.association(), Boolean.TRUE.equals(b.freeOfCharge()), b.waiveReason(), b.extras()))));
        return ResponseEntity.status(r.status()).header("ETag", ETags.of(r.body().version())).body(r.body());
    }
    @PostMapping("/api/v1/amenities/bookings/{id}/cancel")
    public ResponseEntity<BookingResponse> cancel(@PathVariable UUID id, @Valid @RequestBody CancelRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(bookings.cancel(CallerHolder.require(), id, ETags.require(ifMatch), new BookingService.Cancel(b.reason(), b.refundToCredit(), Boolean.TRUE.equals(b.waive()), b.refundOverride())));
    }
    @PostMapping("/api/v1/amenities/bookings/{id}/payment")
    public ResponseEntity<BookingResponse> payment(@PathVariable UUID id, @Valid @RequestBody PaymentRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(bookings.receivePayment(CallerHolder.require(), id, ETags.require(ifMatch), b.mode(), b.reference()));
    }
    @PostMapping("/api/v1/amenities/bookings/{id}/refund-paid")
    public ResponseEntity<BookingResponse> refundPaid(@PathVariable UUID id, @Valid @RequestBody PayoutRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(bookings.refundPaid(CallerHolder.require(), id, ETags.require(ifMatch), b.mode(), b.reference(), Boolean.TRUE.equals(b.initiate())));
    }
    @PostMapping("/api/v1/amenities/bookings/{id}/refund-to-credit")
    public ResponseEntity<BookingResponse> refundToCredit(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(bookings.refundToCredit(CallerHolder.require(), id, ETags.require(ifMatch)));
    }
    @PostMapping("/api/v1/amenities/bookings/{id}/complete")
    public ResponseEntity<BookingResponse> complete(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(bookings.complete(CallerHolder.require(), id, ETags.require(ifMatch)));
    }
    @PostMapping("/api/v1/amenities/bookings/{id}/deposit")
    public ResponseEntity<BookingResponse> deposit(@PathVariable UUID id, @Valid @RequestBody DepositRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(bookings.settleDeposit(CallerHolder.require(), id, ETags.require(ifMatch), b.deduction(), b.reason(), b.payoutMode()));
    }
    @PostMapping("/api/v1/amenities/bookings/{id}/deposit-paid")
    public ResponseEntity<BookingResponse> depositPaid(@PathVariable UUID id, @Valid @RequestBody PayoutRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(bookings.depositPaid(CallerHolder.require(), id, ETags.require(ifMatch), b.mode(), b.reference(), Boolean.TRUE.equals(b.initiate())));
    }
    @PostMapping("/api/v1/amenities/bookings/{id}/fee")
    public ResponseEntity<BookingResponse> fee(@PathVariable UUID id, @Valid @RequestBody FeeRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(bookings.adjustFee(CallerHolder.require(), id, ETags.require(ifMatch), b.fee(), b.reason()));
    }

    private static ResponseEntity<BookingResponse> tagged(Booking b) { return ResponseEntity.ok().header("ETag", ETags.of(b.version())).body(BookingResponse.of(b)); }
}

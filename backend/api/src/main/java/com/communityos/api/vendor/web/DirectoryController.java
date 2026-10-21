package com.communityos.api.vendor.web;

import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.vendor.application.DirectoryService;
import com.communityos.api.vendor.domain.Directory;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** The service directory and its reviews. Who added a contact (and from which unit), ratings and counts are the server's. */
@RestController("vendorDirectoryController")   // identity.web.DirectoryController already takes the default bean name
@Tag(name = "Vendors")
public class DirectoryController {
    public record ContactRequest(@NotNull @Size(max = 120) String name, @Size(max = 80) String category, @Size(max = 30) String phone, @Size(max = 120) String area,
                                 @Size(max = 120) String rate, @Size(max = 4000) String notes, UUID registryId, @Pattern(regexp = "Active|Hidden") String status,
                                 @Size(max = 500) String hiddenReason) {
        DirectoryService.ContactFields fields() { return new DirectoryService.ContactFields(name, category, phone, area, rate, notes, registryId, status, hiddenReason); }
    }
    public record ReviewRequest(@NotNull @Min(1) @Max(5) Integer rating, @Size(max = 4000) String comment, @Pattern(regexp = "Yes|No") String recommend) {}
    public record ContactResponse(UUID id, String shortId, String name, String category, String phone, String area, String rate, String notes, String status, String hiddenReason,
                                  UUID registryId, UUID addedById, String addedBy, String addedByUnit, BigDecimal rating, int reviews, int recommends, UUID myReviewId, Instant createdAt, long version) {
        static ContactResponse of(Directory.Contact c) {
            return new ContactResponse(c.id, c.shortId, c.name, c.category, c.phone, c.area, c.rate, c.notes, c.status, c.hiddenReason, c.registryId, c.addedById, c.addedBy, c.addedByUnit,
                c.rating, c.reviews, c.recommends, c.myReviewId, c.createdAt, c.version);
        }
    }
    public record ReviewResponse(UUID id, String shortId, UUID contactId, int rating, String comment, String recommend, UUID authorId, String author, String unitNo, Instant createdAt, long version) {
        static ReviewResponse of(Directory.Review r) { return new ReviewResponse(r.id, r.shortId, r.contactId, r.rating, r.comment, r.recommend, r.authorId, r.author, r.unitNo, r.createdAt, r.version); }
    }

    private final DirectoryService directory;
    public DirectoryController(DirectoryService directory) { this.directory = directory; }

    @GetMapping("/api/v1/vendors/directory")
    public List<ContactResponse> list() { return directory.list(CallerHolder.require()).stream().map(ContactResponse::of).toList(); }
    @GetMapping("/api/v1/vendors/directory/{id}")
    public ResponseEntity<ContactResponse> get(@PathVariable UUID id) { return tagged(directory.get(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/vendors/directory")
    public ResponseEntity<ContactResponse> add(@Valid @RequestBody ContactRequest b) {
        Directory.Contact c = directory.add(CallerHolder.require(), b.fields());
        return ResponseEntity.status(201).header("ETag", ETags.of(c.version)).body(ContactResponse.of(c));
    }
    @PutMapping("/api/v1/vendors/directory/{id}")
    public ResponseEntity<ContactResponse> change(@PathVariable UUID id, @Valid @RequestBody ContactRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(directory.change(CallerHolder.require(), id, ETags.require(ifMatch), b.fields()));
    }
    @DeleteMapping("/api/v1/vendors/directory/{id}")
    public ResponseEntity<Void> remove(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        directory.remove(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
    @GetMapping("/api/v1/vendors/directory/{id}/reviews")
    public List<ReviewResponse> reviews(@PathVariable UUID id) { return directory.reviews(CallerHolder.require(), id).stream().map(ReviewResponse::of).toList(); }
    /** My review of the contact: written the first time, rewritten after. */
    @PutMapping("/api/v1/vendors/directory/{id}/review")
    public ReviewResponse review(@PathVariable UUID id, @Valid @RequestBody ReviewRequest b) {
        return ReviewResponse.of(directory.review(CallerHolder.require(), id, new DirectoryService.ReviewFields(b.rating(), b.comment(), b.recommend())));
    }
    @DeleteMapping("/api/v1/vendors/reviews/{id}")
    public ResponseEntity<Void> removeReview(@PathVariable UUID id) { directory.removeReview(CallerHolder.require(), id); return ResponseEntity.noContent().build(); }

    private static ResponseEntity<ContactResponse> tagged(Directory.Contact c) { return ResponseEntity.ok().header("ETag", ETags.of(c.version)).body(ContactResponse.of(c)); }
}

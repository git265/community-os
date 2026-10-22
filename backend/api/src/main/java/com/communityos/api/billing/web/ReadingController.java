package com.communityos.api.billing.web;

import com.communityos.api.billing.application.ReadingPublisher;
import com.communityos.api.shared.tenancy.CallerHolder;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Publishing meter readings as bills: priced by the server from the rate card, one transaction per reading. */
@RestController
@Tag(name = "Billing")
public class ReadingController {
    public record PublishRequest(@NotEmpty @Size(max = 1000) List<UUID> readingIds, @NotNull LocalDate dueDate) {}
    private final ReadingPublisher publisher;
    public ReadingController(ReadingPublisher publisher) { this.publisher = publisher; }

    @PostMapping("/api/v1/billing/readings/publish")
    public List<ReadingPublisher.Result> publish(@Valid @RequestBody PublishRequest b) { return publisher.publish(CallerHolder.require(), b.readingIds(), b.dueDate()); }
}

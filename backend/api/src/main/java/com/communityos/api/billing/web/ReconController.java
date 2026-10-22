package com.communityos.api.billing.web;

import com.communityos.api.billing.application.PaymentReconciler;
import com.communityos.api.billing.domain.Recon;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Reconciliation: where the money records disagree with each other or with the payment provider, and the treasurer's answer. */
@RestController
@Tag(name = "Billing")
public class ReconController {
    public record ResolveRequest(@NotBlank @Pattern(regexp = "Resolved|Ignored") String status, @NotBlank @Size(max = 500) String note) {}

    private final PaymentReconciler recon;
    public ReconController(PaymentReconciler recon) { this.recon = recon; }

    @GetMapping("/api/v1/billing/recon-issues")
    public List<Recon.Issue> issues(@RequestParam(required = false) @Pattern(regexp = "Open|Resolved|Ignored") String status) { return recon.issues(CallerHolder.require(), status); }
    /** Check now (the job runs it every few minutes too). */
    @PostMapping("/api/v1/billing/recon-issues/run")
    public PaymentReconciler.RunResult run() { return recon.run(CallerHolder.require()); }
    @PostMapping("/api/v1/billing/recon-issues/{id}/resolve")
    public Recon.Issue resolve(@PathVariable UUID id, @Valid @RequestBody ResolveRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return recon.resolve(CallerHolder.require(), id, ETags.require(ifMatch), b.status(), b.note());
    }
}

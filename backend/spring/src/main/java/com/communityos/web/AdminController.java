package com.communityos.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import com.communityos.config.AppProperties;
import com.communityos.jobs.JobRunner;
import com.communityos.service.DocumentService;
import com.communityos.service.SecureRecordService;
import com.communityos.service.TenantGuard;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * Demo reset: DELETE /api/admin/tenants/{slug}. Off unless app.admin.allow-tenant-reset=true. Only your own community.
 * Scheduled jobs now: POST /api/admin/jobs/run (Super Admin only), as in the Node server.
 */
@Tag(name = "Admin")
@RestController
public class AdminController {
    private final DocumentService docs;
    private final TenantGuard guard;
    private final AppProperties props;

    private final JobRunner jobs;
    private final SecureRecordService records;

    public AdminController(DocumentService docs, TenantGuard guard, AppProperties props, JobRunner jobs, SecureRecordService records) {
        this.docs = docs; this.guard = guard; this.props = props; this.jobs = jobs; this.records = records;
    }

    @Operation(summary = "Run the scheduled jobs now", description = "Utility types, amenity scheduler, recurring bills, late fees, reminders, GST input credit, report schedules, for every community. Super Admin only.")
    @PostMapping("/api/admin/jobs/run")
    public java.util.Map<String, java.util.Map<String, String>> runJobs(@RequestHeader("X-Community-Id") String c, Authentication who) {
        String t = guard.resolve(c, who);
        if (!"super_admin".equals(records.principal(t, who).roleId())) throw new AccessDeniedException("Only the Super Admin can run the scheduled jobs.");
        return jobs.runOnce();
    }

    @Operation(summary = "Reset a community", description = "Removes all of its records (typed tables and documents). Admin key required.")
    @DeleteMapping("/api/admin/tenants/{slug}")
    public ResponseEntity<Void> reset(@PathVariable String slug, @RequestHeader("X-Community-Id") String c, Authentication who) {
        if (!props.admin().allowTenantReset()) throw new AccessDeniedException("Tenant reset is switched off on this server.");
        String t = guard.resolve(c, who);
        if (!t.equals(slug)) throw new BadRequestException("Reset your own community only.");
        docs.resetCommunity(slug);
        return ResponseEntity.noContent().build();
    }
}

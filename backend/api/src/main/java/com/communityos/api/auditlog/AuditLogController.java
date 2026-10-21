package com.communityos.api.auditlog;

import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.PageQuery;
import com.communityos.api.shared.web.PageResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** GET /api/v1/audit: the audit trail, a page at a time, newest first (the Super Admin and VIEW_AUDIT_LOG). */
@RestController
@Tag(name = "Audit trail")
public class AuditLogController {
    private final AuditLog log;
    public AuditLogController(AuditLog log) { this.log = log; }

    @GetMapping("/api/v1/audit")
    public PageResponse<AuditLog.Entry> list(@RequestParam(required = false) String action, @RequestParam(required = false) String area, @RequestParam(required = false) String entity,
                                            @RequestParam(required = false) UUID entityId, @RequestParam(required = false) UUID unit, @RequestParam(required = false) LocalDate from,
                                            @RequestParam(required = false) LocalDate to, @RequestParam(required = false) String q,
                                            @RequestParam(required = false) Integer limit, @RequestParam(required = false) Integer offset) {
        return PageResponse.of(log.list(CallerHolder.require(), new AuditLog.Filter(action, area, entity, entityId, unit, from, to, q), PageQuery.of(limit, offset)));
    }
}

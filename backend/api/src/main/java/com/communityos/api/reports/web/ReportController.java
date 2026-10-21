package com.communityos.api.reports.web;

import com.communityos.api.reports.application.ReportService;
import com.communityos.api.reports.domain.Reports;
import com.communityos.api.shared.tenancy.CallerHolder;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The reports the server builds, one on demand, and sending a schedule's report now. Schedules and sent reports are the kit (/api/v1/reports/...). */
@RestController
@Tag(name = "Reports")
public class ReportController {
    private final ReportService reports;
    public ReportController(ReportService reports) { this.reports = reports; }

    @GetMapping("/api/v1/reports/catalog")
    public List<Reports.Type> catalog() { CallerHolder.require(); return Reports.TYPES; }
    @GetMapping("/api/v1/reports/build/{type}")
    public ReportService.Built build(@PathVariable String type, @RequestParam(required = false) String period, @RequestParam(required = false) UUID unitId) {
        return reports.build(CallerHolder.require(), type, period, unitId);
    }
    @PostMapping("/api/v1/reports/schedules/{id}/run")
    public ReportService.Sent run(@PathVariable UUID id) { return reports.run(CallerHolder.require(), id, true); }
}

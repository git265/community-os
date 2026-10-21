package com.communityos.api.summary;

import com.communityos.api.shared.tenancy.CallerHolder;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** The counts above a page's list, in one call: worked out now from the rows the caller may see (never stored, so never out of step). */
@RestController
@Tag(name = "Summaries")
public class SummaryController {
    private final SummaryService summaries;
    public SummaryController(SummaryService summaries) { this.summaries = summaries; }

    @GetMapping("/api/v1/summary/dashboard") public SummaryService.Dashboard dashboard() { return summaries.dashboard(CallerHolder.require()); }
    @GetMapping("/api/v1/summary/tickets") public SummaryService.Tickets tickets() { return summaries.tickets(CallerHolder.require()); }
    @GetMapping("/api/v1/summary/dues") public SummaryService.Dues dues() { return summaries.dues(CallerHolder.require()); }
    @GetMapping("/api/v1/summary/gate") public SummaryService.GateNow gate() { return summaries.gate(CallerHolder.require()); }
    @GetMapping("/api/v1/summary/bookings") public SummaryService.Bookings bookings() { return summaries.bookings(CallerHolder.require()); }
}

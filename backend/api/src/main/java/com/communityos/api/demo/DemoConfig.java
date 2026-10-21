package com.communityos.api.demo;

import com.communityos.api.amenity.application.BookingService;
import com.communityos.api.assets.application.AssetService;
import com.communityos.api.billing.application.CounterSettlement;
import com.communityos.api.billing.application.DueService;
import com.communityos.api.comms.application.BroadcastService;
import com.communityos.api.comms.application.ForumService;
import com.communityos.api.config.CosProperties;
import com.communityos.api.cultural.application.DonationService;
import com.communityos.api.cultural.application.ExpenseService;
import com.communityos.api.docs.application.DocumentService;
import com.communityos.api.docs.application.FileService;
import com.communityos.api.finance.application.CashBookService;
import com.communityos.api.gate.application.GateService;
import com.communityos.api.governance.application.BallotService;
import com.communityos.api.governance.application.MeetingService;
import com.communityos.api.identity.application.MemberService;
import com.communityos.api.maintenance.application.FieldStaffService;
import com.communityos.api.maintenance.application.QuotationService;
import com.communityos.api.maintenance.application.TicketService;
import com.communityos.api.shared.resource.ResourceService;
import com.communityos.api.shared.security.CallerLoader;
import com.communityos.api.vendor.application.DirectoryService;
import com.communityos.api.workforce.application.AttendanceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.ZoneId;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The demo loader and the demo sign-in, only with cos.demo.enabled (application-dev.yml); refused at start-up in the prod profile. */
@Configuration
@ConditionalOnProperty(name = "cos.demo.enabled", havingValue = "true")
public class DemoConfig {
    @Bean DemoData demoData(Environment env, CosProperties p, NamedParameterJdbcTemplate jdbc, ObjectMapper json, CallerLoader callers, MemberService members, FieldStaffService staff,
                            DueService dues, CounterSettlement counter, TicketService tickets, QuotationService quotations, ResourceService kit, BookingService bookings, GateService gate,
                            BroadcastService notices, ForumService forum, FileService files, DocumentService documents, DonationService donations, ExpenseService expenses,
                            CashBookService cash, MeetingService meetings, BallotService ballots, DirectoryService directory, AssetService assets, AttendanceService attendance, Clock clock) {
        if (env.matchesProfiles("prod")) throw new IllegalStateException("cos.demo.enabled is not allowed in prod: it signs people in without a code");
        return new DemoData(new DemoData.Services(jdbc, json, callers, members, staff, dues, counter, tickets, quotations, kit, bookings, gate, notices, forum, files, documents, donations,
            expenses, cash, meetings, ballots, directory, assets, attendance, clock, ZoneId.of(p.web().timeZone())));
    }
}

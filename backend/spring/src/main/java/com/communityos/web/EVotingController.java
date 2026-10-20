package com.communityos.web;

import com.communityos.evoting.OtpService;
import com.communityos.security.Principal;
import com.communityos.service.SecureRecordService;
import com.communityos.service.TenantGuard;
import com.fasterxml.jackson.databind.JsonNode;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** The two calls of the voting screen's second step. The vote itself is two ordinary record writes (voteRoll with the proof, then ballotBox). */
@Tag(name = "E-voting")
@RestController
public class EVotingController {
    private final OtpService otp;
    private final SecureRecordService records;
    private final TenantGuard guard;

    public EVotingController(OtpService otp, SecureRecordService records, TenantGuard guard) { this.otp = otp; this.records = records; this.guard = guard; }

    @Operation(summary = "Send me a voting code", description = "Sends a 6-digit code to the mobile registered for the signed-in owner on the owners' register. Only an owner of a unit on the frozen roll, while the ballot is open. One code per 30 seconds.")
    @PostMapping("/api/evoting/otp/request")
    public Map<String, Object> request(@RequestBody JsonNode body, @RequestHeader("X-Community-Id") String c, Authentication who) {
        String community = guard.resolve(c, who);
        Principal p = records.principal(community, who);
        OtpService.Sent s = otp.request(community, p, body.path("ballotId").asText(null));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sent", true);
        out.put("phoneLast4", s.phoneLast4());
        out.put("expiresIn", s.expiresIn());
        if (s.code() != null) out.put("code", s.code());   // delivery=echo only
        return out;
    }

    @Operation(summary = "Check my voting code", description = "A right code returns a single-use proof (2 minutes) to send with the voter-roll write. Three wrong tries burn the code.")
    @PostMapping("/api/evoting/otp/verify")
    public Map<String, Object> verify(@RequestBody JsonNode body, @RequestHeader("X-Community-Id") String c, Authentication who) {
        String community = guard.resolve(c, who);
        Principal p = records.principal(community, who);
        return Map.of("proof", otp.verify(community, p, body.path("ballotId").asText(null), body.path("code").asText(null)));
    }
}

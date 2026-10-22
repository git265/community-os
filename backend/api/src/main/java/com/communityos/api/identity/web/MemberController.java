package com.communityos.api.identity.web;

import com.communityos.api.identity.application.MemberService;
import com.communityos.api.identity.application.port.MemberRepository;
import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.shared.web.PageQuery;
import com.communityos.api.shared.web.PageResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/members")
@Tag(name = "Members")
public class MemberController {
    public record AddMemberRequest(@NotBlank @Size(max = 20) String phone, @NotBlank @Size(max = 120) String fullName, @Size(max = 120) String displayName,
                                   @NotBlank @Size(max = 64) String roleCode, UUID unitId, @Size(max = 20) String relation) {}
    public record ChangeRolesRequest(@NotEmpty @Size(max = 5) List<@NotBlank @Size(max = 64) String> roleCodes, @Size(max = 64) String primaryRoleCode) {}
    public record MemberResponse(UUID id, String displayName, String phone, String status, List<MemberView.Role> roles, List<UUID> units, Instant createdAt, Instant updatedAt, long version) {
        static MemberResponse of(MemberView m) {
            return new MemberResponse(m.id().value(), m.displayName(), m.phone(), m.status(), m.roles(), m.units().stream().map((u) -> u.value()).sorted().toList(),
                m.createdAt(), m.updatedAt(), m.version());
        }
    }

    private final MemberService members;
    public MemberController(MemberService members) { this.members = members; }

    @GetMapping
    public PageResponse<MemberResponse> list(@RequestParam(required = false) String q, @RequestParam(required = false) String role, @RequestParam(required = false) String status,
                                             @RequestParam(required = false) Integer limit, @RequestParam(required = false) Integer offset) {
        return PageResponse.of(members.list(CallerHolder.require(), new MemberRepository.Filter(q, role, status), PageQuery.of(limit, offset)).map(MemberResponse::of));
    }
    @GetMapping("/{id}")
    public ResponseEntity<MemberResponse> get(@PathVariable UUID id) {
        MemberView m = members.get(CallerHolder.require(), new MembershipId(id));
        return ResponseEntity.ok().header("ETag", ETags.of(m.version())).body(MemberResponse.of(m));
    }
    @PostMapping
    public ResponseEntity<MemberResponse> add(@Valid @RequestBody AddMemberRequest b) {
        Caller c = CallerHolder.require();
        MemberResponse r = MemberResponse.of(members.add(c,
            new MemberService.AddMember(b.phone(), b.fullName(), b.displayName(), b.roleCode(), b.unitId() == null ? null : new UnitId(b.unitId()), b.relation())));
        return ResponseEntity.status(201).header("ETag", ETags.of(r.version())).body(r);
    }
    @PutMapping("/{id}/roles")
    public ResponseEntity<MemberResponse> roles(@PathVariable UUID id, @Valid @RequestBody ChangeRolesRequest b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        MemberView m = members.changeRoles(CallerHolder.require(), new MembershipId(id), new MemberService.ChangeRoles(b.roleCodes(), b.primaryRoleCode()), ETags.require(ifMatch));
        return ResponseEntity.ok().header("ETag", ETags.of(m.version())).body(MemberResponse.of(m));
    }
    @PostMapping("/{id}/deactivate")
    public ResponseEntity<MemberResponse> deactivate(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        MemberView m = members.deactivate(CallerHolder.require(), new MembershipId(id), ETags.require(ifMatch));
        return ResponseEntity.ok().header("ETag", ETags.of(m.version())).body(MemberResponse.of(m));
    }
}

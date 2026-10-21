package com.communityos.api.identity.web;

import com.communityos.api.identity.application.AuthService;
import com.communityos.api.shared.security.Caller;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Request and response bodies of /api/v1/auth and /api/v1/me. Requests have exactly the fields a client may send. */
public final class AuthDtos {
    private AuthDtos() {}

    public record CodeRequest(@NotBlank @Size(max = 20) String phone) {}
    public record CodeResponse(UUID challengeId, long expiresInSeconds) {}
    public record TokenRequest(UUID challengeId, @NotBlank @Pattern(regexp = "[0-9]{6}") String code, UUID communityId, @Pattern(regexp = "web|mobile") String client) {}
    public record RefreshRequest(@Size(max = 200) String refreshToken, @Pattern(regexp = "web|mobile") String client) {}
    public record LogoutRequest(@Size(max = 200) String refreshToken) {}
    public record CommunityChoice(UUID communityId, String communityName, String displayName) {
        static CommunityChoice of(com.communityos.api.identity.application.port.PersonDirectory.MembershipRef m) { return new CommunityChoice(m.community().value(), m.communityName(), m.displayName()); }
    }
    /** status = "signed-in" (tokens present) or "choose-community" (communities present; call /token again with communityId). */
    public record TokenResponse(String status, String accessToken, String tokenType, Instant expiresAt, String refreshToken, Instant refreshExpiresAt,
                                CommunityChoice community, List<CommunityChoice> communities) {
        static TokenResponse signedIn(AuthService.Tokens t, boolean includeRefresh) {
            return new TokenResponse("signed-in", t.accessToken(), "Bearer", t.accessExpiresAt(), includeRefresh ? t.refreshToken() : null,
                includeRefresh ? t.refreshExpiresAt() : null, CommunityChoice.of(t.membership()), null);
        }
        static TokenResponse choose(List<com.communityos.api.identity.application.port.PersonDirectory.MembershipRef> ms) {
            return new TokenResponse("choose-community", null, null, null, null, null, null, ms.stream().map(CommunityChoice::of).toList());
        }
    }
    public record MeResponse(UUID membershipId, UUID personId, UUID communityId, String displayName, String category, List<String> roles, List<String> permissions,
                             List<UUID> units, List<UUID> blocks, String trade) {
        static MeResponse of(Caller c) {
            return new MeResponse(c.membership().value(), c.person().value(), c.community().value(), c.displayName(), c.category().name(),
                c.roleCodes().stream().sorted().toList(), c.permissions().stream().map(Enum::name).sorted().toList(),
                c.units().stream().map((u) -> u.value()).sorted().toList(), c.blocks().stream().map((b) -> b.value()).sorted().toList(), c.trade());
        }
    }
}

package com.communityos.api.identity.web;

import com.communityos.api.identity.application.AuthService;
import com.communityos.api.identity.web.AuthDtos.CodeRequest;
import com.communityos.api.identity.web.AuthDtos.CodeResponse;
import com.communityos.api.identity.web.AuthDtos.LogoutRequest;
import com.communityos.api.identity.web.AuthDtos.MeResponse;
import com.communityos.api.identity.web.AuthDtos.RefreshRequest;
import com.communityos.api.identity.web.AuthDtos.TokenRequest;
import com.communityos.api.identity.web.AuthDtos.TokenResponse;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.Clients;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.time.Duration;
import java.time.Instant;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Sign-in. Web clients get the refresh token ONLY as an HttpOnly, Secure, SameSite=Strict cookie scoped to /api/v1/auth (script on the page
 * can never read it); mobile clients ("client":"mobile") get it in the body and keep it in the OS keystore. The access token is always in the body
 * and is sent as Authorization: Bearer.
 */
@RestController
@RequestMapping("/api/v1")
@Tag(name = "Auth")
public class AuthController {
    static final String COOKIE = "cos_refresh";
    private final AuthService auth;
    public AuthController(AuthService auth) { this.auth = auth; }

    @PostMapping("/auth/otp") @Operation(summary = "Send a sign-in code to a phone")
    public ResponseEntity<CodeResponse> requestCode(@Valid @RequestBody CodeRequest body, HttpServletRequest req) {
        AuthService.CodeRequested r = auth.requestCode(body.phone(), client(req));
        return ResponseEntity.status(202).body(new CodeResponse(r.challengeId(), r.expiresInSeconds()));
    }

    @PostMapping("/auth/token") @Operation(summary = "Exchange the code for tokens")
    public ResponseEntity<TokenResponse> token(@Valid @RequestBody TokenRequest body, HttpServletRequest req) {
        AuthService.VerifyResult r = auth.verify(body.challengeId(), body.code(), body.communityId() == null ? null : new CommunityId(body.communityId()), client(req));
        if (r instanceof AuthService.ChooseCommunity c) return ResponseEntity.ok(TokenResponse.choose(c.memberships()));
        return signedIn(((AuthService.SignedIn) r).tokens(), "mobile".equals(body.client()));
    }

    @PostMapping("/auth/refresh") @Operation(summary = "New tokens for a refresh token (rotating)")
    public ResponseEntity<TokenResponse> refresh(@Valid @RequestBody(required = false) RefreshRequest body, @CookieValue(name = COOKIE, required = false) String cookie, HttpServletRequest req) {
        boolean mobile = body != null && "mobile".equals(body.client());
        String token = mobile ? body.refreshToken() : cookie;
        return signedIn(auth.refresh(token, client(req)), mobile);
    }

    @PostMapping("/auth/logout") @Operation(summary = "Sign out this device")
    public ResponseEntity<Void> logout(@Valid @RequestBody(required = false) LogoutRequest body, @CookieValue(name = COOKIE, required = false) String cookie) {
        auth.logout(body != null && body.refreshToken() != null ? body.refreshToken() : cookie);
        return ResponseEntity.noContent().header("Set-Cookie", cookie(COOKIE, "", Duration.ZERO)).build();
    }

    @GetMapping("/me") @Operation(summary = "Who am I in this community")
    public MeResponse me() { return MeResponse.of(CallerHolder.require()); }

    private ResponseEntity<TokenResponse> signedIn(AuthService.Tokens t, boolean mobile) {
        ResponseEntity.BodyBuilder b = ResponseEntity.ok().header("Cache-Control", "no-store");
        if (!mobile) b = b.header("Set-Cookie", cookie(COOKIE, t.refreshToken(), Duration.between(Instant.now(), t.refreshExpiresAt())));
        return b.body(TokenResponse.signedIn(t, mobile));
    }
    static String cookie(String name, String value, Duration maxAge) {
        return ResponseCookie.from(name, value).httpOnly(true).secure(true).sameSite("Strict").path("/api/v1/auth").maxAge(maxAge).build().toString();
    }
    private static AuthService.Client client(HttpServletRequest r) { return new AuthService.Client(Clients.agent(r), Clients.ip(r)); }
}

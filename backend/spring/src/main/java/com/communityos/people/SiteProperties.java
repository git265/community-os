package com.communityos.people;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Where people open the app (app.site.*), for the links in invites and messages - the Node server's PUBLIC_APP_URL.
 *
 * @param publicUrl        e.g. https://app.communityos.in (a community then lives at lapaloma.communityos.in) or http://localhost:5173 in development
 * @param defaultCommunity the community a plain address opens (VITE_DEFAULT_COMMUNITY of the web app)
 */
@ConfigurationProperties(prefix = "app.site")
public record SiteProperties(@DefaultValue("http://localhost:5173") String publicUrl, @DefaultValue("la-paloma") String defaultCommunity) {
    public SiteProperties {
        publicUrl = publicUrl == null || publicUrl.isBlank() ? "http://localhost:5173" : publicUrl;
        defaultCommunity = defaultCommunity == null || defaultCommunity.isBlank() ? "la-paloma" : defaultCommunity;
    }
    public static SiteProperties defaults() { return new SiteProperties(null, null); }

    /** communityUrl(slug) of src/lib/community.js, for an app served at {@link #publicUrl}. */
    public String communityUrl(String slug) { return CommunityUrls.of(publicUrl, slug, defaultCommunity); }
}

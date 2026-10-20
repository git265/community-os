package com.communityos.platform;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** app.platform.admin-key (PLATFORM_ADMIN_KEY): the secret the platform console signs its calls with. Empty = the console's server side is off. */
@ConfigurationProperties(prefix = "app.platform")
public record PlatformProperties(@DefaultValue("") String adminKey) {}

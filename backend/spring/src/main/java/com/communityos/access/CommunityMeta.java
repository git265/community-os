package com.communityos.access;

import com.communityos.security.RuleContext;
import com.communityos.security.SchemaCatalog;

/** What the rules need to know about one community, read from its own data: roles, field rules, final approvers, closed-books date. */
public record CommunityMeta(SchemaCatalog catalog, RuleContext ctx, String lockedUntil) {}

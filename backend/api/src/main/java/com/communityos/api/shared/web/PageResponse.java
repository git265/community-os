package com.communityos.api.shared.web;

import java.util.List;

/** List responses: { items, total, limit, offset }. */
public record PageResponse<T>(List<T> items, long total, int limit, int offset) {
    public static <T> PageResponse<T> of(Page<T> p) { return new PageResponse<>(p.items(), p.total(), p.limit(), p.offset()); }
}

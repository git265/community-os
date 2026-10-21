package com.communityos.api.shared.web;

/** limit / offset from the query string, bounded by the server: at most 200 rows per call whatever the client asks. */
public record PageQuery(int limit, int offset) {
    public static final int MAX = 200;
    public PageQuery {
        if (limit <= 0) limit = 50;
        limit = Math.min(limit, MAX);
        offset = Math.max(0, Math.min(offset, 1_000_000));
    }
    public static PageQuery of(Integer limit, Integer offset) { return new PageQuery(limit == null ? 50 : limit, offset == null ? 0 : offset); }
}

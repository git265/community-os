package com.communityos.api.shared.web;

import java.util.List;
import java.util.function.Function;

/** One page of a list. `total` is the number of rows the caller may see with this filter (not the table size). */
public record Page<T>(List<T> items, long total, int limit, int offset) {
    public Page { items = List.copyOf(items); }
    public <R> Page<R> map(Function<T, R> f) { return new Page<>(items.stream().map(f).toList(), total, limit, offset); }
}

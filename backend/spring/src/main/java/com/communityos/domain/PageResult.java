package com.communityos.domain;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** One page of rows. `approx` is true when counting stopped at its cap: `total` is then a floor ("100000+"), and the screen says so. */
public record PageResult(List<JsonNode> rows, long total, int page, int pageSize, int pages, boolean approx) {
    public PageResult(List<JsonNode> rows, long total, int page, int pageSize, int pages) { this(rows, total, page, pageSize, pages, false); }
}

package com.communityos.domain;

import java.util.List;
import java.util.Map;

/** One page request. Meaning is identical to src/lib/storage/queryEngine.js in the UI. */
public record QuerySpec(int page, int pageSize, String sortKey, String sortDir, String search, List<String> searchKeys,
                        String dateKey, String from, String to, String periodKey, String year, String month,
                        Map<String, List<String>> filters) {}

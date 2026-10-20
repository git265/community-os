package com.communityos.security;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** Reads ALL rows of a collection of the caller's community, unscoped. The rules use it to look things up (a unit's block, a task type's flags). */
@FunctionalInterface
public interface RawReader {
    List<JsonNode> read(String collection);
}

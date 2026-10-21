package com.communityos.api.comms.application.port;

import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.access.Spec;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Notices with their receipts and polls, and the forum - explicit SQL behind it (JdbcCommsStore). */
public interface CommsStore {
    // ---- notices
    List<Comms.Broadcast> broadcasts(Spec<Comms.Broadcast> scope, UUID reader, String status);
    Optional<Comms.Broadcast> broadcast(UUID id, Spec<Comms.Broadcast> scope, UUID reader);
    void insert(Comms.Broadcast b);
    boolean update(Comms.Broadcast b);
    boolean delete(UUID id, long version);
    /** Write one receipt per person the audience reaches (with portal access, active); returns the count. */
    int deliver(UUID broadcastId, Comms.Audience a);
    /** The members a sent notice reached (for the inbox fan-out). */
    List<UUID> recipients(UUID broadcastId);
    /** Stamp the reader's own receipt (first time only); false when the notice did not reach them. */
    boolean viewed(UUID broadcastId, UUID member, Instant at);
    boolean signed(UUID broadcastId, UUID member, Instant at);
    /** Notices whose scheduled time has come (for the job). */
    List<UUID> due(Instant now);
    /** How many units / people a draft would reach, without sending. */
    int reach(Comms.Audience a);
    // ---- polls (a notice's or a topic's)
    record Vote(UUID id, UUID voter, String voterName, UUID unit, String unitNo, List<String> choices, long version) {}
    Optional<Vote> voteOf(UUID broadcastId, UUID topicId, UUID voter, UUID unit);
    void vote(UUID broadcastId, UUID topicId, UUID voter, UUID unit, List<String> choices, Vote existing);
    List<Vote> votes(UUID broadcastId, UUID topicId);
    // ---- forum
    List<Comms.Topic> topics(String category);
    Optional<Comms.Topic> topic(UUID id);
    void insert(Comms.Topic t);
    boolean update(Comms.Topic t);
    boolean deleteTopic(UUID id, long version);
    List<Comms.Post> posts(UUID topicId);
    Optional<Comms.Post> post(UUID id);
    void insert(Comms.Post p);
    boolean update(Comms.Post p);
    boolean deletePost(UUID id, long version);
    /** Recount a topic's visible replies and stamp the last post time. */
    void recount(UUID topicId);
    boolean react(UUID postId);
}

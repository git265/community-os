package com.communityos.api.comms.application;

import com.communityos.api.comms.application.port.CommsStore;
import com.communityos.api.comms.application.port.Inbox;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * The community forum. Members start topics and reply as themselves; the author edits their own words; moderators pin, close, hide (with a
 * reason, so the thread keeps its shape) and remove. A topic poll takes one answer per person. The reply count is the server's.
 */
public final class ForumService {
    public record NewTopic(String title, String category, String kind, List<String> pollOptions) {}
    public record TopicChange(String title, String category, Boolean pinned, String status) {}

    private final CommsStore store; private final Inbox inbox; private final DomainEvents events; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    public ForumService(CommsStore store, Inbox inbox, DomainEvents events, AuditWriter audit, Tx tx, Clock clock) {
        this.store = store; this.inbox = inbox; this.events = events; this.audit = audit; this.tx = tx; this.clock = clock;
    }

    public List<Comms.Topic> topics(Caller c, String category) { requireMember(c); return store.topics(category); }
    public Comms.Topic topic(Caller c, UUID id) { requireMember(c); return store.topic(id).orElseThrow(AccessDenied.NotVisible::new); }
    /** Every post the member can see, all topics at once. */
    public List<Comms.Post> allPosts(Caller c) { requireMember(c); return store.allPosts().stream().map((p) -> shown(c, p)).toList(); }
    /** The results of every poll topic, by topic id (one call for the forum page). */
    public java.util.Map<UUID, Comms.PollResult> pollResults(Caller c) {
        requireMember(c);
        java.util.Map<UUID, Comms.PollResult> out = new java.util.LinkedHashMap<>();
        for (Comms.Topic t : store.topics(null)) if ("Poll".equals(t.kind)) out.put(t.id, results(c, t));
        return out;
    }
    public List<Comms.Post> posts(Caller c, UUID topicId) {
        topic(c, topicId);
        return store.posts(topicId).stream().map((p) -> shown(c, p)).toList();
    }

    public Comms.Topic start(Caller c, NewTopic n) {
        requireMember(c);
        return tx.inTx(() -> {
            Comms.Topic t = new Comms.Topic();
            t.title = n.title(); t.category = n.category() == null ? "General" : n.category(); t.kind = n.kind() == null ? "Discussion" : n.kind();
            t.pollOptions = n.pollOptions() == null ? List.of() : n.pollOptions();
            t.check();
            store.insert(t);
            events.publish(List.of(new BroadcastService.CommsEvent("comms.forum.topic-started", t.id, c.community(), t.kind, clock.instant())));
            audit.write(c, AuditWriter.Action.Create, "comms.forum_topic", t.id, t.shortId, null, t.title, List.of());
            return store.topic(t.id).orElseThrow();
        });
    }
    public Comms.Topic change(Caller c, UUID id, long version, TopicChange ch) {
        requireMember(c);
        return tx.inTx(() -> {
            Comms.Topic t = current(c, id, version);
            boolean mod = CommsPolicy.moderator(c);
            boolean author = mine(c, t.authorId);
            if (ch.pinned() != null && ch.pinned() != t.pinned && !mod) throw new AccessDenied("Only a moderator pins a topic");
            if (ch.status() != null && !ch.status().equals(t.status) && !mod) throw new AccessDenied("Only a moderator closes or reopens a topic");
            boolean words = (ch.title() != null && !ch.title().strip().equals(t.title)) || (ch.category() != null && !ch.category().equals(t.category));
            if (words && !mod && !(author && t.replies == 0)) throw new AccessDenied("You can change the title only of your own topic, before anyone replies");
            if (ch.title() != null) t.title = ch.title();
            if (ch.category() != null) t.category = ch.category();
            if (ch.pinned() != null) t.pinned = ch.pinned();
            if (ch.status() != null) { if (!List.of("Open", "Closed").contains(ch.status())) throw new DomainException.RuleViolated("bad-status", "A topic is Open or Closed"); t.status = ch.status(); }
            t.check();
            if (!store.update(t)) throw new DomainException.Conflict("Topic " + t.shortId);
            audit.write(c, AuditWriter.Action.Update, "comms.forum_topic", t.id, t.shortId, null, (t.pinned ? "pinned, " : "") + t.status, List.of());
            return store.topic(id).orElseThrow();
        });
    }
    public void remove(Caller c, UUID id, long version) {
        if (!CommsPolicy.moderator(c)) throw new AccessDenied("Only a moderator removes a topic");
        tx.run(() -> {
            Comms.Topic t = current(c, id, version);
            if (!store.deleteTopic(id, version)) throw new DomainException.Conflict("Topic " + t.shortId);
            audit.write(c, AuditWriter.Action.Delete, "comms.forum_topic", t.id, t.shortId, null, t.title, List.of());
        });
    }

    // ---- posts ---------------------------------------------------------------------------------------------------------------------------------
    public Comms.Post reply(Caller c, UUID topicId, UUID parentId, String body) {
        requireMember(c);
        return tx.inTx(() -> {
            Comms.Topic t = store.topic(topicId).orElseThrow(AccessDenied.NotVisible::new);
            if (!t.open() && !CommsPolicy.moderator(c)) throw new DomainException.RuleViolated("closed", "This topic is closed");
            Comms.Post parent = null;
            if (parentId != null) {
                parent = store.post(parentId).filter((p) -> p.topicId.equals(topicId)).orElseThrow(() -> new DomainException.RuleViolated("bad-parent", "That post is not in this topic"));
            }
            Comms.Post p = new Comms.Post();
            p.topicId = topicId; p.parentId = parentId; p.body = Comms.Post.checkBody(body);
            store.insert(p);
            store.recount(topicId);
            Comms.To to = Comms.To.member(t.authorId).and(parent == null ? Comms.To.nobody() : Comms.To.member(parent.authorId));
            if (!to.empty()) inbox.deliver(new Comms.Message("forum_reply", "forum", "New reply: " + t.title, c.displayName() + " replied" + (parent == null ? " to your topic." : "."),
                "#/communications", t.id, to));
            events.publish(List.of(new BroadcastService.CommsEvent("comms.forum.replied", p.id, c.community(), t.kind, clock.instant())));
            audit.write(c, AuditWriter.Action.Create, "comms.forum_post", p.id, p.shortId, null, "Reply on " + t.shortId, List.of());
            return store.post(p.id).orElseThrow();
        });
    }
    public Comms.Post edit(Caller c, UUID id, long version, String body) {
        return tx.inTx(() -> {
            Comms.Post p = currentPost(id, version);
            if (!mine(c, p.authorId)) throw new AccessDenied("You can edit only your own posts");
            if (p.hidden) throw new DomainException.RuleViolated("hidden", "A moderator hid this post");
            p.body = Comms.Post.checkBody(body); p.editedAt = clock.instant();
            if (!store.update(p)) throw new DomainException.Conflict("Post " + p.shortId);
            audit.write(c, AuditWriter.Action.Update, "comms.forum_post", p.id, p.shortId, null, "Edited", List.of());
            return store.post(id).orElseThrow();
        });
    }
    public Comms.Post hide(Caller c, UUID id, long version, boolean hidden, String reason) {
        if (!CommsPolicy.moderator(c)) throw new AccessDenied("Only a moderator hides posts");
        return tx.inTx(() -> {
            Comms.Post p = currentPost(id, version);
            if (hidden && (reason == null || reason.isBlank())) throw new DomainException.RuleViolated("reason-required", "Say why the post is hidden");
            p.hidden = hidden; p.hiddenReason = hidden ? reason.strip() : null;
            if (!store.update(p)) throw new DomainException.Conflict("Post " + p.shortId);
            store.recount(p.topicId);
            audit.write(c, AuditWriter.Action.Update, "comms.forum_post", p.id, p.shortId, null, hidden ? "Hidden: " + p.hiddenReason : "Shown again", List.of());
            return store.post(id).orElseThrow();
        });
    }
    public void delete(Caller c, UUID id, long version) {
        tx.run(() -> {
            Comms.Post p = currentPost(id, version);
            if (!mine(c, p.authorId) && !CommsPolicy.moderator(c)) throw new AccessDenied("You can delete only your own posts");
            if (!store.deletePost(id, version)) throw new DomainException.Conflict("Post " + p.shortId);
            store.recount(p.topicId);
            audit.write(c, AuditWriter.Action.Delete, "comms.forum_post", p.id, p.shortId, null, "Removed", List.of());
        });
    }
    public Comms.Post react(Caller c, UUID id) {
        requireMember(c);
        return tx.inTx(() -> {
            if (!store.react(id)) throw new AccessDenied.NotVisible();
            return shown(c, store.post(id).orElseThrow());
        });
    }

    // ---- topic polls ---------------------------------------------------------------------------------------------------------------------------
    public Comms.PollResult vote(Caller c, UUID topicId, int choice) {
        requireMember(c);
        return tx.inTx(() -> {
            Comms.Topic t = store.topic(topicId).orElseThrow(AccessDenied.NotVisible::new);
            if (!"Poll".equals(t.kind)) throw new DomainException.RuleViolated("not-a-poll", "This topic is not a poll");
            if (!t.open()) throw new DomainException.RuleViolated("closed", "This topic is closed");
            if (choice < 0 || choice >= t.pollOptions.size()) throw new DomainException.RuleViolated("bad-choice", "That is not one of the answers");
            if (store.voteOf(null, topicId, c.membership().value(), null).isPresent()) throw new DomainException.RuleViolated("voted", "You have already voted");
            store.vote(null, topicId, c.membership().value(), null, List.of(String.valueOf(choice)), null);
            return results(c, t);
        });
    }
    public Comms.PollResult results(Caller c, UUID topicId) { return results(c, topic(c, topicId)); }
    private Comms.PollResult results(Caller c, Comms.Topic t) {
        var votes = store.votes(null, t.id);
        List<Integer> counts = new ArrayList<>();
        for (int i = 0; i < t.pollOptions.size(); i++) { String k = String.valueOf(i); counts.add((int) votes.stream().filter((v) -> v.choices().contains(k)).count()); }
        var mine = votes.stream().filter((v) -> c.membership() != null && c.membership().value().equals(v.voter())).findFirst();
        return new Comms.PollResult(counts, votes.size(), mine.map(CommsStore.Vote::choices).orElse(List.of()), null);
    }

    private Comms.Topic current(Caller c, UUID id, long version) {
        Comms.Topic t = store.topic(id).orElseThrow(AccessDenied.NotVisible::new);
        if (t.version != version) throw new DomainException.Conflict("Topic " + t.shortId);
        return t;
    }
    private Comms.Post currentPost(UUID id, long version) {
        Comms.Post p = store.post(id).orElseThrow(AccessDenied.NotVisible::new);
        if (p.version != version) throw new DomainException.Conflict("Post " + p.shortId);
        return p;
    }
    /** A hidden post keeps its place; only its author and the moderators still read the words. */
    static Comms.Post shown(Caller c, Comms.Post p) { if (p.hidden && !CommsPolicy.moderator(c) && !mine(c, p.authorId)) p.body = ""; return p; }
    static boolean mine(Caller c, UUID who) { return who != null && c.membership() != null && c.membership().value().equals(who); }
    static void requireMember(Caller c) { if (!CommsPolicy.member(c)) throw new AccessDenied("The forum is for members of the community"); }
}

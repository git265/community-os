package com.communityos.api.governance.application.port;

import com.communityos.api.governance.domain.Governance;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Meetings, ballots, the frozen roll, the marks, the box and the second-factor codes - explicit SQL behind it (JdbcGovernanceStore). */
public interface GovernanceStore {
    // meetings
    record MeetingFilter(boolean publishedOnly, LocalDate from, LocalDate to, String committee) {}
    List<Governance.Meeting> meetings(MeetingFilter f);
    Optional<Governance.Meeting> meeting(UUID id, boolean lock);
    void insert(Governance.Meeting m);
    boolean update(Governance.Meeting m);
    boolean deleteMeeting(UUID id, long version);

    // ballots
    List<Governance.Ballot> ballots(boolean withDrafts);
    Optional<Governance.Ballot> ballot(UUID id, boolean lock);
    void insert(Governance.Ballot b);
    /** A draft's own fields (title, details, kind, options, dates, thresholds, meeting). */
    boolean updateDraft(Governance.Ballot b);
    boolean deleteBallot(UUID id, long version);
    /** The units that have a registered owner now (Owner / Co-owner, current), with those owners. */
    List<Governance.Elector> currentOwners();
    /** Freeze the roll and open the ballot (status, fingerprint, who and when). */
    boolean open(Governance.Ballot b, List<Governance.Elector> roll);
    List<Governance.Elector> roll(UUID ballotId);
    Optional<Governance.Elector> elector(UUID ballotId, UUID unitId);
    /** The units a person may vote for, on every ballot (from the frozen rolls), and whether each has voted. */
    record MyUnit(UUID ballotId, UUID unitId, String unitNo, boolean voted) {}
    List<MyUnit> unitsOf(UUID personId);

    record Mark(UUID ballotId, UUID unitId, String unitNo, UUID voterId, String voter, LocalDate markedOn) {}
    List<Mark> marks(UUID ballotId);
    boolean voted(UUID ballotId, UUID unitId);
    /** In one go: the unit's mark, the box row, and the ballot's running count and chain head (the ballot is locked by the caller). */
    void cast(Governance.Ballot b, Mark mark, Governance.BoxRow row);
    boolean close(Governance.Ballot b);
    /** Readable only once the ballot is closed (the database refuses before). */
    List<Governance.BoxRow> box(UUID ballotId);

    // the second factor
    record Challenge(UUID id, UUID ballotId, UUID unitId, UUID personId, byte[] codeHash, int attempts, Instant sentAt, Instant expiresAt, byte[] proofHash, Instant proofExpiresAt) {}
    Optional<Challenge> challenge(UUID ballotId, UUID unitId, UUID personId);
    /** Replaces any earlier code of this voter, unit and ballot. */
    void newChallenge(Challenge c);
    void updateChallenge(Challenge c);
    void deleteChallenge(UUID id);
    /** The mobile this owner registered for the unit (or their sign-in number), or null. */
    String phoneOf(UUID unitId, UUID personId);
}

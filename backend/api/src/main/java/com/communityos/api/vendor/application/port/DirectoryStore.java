package com.communityos.api.vendor.application.port;

import com.communityos.api.vendor.domain.Directory;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** The directory and its reviews - explicit SQL behind it (JdbcDirectoryStore). Ratings are worked out from the reviews, never stored. */
public interface DirectoryStore {
    /** Contacts with their rating, counts and my review; hidden ones only when asked. */
    List<Directory.Contact> contacts(boolean withHidden, UUID me);
    Optional<Directory.Contact> contact(UUID id, UUID me, boolean lock);
    void insert(Directory.Contact c);
    boolean update(Directory.Contact c);
    boolean deleteContact(UUID id, long version);
    List<Directory.Review> reviews(UUID contactId);
    Optional<Directory.Review> review(UUID id);
    Optional<Directory.Review> reviewBy(UUID contactId, UUID authorId);
    Optional<Directory.Review> reviewOfUnit(UUID contactId, UUID unitId);
    void insert(Directory.Review r);
    boolean update(Directory.Review r);
    boolean deleteReview(UUID id);
    String unitNo(UUID unitId);
}

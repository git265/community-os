package com.communityos.api.shared.access;

import com.communityos.api.shared.security.Caller;

/**
 * Strategy: who may read and change one kind of record. One implementation per resource (UnitPolicy, DuePolicy ...), so a rule lives in exactly
 * one class and is used by every path - list, get, query, create, update, bulk.
 */
public interface AccessPolicy<T> {
    /** The rows this caller may read, as a specification the repository puts in the WHERE clause. */
    Spec<T> readScope(Caller caller);
    /** The rows this caller may change (defaults to what they may read). */
    default Spec<T> writeScope(Caller caller) { return readScope(caller); }
}

package com.communityos.api.docs.adapter;

import com.communityos.api.docs.application.port.FileStorage;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/** Bytes in a folder on this server (development, single-node installs). A key never leaves the root; a write is all or nothing. */
public final class LocalDiskStorage implements FileStorage {
    private final Path root;
    public LocalDiskStorage(Path root) {
        this.root = root.toAbsolutePath().normalize();
        try { Files.createDirectories(this.root); } catch (IOException e) { throw new UncheckedIOException("cannot create the file store at " + this.root, e); }
    }
    Path at(String key) {
        if (key == null || key.isBlank() || key.contains("..") || key.startsWith("/")) throw new IllegalArgumentException("bad storage key");
        Path p = root.resolve(key).normalize();
        if (!p.startsWith(root)) throw new IllegalArgumentException("bad storage key");
        return p;
    }
    @Override public void put(String key, byte[] bytes) {
        Path p = at(key);
        try {
            Files.createDirectories(p.getParent());
            Path tmp = Files.createTempFile(p.getParent(), ".up-", ".part");
            Files.write(tmp, bytes);
            try { Files.move(tmp, p, StandardCopyOption.ATOMIC_MOVE); } catch (AtomicMoveNotSupportedException e) { Files.move(tmp, p, StandardCopyOption.REPLACE_EXISTING); }
        } catch (IOException e) { throw new UncheckedIOException("could not store the file", e); }
    }
    @Override public byte[] get(String key) {
        try { return Files.readAllBytes(at(key)); }
        catch (NoSuchFileException e) { throw new IllegalStateException("the file's bytes are missing from the store"); }
        catch (IOException e) { throw new UncheckedIOException("could not read the file", e); }
    }
    @Override public void delete(String key) { try { Files.deleteIfExists(at(key)); } catch (IOException e) { throw new UncheckedIOException("could not delete the file", e); } }
}

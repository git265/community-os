package com.communityos.adapter.files;

import com.communityos.domain.StoredFile;
import com.communityos.port.FileStorage;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

/** Files in a folder (development, single server, or a mounted network disk). Layout: <dir>/<tenant>/<id> + <id>.mime */
public class LocalDiskFileStorage implements FileStorage {
    private final Path root;

    public LocalDiskFileStorage(String dir) { this.root = Path.of(dir).toAbsolutePath().normalize(); }

    private Path path(String tenant, String id) {
        Path p = root.resolve(tenant).resolve(id.replaceAll("[^A-Za-z0-9_.-]", "_")).normalize();
        if (!p.startsWith(root)) throw new IllegalArgumentException("Bad file id");
        return p;
    }

    @Override public void put(String tenant, String id, byte[] bytes, String mime) {
        try {
            Path p = path(tenant, id);
            Files.createDirectories(p.getParent());
            Files.write(p, bytes);
            Files.writeString(Path.of(p + ".mime"), mime == null ? "application/octet-stream" : mime, StandardCharsets.UTF_8);
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }

    @Override public Optional<StoredFile> get(String tenant, String id) {
        try {
            Path p = path(tenant, id);
            if (!Files.exists(p)) return Optional.empty();
            Path m = Path.of(p + ".mime");
            return Optional.of(new StoredFile(Files.readAllBytes(p), Files.exists(m) ? Files.readString(m) : "application/octet-stream"));
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }

    @Override public void delete(String tenant, String id) {
        try { Path p = path(tenant, id); Files.deleteIfExists(p); Files.deleteIfExists(Path.of(p + ".mime")); }
        catch (IOException e) { throw new UncheckedIOException(e); }
    }

    @Override public String name() { return "local-disk"; }
}

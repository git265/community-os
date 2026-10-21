package com.communityos.api.docs;

import com.communityos.api.docs.application.DocsPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.security.Caller;
import java.util.List;
import java.util.UUID;

/** Document folders (resource kit). A folder may be limited to roles; the limit holds for everything inside it. */
public final class DocsResources {
    private DocsResources() {}
    public record FolderFields(String name, UUID parentId, List<String> accessRoles) {}
    public static final Resource<FolderFields> FOLDERS = new Resource<>(
        new ResourceTable<>("docFolders", "documents/folders", "docs.folder", FolderFields.class, "r.name"),
        new ResourceRules<>() {
            @Override public Spec<FolderFields> readScope(Caller c) {
                if (c.membership() == null || c.category() == Caller.Category.Vendor) return Spec.none();
                return DocsPolicy.folders(c, "r.id");
            }
            @Override public boolean mayWrite(Caller c) { return DocsPolicy.manager(c); }
            @Override public FolderFields validate(Caller c, FolderFields f, FolderFields old) {
                String name = Checks.required(f.name(), "Name");
                Checks.rule(name.length() <= 120, "too-long", "Keep a folder name to 120 characters");
                List<String> roles = Checks.list(f.accessRoles()).stream().map(String::strip).filter((r) -> !r.isEmpty()).distinct().toList();
                for (String r : roles) Checks.rule(r.matches("(group:)?[A-Za-z_]{2,40}"), "bad-role", "Limit a folder to role codes (or group:EC)");
                return new FolderFields(name, f.parentId(), roles);
            }
            @Override public String label(FolderFields f) { return f.name(); }
        });
    public static List<Resource<?>> all() { return List.of(FOLDERS); }
}

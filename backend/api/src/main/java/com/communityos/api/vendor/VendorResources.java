package com.communityos.api.vendor;

import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.vendor.application.VendorPolicy;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** The vendor register, what each vendor is signed for, and the internal discussion on a vendor (resource kit). The directory is DirectoryService. */
public final class VendorResources {
    private VendorResources() {}
    public static final List<String> CATEGORIES = List.of("Facilities Management", "Maintenance", "Security", "Landscaping", "Utilities", "Cleaning", "Lift / AMC", "Audit / inspection agency", "Other");
    static final List<String> CONTRACTS = List.of("Contract", "AMC", "Local / no contract");
    /** The categories a vendor's service lines can be (one line per category, each with its own head count). */
    static final List<String> SERVICES = List.of("Security", "Landscaping", "Housekeeping", "Cleaning", "Electrical", "Plumbing", "MEP / plant operation", "Lift", "Pest control", "Pool",
        "Facilities Management", "Maintenance", "Utilities", "Audit / inspection agency", "Other");
    static <F extends Record> Spec<F> readers(Caller c) { return VendorPolicy.reader(c) ? Spec.all() : Spec.none(); }

    public record VendorFields(String name, String category, String gstin, String contractType, String service, String contactPhone, String contactEmail, String address,
                               LocalDate contractEnds, String description) {}
    public static final Resource<VendorFields> VENDORS = new Resource<>(
        new ResourceTable<>("vendors", "vendors/vendors", "vendor.vendor", VendorFields.class, "lower(r.name)")
            .computed("serviceLines", Kind.INT, "(SELECT count(*) FROM vendor.service_line s WHERE s.community_id = r.community_id AND s.vendor_id = r.id)")
            .computed("signedWorkers", Kind.INT, "(SELECT coalesce(sum(coalesce(s.signed_workers, 0) + coalesce(s.contractors, 0)), 0) FROM vendor.service_line s WHERE s.community_id = r.community_id AND s.vendor_id = r.id)"),
        new ResourceRules<>() {
            @Override public Spec<VendorFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return VendorPolicy.manager(c); }
            @Override public VendorFields validate(Caller c, VendorFields f, VendorFields old) {
                String gstin = com.communityos.api.shared.domain.Gstin.check(f.gstin());   // blank: the vendor is not registered for GST
                String email = com.communityos.api.shared.domain.Names.email(f.contactEmail());   // stored in lower case
                Checks.rule(email == null || email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+"), "bad-email", "That e-mail address does not look right");
                return new VendorFields(Checks.text(Checks.required(f.name(), "Name"), "Name", 200), Checks.oneOf(f.category(), "Category", CATEGORIES), gstin,
                    Checks.oneOf(f.contractType(), "Contract", CONTRACTS), Checks.text(f.service(), "Service", 200), Checks.text(f.contactPhone(), "Phone", 30), email,
                    Checks.text(f.address(), "Address", 1000), f.contractEnds(), Checks.text(f.description(), "Description", 20_000));
            }
            @Override public String label(VendorFields f) { return f.name(); }
        });

    /** signedWorkers: the vendor's own employees on this line; contractors: the sub-contracted workers they bring. */
    public record ServiceLineFields(UUID vendorId, String service, Integer signedWorkers, String shift, String note, Integer contractors) {}
    public static final Resource<ServiceLineFields> SERVICE_LINES = new Resource<>(
        new ResourceTable<>("vendorServices", "vendors/service-lines", "vendor.service_line", ServiceLineFields.class, "r.service")
            .computed("vendorName", Kind.TEXT, "(SELECT v.name FROM vendor.vendor v WHERE v.community_id = r.community_id AND v.id = r.vendor_id)").filterBy("vendorId"),
        new ResourceRules<>() {
            @Override public Spec<ServiceLineFields> readScope(Caller c) { return readers(c); }
            @Override public boolean mayWrite(Caller c) { return VendorPolicy.manager(c); }
            @Override public ServiceLineFields validate(Caller c, ServiceLineFields f, ServiceLineFields old) {
                Checks.rule(f.vendorId() != null, "vendor-required", "Which vendor?");
                return new ServiceLineFields(f.vendorId(), Checks.requiredOneOf(f.service(), "Service", SERVICES), Checks.nonNegative(f.signedWorkers(), "Employees"),
                    Checks.text(f.shift(), "Shift", 80), Checks.text(f.note(), "Note", 500), Checks.nonNegative(f.contractors(), "Contractors"));
            }
            @Override public String label(ServiceLineFields f) { return f.service(); }
        });

    /** A comment is written once by its author and then stays as it is (no edits, no deletes). */
    public record CommentFields(UUID vendorId, String body) {}
    public static final Resource<CommentFields> COMMENTS = new Resource<>(
        new ResourceTable<>("vendorComments", "vendors/comments", "vendor.comment", CommentFields.class, "r.created_at")
            .who("author")
            .server("authorRoleId", "author_role_id", Kind.UUID, "(SELECT mr.role_id FROM identity.membership_role mr WHERE mr.membership_id = platform.current_actor() AND mr.is_primary LIMIT 1)")
            .computed("authorRole", Kind.TEXT, "(SELECT ro.name FROM identity.role ro WHERE ro.id = r.author_role_id)").filterBy("vendorId"),
        new ResourceRules<>() {
            @Override public Spec<CommentFields> readScope(Caller c) { return VendorPolicy.discusses(c) ? Spec.all() : Spec.none(); }
            @Override public boolean mayWrite(Caller c) { return VendorPolicy.discusses(c); }
            @Override public boolean mayChange(Caller c, Item<CommentFields> it) { return false; }
            @Override public boolean deletable(CommentFields f) { return false; }
            @Override public CommentFields validate(Caller c, CommentFields f, CommentFields old) {
                Checks.rule(f.vendorId() != null, "vendor-required", "Which vendor?");
                return new CommentFields(f.vendorId(), Checks.text(Checks.required(f.body(), "Comment"), "Comment", 20_000));
            }
        });

    public static List<Resource<?>> all() { return List.of(VENDORS, SERVICE_LINES, COMMENTS); }
}

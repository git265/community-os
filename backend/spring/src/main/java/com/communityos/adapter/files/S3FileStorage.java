package com.communityos.adapter.files;

import com.communityos.config.AppProperties;
import com.communityos.domain.StoredFile;
import com.communityos.port.FileStorage;
import java.net.URI;
import java.util.Optional;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.ResponseBytes;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

/**
 * Amazon S3 - and anything that speaks the S3 API: MinIO, Cloudflare R2, DigitalOcean Spaces, Wasabi, Backblaze B2.
 * Choose between them with app.files.s3.endpoint only; no code change. Object key: <prefix><tenant>/<id>.
 */
public class S3FileStorage implements FileStorage {
    private final S3Client s3;
    private final String bucket;
    private final String prefix;

    public S3FileStorage(AppProperties.Files.S3 c) {
        if (c.bucket() == null || c.bucket().isBlank()) throw new IllegalStateException("app.files.s3.bucket is not set (env S3_BUCKET).");
        var b = S3Client.builder().region(Region.of(c.region()))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(c.pathStyle()).build());
        if (c.endpoint() != null && !c.endpoint().isBlank()) b.endpointOverride(URI.create(c.endpoint()));
        if (c.accessKey() != null && !c.accessKey().isBlank()) b.credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(c.accessKey(), c.secretKey())));
        this.s3 = b.build();
        this.bucket = c.bucket();
        this.prefix = c.prefix() == null ? "" : c.prefix();
    }

    private String key(String tenant, String id) { return prefix + tenant + "/" + id.replaceAll("[^A-Za-z0-9_.-]", "_"); }

    @Override public void put(String tenant, String id, byte[] bytes, String mime) {
        s3.putObject(PutObjectRequest.builder().bucket(bucket).key(key(tenant, id)).contentType(mime).build(), RequestBody.fromBytes(bytes));
    }

    @Override public Optional<StoredFile> get(String tenant, String id) {
        try {
            ResponseBytes<GetObjectResponse> r = s3.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key(tenant, id)).build());
            return Optional.of(new StoredFile(r.asByteArray(), r.response().contentType()));
        } catch (NoSuchKeyException e) { return Optional.empty(); }
    }

    @Override public void delete(String tenant, String id) {
        s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key(tenant, id)).build());
    }

    @Override public String name() { return "s3"; }
}

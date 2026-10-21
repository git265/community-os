# External integrations: what they are, how they are isolated, how to set up, how to switch

**Rule:** no screen and no business rule names a vendor. Each outside system sits behind one interface (a *port*); one small class per vendor implements it;
the vendor is chosen by a setting. Switching vendor = change the setting (and, for a vendor we have no class for yet, write one class).

| # | Integration | Browser-side seam | Server-side port | Chosen by | Shipped choices |
|---|---|---|---|---|---|
| 1 | Database | `StorageAdapter` (`lib/storage`) | `DocumentRepository` | Data source chip · `STORAGE_PROVIDER` | browser session · PostgreSQL · in-memory |
| 2 | File storage (photos, PDFs) | `ApiStorageAdapter` sends bytes to the API; `ObjectStore` (`lib/files/objectStore.js`) for signed-URL stores | `FileStorage` | `FILES_PROVIDER` | local disk · S3-compatible (AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces, Wasabi, Backblaze B2) |
| 3 | E-mail | (none: the UI only queues rows in the outbox) | `OutboundChannel` “Email” | `EMAIL_PROVIDER` | log · SMTP (SES, SendGrid, Mailgun, Postmark, Office 365, Gmail … any SMTP) |
| 4 | SMS | same | `OutboundChannel` “SMS” | `SMS_PROVIDER` | log · generic HTTP (Twilio, MSG91, Kaleyra, Gupshup …) |
| 5 | WhatsApp | same | `OutboundChannel` “WhatsApp” | `WHATSAPP_PROVIDER` | log · generic HTTP (Meta Cloud API, Gupshup, Twilio …) |
| 6 | Online payments | `PaymentGateway` / `registerGateway` (`lib/payments`) | `PaymentProvider` | `PAYMENT_PROVIDER` | simulated (Razorpay/Stripe = one class) |
| 7 | GST data | `gstGateway()` (`lib/finance/gstGateway.js`) | `GstProvider` | `GST_PROVIDER` · Input credit → GST connection | simulated (a GSP = one class) |
| 8 | Sign-in / SSO | `dataSource.token` (see BACKEND.md §5) | Spring Security resource server | `SECURITY_MODE` | none · api-key · any OpenID Connect provider |
| 9 | Map tiles & place search | `BASES` in `lib/infra/geo.js`; per-plan own tile URL | – | Site map → Street/Satellite/Own tiles | OpenStreetMap · Esri · your own (Mapbox, MapTiler, Google) |
| 10 | Virus scan of uploads | `scanRemote()` in `lib/files/fileValidation.js` | (your scanner) | `VITE_SCAN_URL` | local checks only unless set |
| 11 | MyGate | file import only (no connection) | – | – | see MYGATE_MIGRATION.md |

All server settings live in `backend/api/src/main/resources/application.yml` as `${COS_*:default}` (dev overrides in `application-dev.yml`); `backend/.env.example` lists what docker compose passes. The server-side columns of the table above describe the retired r76 servers; `docs/REDESIGN.md` section 11 has the current list.
**Secrets (keys, passwords) go in environment variables or your secret manager, never in the browser, never in git.** The browser holds no provider key.

---------------------------------------------------------------------------------------------------------------------------------

## 1. Database
**Now:** PostgreSQL 13+ (16 recommended), one `documents` table, record in JSONB. **Set up:** create a database and a user, set `DB_URL`, `DB_USER`, `DB_PASSWORD`; the service creates the table on start (Flyway).
```
CREATE DATABASE communityos; CREATE USER communityos WITH PASSWORD '...'; GRANT ALL ON DATABASE communityos TO communityos;
-- PostgreSQL 15+: also  \c communityos  then  GRANT ALL ON SCHEMA public TO communityos;
```
Managed options (RDS, Cloud SQL, Azure Database, Supabase, Neon) work with only the URL changed. Back up with `pg_dump`; the UI’s **Back end → Browser** copy is not a backup.
**Switch to another database:** write `XxxDocumentRepository implements DocumentRepository` (list, get, upsert (merge), upsertAll, delete, replaceAll, query, tenants, deleteTenant, ping), add `case "xxx"` in `ProvidersConfig.documentRepository`, set `STORAGE_PROVIDER=xxx`.
The `InMemoryDocumentRepository` is the smallest worked example and is checked against the same query cases. **UI side: nothing changes.**

## 2. File storage (S3 or other)
**Now:** bytes go `browser → API → FileStorage`; only a small metadata row (name, size, mime, scan status) is in the database. Direct browser-to-bucket uploads (presigned URLs) are supported by the UI’s `SignedUrlStore` for later, when files are large.
* **Local disk** (default): `FILES_LOCAL_DIR=/data/files`. Fine for one server; mount a persistent volume. Not for several servers.
* **Amazon S3**
  1. Create a private bucket (block all public access), e.g. `my-society-files`, region `ap-south-1`.
  2. Create an IAM user/role with only this policy (replace the bucket):
     `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::my-society-files/communityos/*"}]}`
  3. Set `FILES_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION`. On AWS (EC2/ECS/EKS) leave `S3_ACCESS_KEY/SECRET_KEY` empty and attach the role; elsewhere set the two keys.
  4. Optional: turn on bucket versioning and a lifecycle rule. No CORS needed (the browser never talks to the bucket).
* **MinIO / Cloudflare R2 / DigitalOcean Spaces / Wasabi / Backblaze B2** (same class): set `S3_ENDPOINT` (MinIO `http://minio:9000`; R2 `https://<account>.r2.cloudflarestorage.com`; Spaces `https://blr1.digitaloceanspaces.com`), `S3_PATH_STYLE=true` for MinIO, the keys, the bucket. `docker compose --profile s3 up` gives a local MinIO.
* **Azure Blob Storage** (write one class; not shipped). Add `com.azure:azure-storage-blob` to `pom.xml`, then:
  ```java
  public class AzureBlobFileStorage implements FileStorage {
      private final BlobContainerClient c;
      public AzureBlobFileStorage(String connectionString, String container) {
          c = new BlobServiceClientBuilder().connectionString(connectionString).buildClient().getBlobContainerClient(container);
      }
      private BlobClient blob(String t, String id) { return c.getBlobClient(t + "/" + id.replaceAll("[^A-Za-z0-9_.-]", "_")); }
      public void put(String t, String id, byte[] b, String mime) {
          blob(t, id).upload(BinaryData.fromBytes(b), true);
          blob(t, id).setHttpHeaders(new BlobHttpHeaders().setContentType(mime));
      }
      public Optional<StoredFile> get(String t, String id) {
          BlobClient bc = blob(t, id); if (!bc.exists()) return Optional.empty();
          return Optional.of(new StoredFile(bc.downloadContent().toBytes(), bc.getProperties().getContentType()));
      }
      public void delete(String t, String id) { blob(t, id).deleteIfExists(); }
      public String name() { return "azure-blob"; }
  }
  ```
  Add `case "azure" -> new AzureBlobFileStorage(...)` in `ProvidersConfig.fileStorage` and read the connection string from a new `app.files.azure.*` block. (Sketch, not compiled.)
**Moving existing files between stores:** copy objects with the vendor’s tool (`aws s3 sync`, `azcopy`, `rclone`) keeping the key layout `<prefix><community>/<fileId>`; no database change is needed because rows hold only the file id.

## 3. E-mail
**How it flows:** the UI writes a row to `notificationOutbox` (status “Queued …”). With `OUTBOX_ENABLED=true` on **one** instance, `OutboxDispatcher` sends queued/failed rows every `OUTBOX_POLL_MS`, marks them Sent or “Failed – will retry”. Default provider `log` only writes to the log.
**SMTP setup (any provider):** `EMAIL_PROVIDER=smtp`, `EMAIL_FROM` (an address on a verified domain), `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS, 465 SSL), `SMTP_USER`, `SMTP_PASSWORD`.
| Provider | Host | Notes |
|---|---|---|
| Amazon SES | `email-smtp.<region>.amazonaws.com` | create SMTP credentials in the SES console; verify the domain (SPF/DKIM); leave the sandbox |
| SendGrid | `smtp.sendgrid.net` | user is the word `apikey`, password is the API key |
| Mailgun | `smtp.mailgun.org` | per-domain SMTP credentials |
| Office 365 / Gmail | `smtp.office365.com` / `smtp.gmail.com` | app password or OAuth; low daily limits, fine for small societies |
| Local test | Mailpit `localhost:1025`, `SMTP_AUTH=false SMTP_STARTTLS=false` | `docker compose --profile mail up`; read mail at :8025 |
Switch provider = change the five variables. **Without SMTP** (a vendor with only an HTTP API): add `XxxEmailChannel implements OutboundChannel` and a `case` in `ProvidersConfig.emailChannel`.

## 4. SMS and 5. WhatsApp
Both use the generic `HttpChannel`: one HTTP request per message with your URL, an `Authorization` header and a JSON body template using `{to}`, `{text}`, `{subject}`, `{name}`.
```
SMS_PROVIDER=http  SMS_URL=https://api.example-sms.com/send  SMS_AUTH_HEADER="Bearer <token>"
APP_CHANNELS_SMS_HTTP_BODYTEMPLATE={"to":"{to}","message":"{text}","sender":"MYSOC"}
```
Map your vendor’s documented request into the template (Twilio and some others need form encoding or Basic auth with a computed header: use a ready `Basic base64(sid:token)` value in `*_AUTH_HEADER`, or add a small class). **Indian regulation:** SMS needs a registered sender ID and DLT-approved templates; WhatsApp business messages need an approved template. These are paperwork with the vendor, not code.
Switch vendor = new URL, header and template. Messages are only sent to rows whose recipient chose that channel (the UI already enforces opt-in).

## 6. Online payments
UI flow is fixed and provider-neutral (`PaymentGateway`): create order (server prices it) → provider checkout → signed webhook → status `Paid` → app settles dues.
Shipped: `simulated` (HMAC-signed like the real ones). **Add Razorpay:** `RazorpayPaymentProvider implements PaymentProvider` using `com.razorpay:razorpay-java`:
`createOrder` → `client.orders.create({amount, currency, receipt})` returns the `id` (providerOrderId); `publicKey` = your Key Id; `verifyWebhook` → `Utils.verifyWebhookSignature(body, header "x-razorpay-signature", secret)`;
`parseWebhook` → map `payment.captured`→Paid, `payment.failed`→Failed; `refund` → `client.payments.refund`. Add `case "razorpay"`; set `PAYMENT_PROVIDER=razorpay` and the keys. In the browser register `new SpringGateway({ id:'razorpay', name:'Razorpay', sdk })` where `sdk` opens Razorpay Checkout (`lib/payments/SpringGateway.js`).
**Stripe:** same, `PaymentIntent` instead of an order. **Go-live:** `PAYMENT_TRUST_CLIENT_AMOUNT=false` and set `app.payments.pricing` (e.g. `due: dues:balance`) so the server computes the amount from the records. Register the webhook URL `https://<host>/api/payments/webhook/<provider>` in the provider dashboard.
Money legalities (KYC, settlement account, GST on fees) are between the society and the provider.

## 7. GST data
Needs a GST Suvidha Provider account and the society’s authorisation (docs/GST_API.md). Server: implement `GstProvider` for your GSP (`lookupGstin`, `lookupInvoice`, `health`), add `case`, set `GST_PROVIDER`. UI: Billing → Input credit → GST connection → Live, address `/api`.

## 8. Sign-in (real sign-in, Keycloak-ready)

**Two providers, one contract.** `AUTH_PROVIDER=local` (default) signs people in with a one-time code to their phone and issues the tokens itself. `AUTH_PROVIDER=oidc` hands sign-in to an identity provider (Keycloak, Auth0, Entra ID, Cognito) with Authorization Code + PKCE and only *verifies* its tokens. The app depends on the token and nothing else, so switching is configuration.

### The claims contract (what the app needs from ANY token)
| Claim | Meaning |
|---|---|
| `sub` | the person's stable identity id. Matched to `users.authSubject`; if not set, to phone, then e-mail (`OIDC_USER_MATCH=subject,phone,email`). |
| `community` (name set by `JWT_TENANT_CLAIM`) | a **list** of community slugs the person may enter, e.g. `["la-paloma","green-acres"]`; `["*"]` for the platform admin. A single text is accepted too. |
| `role` | optional hint only. **The role is never trusted from the token**: it is read from the `users` table (and `roles`) of the community being entered, so offices change roles in the app, not in the identity provider. |
| `phone_number` / `email` | used for matching when `sub` is not yet linked. |

**First sign-in rule.** An identity with no row in `users` for that community is told "contact the office" and is **never created automatically**. The office adds the person (or sends an invitation); the first successful sign-in links `users.authSubject` to the token's `sub`.
A person with several roles (or several communities) is asked to choose after signing in; switching is `POST /api/auth/switch-role`.

### Keycloak setup (about 15 minutes)
1. **Realm** `communityos`. Enable "User registration" off (the office controls who may enter).
2. **Client** `communityos-web`: public client, Standard flow on, **PKCE (S256) required**. Valid redirect URIs `https://<app-host>/*`; web origins `https://<app-host>`.
3. **Sign-in by phone or e-mail code** (choose one): install an SMS-OTP authenticator (or use the e-mail OTP / magic-link flow) in the browser flow; or keep Keycloak's own e-mail + password if you prefer.
4. **Mappers** on the client (or a shared client scope), all "Add to access token":
   * *User Attribute* `phone` → claim `phone_number` (string).
   * *User Attribute* `email` → claim `email`.
   * *User Attribute* **multivalued** `communities` → claim `community` (JSON array of strings). Alternatively a *Group Membership* mapper with full path off, one group per community slug.
   * *Audience* mapper adding `communityos-api` (set `OIDC_AUDIENCE=communityos-api`).
5. **Server (Node stand-in):** `AUTH_MODE=enforce AUTH_PROVIDER=oidc OIDC_ISSUER_URI=https://<kc>/realms/communityos OIDC_AUDIENCE=communityos-api`. The server fetches the realm's signing keys from `<issuer>/.well-known/openid-configuration` (RS256).
   **Server (Spring):** `SPRING_PROFILES_ACTIVE=jwt JWT_ISSUER_URI=https://<kc>/realms/communityos JWT_TENANT_CLAIM=community`.
6. **Browser:** `VITE_AUTH_PROVIDER=oidc` is not needed; the app asks `GET /api/auth/config` and the server answers with the provider, issuer and client id (`OIDC_CLIENT_ID=communityos-web`).
7. **Production guards.** With `NODE_ENV=production` the server refuses to start if `DEMO_ROSTER=true`, if `OTP_DELIVERY=echo`, if `AUTH_MODE` is not `enforce`, or (local provider) if `JWT_SECRET` is missing, or if the payment provider is the simulator.

### Environment reference
`AUTH_MODE` (open|enforce) · `AUTH_PROVIDER` (local|oidc) · `JWT_SECRET` · `JWT_ISSUER` · `ACCESS_TOKEN_MINUTES` (15) · `REFRESH_TOKEN_DAYS` (7) · `OTP_DELIVERY` (echo|log; a real SMS provider is to be plugged in) · `OTP_MINUTES` (5) · `OTP_TRIES` (3) · `OTP_RESEND_SECONDS` (20) · `OTP_PER_PHONE_HOUR` (5) · `OTP_PER_IP_HOUR` (30) · `LOCK_AFTER_FAILURES` (5) · `LOCK_MINUTES` (15) · `OIDC_ISSUER_URI` · `OIDC_AUDIENCE` · `OIDC_CLIENT_ID` · `OIDC_USER_MATCH` · `JWT_TENANT_CLAIM` · `DEMO_ROSTER` (never in production) · `COOKIE_SECURE` · `CORS_ORIGIN` · `PAYMENT_PROVIDER` · `PAYMENT_WEBHOOK_SECRET` · `PAYMENT_ORDER_MINUTES` (30) · `PAYMENT_RECONCILE_SECONDS` · `PAYMENT_PENDING_RECHECK_SECONDS` · `JOBS_INTERVAL_SECONDS` (300; 0 = off) · `ALLOW_TENANT_RESET` (keep false).

## 9. Maps
Free OpenStreetMap and Esri tiles suit trials, not heavy use (their usage policies forbid bulk/commercial load). For daily use set an own tile address (MapTiler, Mapbox, Google, or your own server) per plan: Site map → Own tiles. The place search uses OSM Nominatim (1 request/second policy); replace the URL in `LiveMap.jsx` with your geocoder if needed.

## 10. Virus scanning
Uploads get type/signature/size/active-content checks in the browser. For a real scanner set `VITE_SCAN_URL` to a service (for example ClamAV behind a small HTTP wrapper) that accepts the file and answers `{clean:true|false}` (see `fileValidation.js`). Do this check on the server too before go-live.

## Switching checklist (any vendor)
1. Create the account / resource at the vendor; note keys.
2. Put keys in the secret store as environment variables (names above).
3. Change the `*_PROVIDER` variable (and the vendor’s own variables).
4. Restart the service; open the UI’s Data source panel → **Test connection**: the “providers” line must show the new choice.
5. Do one real action (upload a file, send a test notification, a test payment) and check it at the vendor.
6. Keep the old vendor’s credentials for a week for rollback; changing the variable back is the rollback.

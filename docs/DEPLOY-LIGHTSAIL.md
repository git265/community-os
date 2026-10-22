# Running CommunityOS on AWS Lightsail

One Lightsail server runs the whole app: the docker-compose stack of `backend/` plus HTTPS (Caddy, free Let's Encrypt certificate),
with only ports 80 and 443 open to the internet. About **$24 a month** (4 GB plan, Mumbai) plus a few dollars for snapshots and a bucket.

| File | What it is |
|---|---|
| `backend/docker-compose.prod.yml` | Added on top of `docker-compose.yml`: Caddy in front, no other port published, restarts, the production settings |
| `backend/Caddyfile` | HTTPS for your domain |
| `backend/Caddyfile.trial` | The same, with the whole site behind one shared login (for a trial with the sample data) |
| `backend/tools/backup.sh` / `restore.sh` | The database and the uploaded files, out and back in |

Every command below runs on the server, from the `backend` folder, unless it says otherwise. To save typing:

```sh
alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml'
```

## What you need first
- An AWS account, and a domain name you can add a DNS record to (e.g. `portal.lapaloma.in`).
- **For real use (the `prod` profile):** an SMS provider to send the sign-in codes. In India that means DLT registration of the sender
  and the code template, which can take a few days - start it early. The server posts `{template_id, sender, to, variables: {otp}}`
  with `Authorization: Bearer <key>`; if your provider expects another shape, the sender (`HttpSmsOtpSender`) needs a small change.
- Optional: Razorpay keys for online payments. Without them, payments are recorded at the office only.

You can start with a **trial** (the `dev` profile with the sample data, behind one login) while the SMS registration is pending, then
switch the same server to **live**.

## 1. Create the server
1. Lightsail console → **Create instance**.
2. Region **Mumbai (ap-south-1)**. Platform **Linux/Unix**, blueprint **OS Only → Ubuntu 24.04 LTS**.
3. Plan **4 GB RAM, 2 vCPUs, 80 GB SSD** (the dual-stack plan, with a public IPv4 address). Smaller plans do not fit the API, PostgreSQL
   and the virus scanner together.
4. Name it (e.g. `communityos`) → **Create instance**.
5. **Networking** tab:
   - **Create static IP** and attach it to the instance (free while attached), so the address never changes.
   - IPv4 firewall: keep SSH (22) and HTTP (80), **add HTTPS (443)**. Nothing else - the database and the API are not reachable from outside.
6. At your domain's DNS: an **A record** for `portal.lapaloma.in` → the static IP. Check it before step 4: `nslookup portal.lapaloma.in`.

## 2. Prepare the server
Connect with **Connect using SSH** in the console (or `ssh ubuntu@<static IP>` with the instance's key), then:

```sh
sudo apt-get update && sudo apt-get -y upgrade
sudo timedatectl set-timezone Asia/Kolkata

# 2 GB of swap: building the app needs more memory than running it
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker and the compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit        # and connect again, so the docker group applies
```

## 3. Get the code and set it up
```sh
git clone https://github.com/git265/community-os.git      # a private repository asks for your GitHub user and a token with read access
cd community-os/backend
cp .env.example .env
```

Make the secrets (run each, paste the answer into `.env`):

```sh
openssl rand -hex 24          # COS_DB_OWNER_PASSWORD, then again for COS_DB_APP_PASSWORD and COS_DB_PLATFORM_PASSWORD
openssl rand -hex 32          # COS_OTP_PEPPER   (never change it once people sign in)
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt | grep -v -- ----- | tr -d '\n'; echo
                              # COS_JWT_SIGNING_KEY  (one line)
docker run --rm node:22-alpine npx -y web-push generate-vapid-keys
                              # COS_PUSH_VAPID_PUBLIC_KEY and COS_PUSH_VAPID_PRIVATE_KEY
```

Then edit `.env` (`nano .env`). Lines to set, uncommented:

```sh
COS_DOMAIN=portal.lapaloma.in
COS_DB_OWNER_PASSWORD=...
COS_DB_APP_PASSWORD=...
COS_DB_PLATFORM_PASSWORD=...
COS_JWT_SIGNING_KEY=...
COS_OTP_PEPPER=...
COS_PUSH_VAPID_PUBLIC_KEY=...
COS_PUSH_VAPID_PRIVATE_KEY=...
COS_PUSH_SUBJECT=mailto:you@lapaloma.in
SEED_ADMIN_PHONE=+91XXXXXXXXXX      # the real Super Admin's mobile: the first sign-in
SEED_ADMIN_NAME=Your Name
```

`.env` holds every secret: keep it only on the server (`chmod 600 .env`; git ignores it) and keep a copy in a password manager.

### Trial (sample data, before SMS is ready)
```sh
SPRING_PROFILES_ACTIVE=dev
CADDYFILE=Caddyfile.trial
TRIAL_USER=trial
TRIAL_HASH='...'                  # in single quotes; from: docker run --rm caddy:2.8 caddy hash-password --plaintext 'a long password'
```
The dev profile lets anyone sign in as anyone from the demo roster, and its payments are simulated. That is why the whole site sits
behind the trial login. Do not put real residents' data into a trial.

### Live
```sh
SPRING_PROFILES_ACTIVE=prod
COS_SMS_ENDPOINT=https://...      # your SMS provider
COS_SMS_API_KEY=...
COS_SMS_TEMPLATE=...              # the DLT template id
COS_SMS_SENDER=...                # the DLT sender id
# online payments, optional:
COS_RAZORPAY_ENABLED=true
COS_RAZORPAY_KEY_ID=...
COS_RAZORPAY_KEY_SECRET=...
COS_RAZORPAY_WEBHOOK_SECRET=...   # Razorpay dashboard → Webhooks: https://portal.lapaloma.in/api/v1/webhooks/razorpay
```
`prod` refuses to start if a secret is missing or a simulation is switched on; the API's log says which.

## 4. Start it
```sh
dc up -d --build                  # trial with the sample data: dc --profile demo up -d --build
dc ps                             # all "running" or "healthy"; seed (and demo) "exited (0)"
dc logs -f api                    # Ctrl-C to stop watching
```
The first build takes 10-15 minutes; the virus scanner then downloads its signatures for a few minutes (uploads wait as "Pending" and
are scanned when it is ready). Caddy gets the certificate within a minute of the DNS name resolving to the server: `dc logs caddy`.

Open **https://portal.lapaloma.in**.
- Trial: enter the trial login, then pick anyone from the demo roster.
- Live: sign in with `SEED_ADMIN_PHONE`; the code arrives by SMS. Then add the units, owners and committee (Administration).

## 5. Bring the data you already have (optional)
On the computer that runs the app now (from its `backend` folder):

```sh
docker compose exec -T postgres pg_dump -U cos_owner -d communityos -Fc > db.dump
docker compose exec -T api tar -C /data -czf - files > files.tgz
scp db.dump files.tgz ubuntu@<static IP>:/home/ubuntu/
```

On the server:

```sh
tools/restore.sh /home/ubuntu/db.dump /home/ubuntu/files.tgz      # asks before replacing anything
```

The database passwords may differ between the two machines (logins are not in the backup). Data from a trial (sample data) should not
be carried into live use - start live on a fresh database instead.

## 6. Backups
1. **Snapshots:** instance → **Snapshots** → **Enable automatic snapshots** (daily, last 7 kept). Good for "the server broke"; useless if
   the account or the region has a problem, and they are a few dollars a month at this size.
2. **Nightly copies of the data, off the server:**
   - Lightsail → **Storage → Create bucket** (Mumbai, the smallest plan). In the bucket, **Permissions → Access keys → Create**.
   - On the server: `sudo snap install aws-cli --classic && aws configure` (the access key, its secret, region `ap-south-1`).
   - Put `BACKUP_BUCKET=<bucket name>` in `.env`, then test once and schedule it:
     ```sh
     sudo mkdir -p /var/backups/communityos && sudo chown ubuntu /var/backups/communityos
     tools/backup.sh                 # prints "backup ok: ..." and the bucket has two new files
     crontab -e      # add (every night at 2:00):
     0 2 * * * /home/ubuntu/community-os/backend/tools/backup.sh >> /home/ubuntu/backup.log 2>&1
     ```
3. Try a restore once (on a second, temporary instance) so you know it works before you need it.

## 7. Updating to a new version
```sh
cd ~/community-os && git pull
cd backend && dc up -d --build    # migrations run by themselves when the API starts
docker image prune -f             # frees the old images' space
```
Take a backup first (`tools/backup.sh`) when an update changes the database.

## 8. When something is wrong
| What you see | What to do |
|---|---|
| The browser says the certificate is invalid | The DNS record does not point at the static IP yet, or port 443 is closed in the Lightsail firewall. `dc logs caddy`, then `dc restart caddy` |
| The build stops with "killed" | Not enough memory: check the swap is on (`free -h`) |
| The API keeps restarting | `dc logs api` - under `prod` the first lines name the missing setting |
| Sign-in code never arrives (live) | `dc logs api \| grep -i sms`: the provider's answer is logged |
| Uploads stay "Pending" | The scanner is still starting (`dc logs clamav`); they are scanned when it is up |
| The disk fills up | `docker system df`, `docker image prune -f`; logs are capped at 500 MB (`backend/logs`) |

## What it costs (Mumbai)
| Item | About |
|---|---|
| 4 GB instance with static IP | $24 / month |
| Automatic snapshots | a few dollars / month |
| Bucket for backups | the smallest plan, a dollar or so / month |
| Domain | from your registrar |
| SMS | per message, from the provider |

Check the current prices on the Lightsail pricing page when you create them.

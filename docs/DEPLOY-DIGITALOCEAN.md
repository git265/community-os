# Running CommunityOS on DigitalOcean

One Droplet runs the whole app: the docker-compose stack of `backend/` plus HTTPS (Caddy, free Let's Encrypt certificate), with only
ports 22, 80 and 443 reachable. About **$24-28 a month** for a 4 GB Droplet in Bangalore, plus backups and a Spaces bucket.

The files it uses are the same as for Lightsail (docs/DEPLOY-LIGHTSAIL.md):

| File | What it is |
|---|---|
| `backend/docker-compose.prod.yml` | Added on top of `docker-compose.yml`: Caddy in front, no other port published, restarts, the production settings |
| `backend/Caddyfile` / `Caddyfile.trial` | HTTPS for your domain; the trial version puts the whole site behind one shared login |
| `backend/tools/backup.sh` / `restore.sh` | The database and the uploaded files, out and back in |

## What you need first
- A DigitalOcean account, and a domain name you can add a DNS record to (e.g. `portal.lapaloma.in`).
- **For real use (the `prod` profile):** an SMS provider for the sign-in codes. In India that needs DLT registration of the sender and
  the code template, which can take a few days - start it early. The server posts `{template_id, sender, to, variables: {otp}}` with
  `Authorization: Bearer <key>`; another provider's shape needs a small change in `HttpSmsOtpSender`.
- Optional: Razorpay keys for online payments.
- An SSH key on your computer (`ssh-keygen -t ed25519` if you have none; the public key is `~/.ssh/id_ed25519.pub`).

## 1. Create the Droplet
1. **Create → Droplets.**
2. Region **Bangalore (BLR1)**. Image **Ubuntu 24.04 (LTS) x64**.
3. Size: **Basic → Regular, 4 GB / 2 CPUs / 80 GB SSD**. Smaller sizes do not fit the API, PostgreSQL and the virus scanner together.
4. Authentication: **SSH Key → New SSH Key**, paste your public key. (Not a password.)
5. Turn on **Monitoring** (free). **Backups**: turn them on now (a share of the Droplet price; see step 6) or later.
6. Hostname `communityos` → **Create Droplet**.

## 2. Fixed address and firewall
1. **Networking → Reserved IPs → Assign** to the Droplet (free while assigned). Use this address from now on, so it never changes.
2. **Networking → Firewalls → Create Firewall** (`communityos-web`):
   - Inbound: **SSH 22**, **HTTP 80**, **HTTPS 443** - nothing else. (Use this Cloud Firewall rather than `ufw` on the Droplet:
     Docker opens published ports past `ufw`; the Cloud Firewall sits outside the Droplet.)
   - Outbound: leave as it is (all).
   - Apply to the Droplet `communityos`.
3. At your domain's DNS: an **A record** for `portal.lapaloma.in` → the reserved IP. Check it with `nslookup portal.lapaloma.in`.

## 3. Prepare the Droplet
From your computer: `ssh root@<reserved IP>`, then:

```sh
apt-get update && apt-get -y upgrade
timedatectl set-timezone Asia/Kolkata

# 2 GB of swap: building the app needs more memory than running it
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Docker and the compose plugin
curl -fsSL https://get.docker.com | sh

# a user for the app (not root), allowed to use Docker and to sign in with the same SSH key
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
exit
```

From now on: `ssh deploy@<reserved IP>`.

## 4. Get the code and set it up
```sh
git clone https://github.com/git265/community-os.git      # a private repository asks for your GitHub user and a token with read access
cd community-os/backend
cp .env.example .env && chmod 600 .env
alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml'   # used below; add it to ~/.bashrc to keep it
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

Edit `.env` (`nano .env`) and set, uncommented:

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

Keep a copy of `.env` in a password manager: it holds every secret, and git ignores it.

### Trial (sample data, before SMS is ready)
```sh
SPRING_PROFILES_ACTIVE=dev
CADDYFILE=Caddyfile.trial
TRIAL_USER=trial
TRIAL_HASH='...'                  # in single quotes; from: docker run --rm caddy:2.8 caddy hash-password --plaintext 'a long password'
```
The dev profile lets anyone sign in as anyone from the demo roster and simulates payments - so the whole site sits behind the trial
login. Do not put real residents' data into a trial.

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
`prod` refuses to start if a secret is missing or a simulation is on; the API's log says which.

## 5. Start it
```sh
dc up -d --build                  # trial with the sample data: dc --profile demo up -d --build
dc ps                             # all "running" or "healthy"; seed (and demo) "exited (0)"
dc logs -f api                    # Ctrl-C to stop watching
```
The first build takes 10-15 minutes; the virus scanner then downloads its signatures for a few minutes (uploads wait as "Pending" until
it is ready). Caddy gets the certificate within a minute of the domain resolving to the Droplet: `dc logs caddy`.

Open **https://portal.lapaloma.in**.
- Trial: the trial login, then anyone from the demo roster.
- Live: sign in with `SEED_ADMIN_PHONE`; the code comes by SMS. Then add the units, owners and committee (Administration).

## 6. Bring the data you already have (optional)
On the computer that runs the app now (in its `backend` folder):

```sh
docker compose exec -T postgres pg_dump -U cos_owner -d communityos -Fc > db.dump
docker compose exec -T api tar -C /data -czf - files > files.tgz
scp db.dump files.tgz deploy@<reserved IP>:/home/deploy/
```

On the Droplet:

```sh
tools/restore.sh /home/deploy/db.dump /home/deploy/files.tgz      # asks before replacing anything
```

The database passwords may differ between the machines (logins are not in the backup). Don't carry trial (sample) data into live use.

## 7. Backups
1. **Droplet backups:** Droplet → **Backups → Enable** (weekly or daily, priced as a share of the Droplet). They restore the whole
   server; they are lost with the account, so also:
2. **Nightly copies of the data, off the Droplet, in Spaces:**
   - **Create → Spaces Object Storage**, region **Bangalore (BLR1)** if offered (else the nearest), name e.g. `lapaloma-backups`,
     file listing **restricted**.
   - **API → Spaces Keys → Generate New Key** (access key and secret).
   - On the Droplet: `sudo snap install aws-cli --classic && aws configure` - the Spaces key, its secret, region `us-east-1`
     (Spaces ignores it; the endpoint below decides).
   - In `.env`: `BACKUP_BUCKET=lapaloma-backups` and `BACKUP_ENDPOINT=https://blr1.digitaloceanspaces.com` (your Space's region).
   - Test, then schedule:
     ```sh
     sudo mkdir -p /var/backups/communityos && sudo chown deploy /var/backups/communityos
     tools/backup.sh                 # prints "backup ok: ..." and the Space has two new files
     crontab -e      # add (every night at 2:00):
     0 2 * * * /home/deploy/community-os/backend/tools/backup.sh >> /home/deploy/backup.log 2>&1
     ```
3. Try a restore once, on a second, temporary Droplet, so you know it works before you need it.

## 8. Updating to a new version
```sh
cd ~/community-os && git pull
cd backend && tools/backup.sh && dc up -d --build    # migrations run by themselves when the API starts
docker image prune -f                                # frees the old images' space
```

## 9. When something is wrong
| What you see | What to do |
|---|---|
| The browser says the certificate is invalid | The A record does not point at the reserved IP yet, or the Cloud Firewall lacks 443. `dc logs caddy`, then `dc restart caddy` |
| `ssh` refused after the firewall | The firewall needs SSH 22 inbound; the Droplet's **Access → Recovery Console** works without it |
| The build stops with "killed" | Not enough memory: check the swap is on (`free -h`) |
| The API keeps restarting | `dc logs api` - under `prod` the first lines name the missing setting |
| Sign-in code never arrives (live) | `dc logs api \| grep -i sms`: the provider's answer is logged |
| Uploads stay "Pending" | The scanner is still starting (`dc logs clamav`); they are scanned when it is up |
| The disk fills up | `docker system df`, `docker image prune -f`; the API's logs are capped at 500 MB (`backend/logs`) |

## What it costs (Bangalore)
| Item | About |
|---|---|
| Basic Droplet, 4 GB / 2 CPUs | $24-28 / month |
| Reserved IP (assigned) | free |
| Droplet backups | a share of the Droplet price |
| Spaces (250 GB included) | about $5 / month |
| Domain, SMS | from your registrar / provider |

Check the current prices in the DigitalOcean control panel when you create them.

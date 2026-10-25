# Production Deployment — agiolab.com

Operational runbook for the production stack. The public TLS edge is the
**host nginx**; there is no Caddy container in production. Client-facing
integration details are in
[secrets-manager-client-guide.md](secrets-manager-client-guide.md).

---

## 1. Final domain and port mapping

| Public name | Public URL | Public port | Edge | Backend |
|---|---|---|---|---|
| **`agiolab.com`** | <https://agiolab.com> | TCP 443 | host nginx → `127.0.0.1:18000` | Next.js password generator (canonical) |
| `password.agiolab.com` | <https://password.agiolab.com> | TCP 443 | host nginx → `127.0.0.1:18000` | password generator alias |
| `www.agiolab.com` | <https://www.agiolab.com> → `https://agiolab.com` | TCP 443 | host nginx redirect | alias |
| `secrets.agiolab.com` | <https://secrets.agiolab.com> | TCP 443 | host nginx → `127.0.0.1:18001` | AWS-compatible Secrets Manager |

Both names resolve to the production host. Host nginx selects the backend by
`server_name` and preserves the exact `Host` header and path, so AWS SigV4
remains valid. HTTP on port 80 redirects to HTTPS.

### Host ports (identical for dev and prd)

| Port | Scope | Purpose |
|---|---|---|
| **80/tcp** | public (host nginx) | HTTP → HTTPS redirect / ACME |
| **443/tcp** | public (host nginx) | HTTPS TLS edge |
| **18000** | loopback only | App host port (container 3000) |
| **18001** | loopback only | Secrets Manager host port (container 8080) |
| **18002** | loopback only | Node debug port (dev only) |

The app and Secrets Manager are published on `127.0.0.1` only. Host nginx is
outside Docker Compose. Ports 80/443 are shared with the host's existing nginx
sites; the agiolab blocks are selected by `server_name`/SNI and do not affect
them.

> Dev and prd share 18000/18001/18002 and the public nginx ports by design, so
> **only one environment can run per host at a time**. `start.sh` refuses to
> start the second environment and tells you which one to stop.

---

## 2. DNS

Create these records at the DNS provider for `agiolab.com`:

```text
agiolab.com.            A     <production-host-ip>
agiolab.com.            AAAA  <production-host-ipv6>   # if IPv6 is used
www.agiolab.com.        A     <production-host-ip>
www.agiolab.com.        AAAA  <production-host-ipv6>   # if IPv6 is used
password.agiolab.com.   A     <production-host-ip>
password.agiolab.com.   AAAA  <production-host-ipv6>   # if IPv6 is used
secrets.agiolab.com.    A     <production-host-ip>
secrets.agiolab.com.    AAAA  <production-host-ipv6>   # if IPv6 is used
```

The previous discovery run found `password.agiolab.com` pointing at
`80.65.211.200` and **no A/AAAA record for `secrets.agiolab.com`**. Confirm the
former is the production host and create the latter before issuing the client
URL.

---

## 3. Firewall

Inbound:

| Port | Source | Purpose |
|---|---|---|
| 80/tcp | the internet or client networks | HTTP→HTTPS redirect, certificate validation |
| 443/tcp | the internet or client networks | Public HTTPS (host nginx) |
| 22/tcp | operations only | SSH/administration |

Do **not** open 18000, 18001 or 18002; they are loopback-only. Outbound: DNS,
NTP, container registry access during deployment, and certificate renewal
traffic.

---

## 4. Host nginx configuration

The site config is in the repository:

- [`deploy/nginx/agiolab.conf`](../deploy/nginx/agiolab.conf)
- [`deploy/nginx/README.md`](../deploy/nginx/README.md)

On a fresh host, issue the certificate before installing the TLS config:

```bash
sudo install -d -m 755 /var/www/html/.well-known/acme-challenge
sudo chown -R www-data:www-data /var/www/html

sudo cp deploy/nginx/agiolab-acme.conf /etc/nginx/conf.d/agiolab-acme.conf
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/html \
  -d agiolab.com -d www.agiolab.com \
  -d password.agiolab.com -d secrets.agiolab.com \
  --cert-name agiolab.com \
  --non-interactive --agree-tos --email admin@agiolab.com \
  --deploy-hook "systemctl reload nginx"

sudo rm /etc/nginx/conf.d/agiolab-acme.conf
sudo cp deploy/nginx/agiolab.conf /etc/nginx/conf.d/agiolab.conf
sudo nginx -t
sudo systemctl reload nginx
```

All four DNS names must already resolve to this host. The bootstrap and full config
serve the ACME challenge from `/var/www/html`, so renewals continue to work.

If you already have a certificate covering all names (SAN or wildcard
`*.agiolab.com`), skip certbot and point the `ssl_certificate` paths at it.
The certificate must cover **all four** names. If separate certificates are used,
split the two server blocks and point each to its own files. Certificate renewal
is handled by the host's tooling (for example the certbot timer).

The important proxy directives are already in the template:

```nginx
proxy_pass http://127.0.0.1:18000;   # app
# or
proxy_pass http://127.0.0.1:18001;   # secrets manager

proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

`Host $http_host` is mandatory for SigV4: the Secrets Manager verifies the
signed `Host` header and path. The proxy must not rewrite either.

---

## 5. Configuration

The local environment files are git-ignored. On a clean production checkout,
copy **both** `.env.dev` and `.env.prd` from the protected source (the current
parity gate requires `.env.example`, `.env.dev` and `.env.prd`); `.env.dev` is
not used by the prd stack. Verify with `sha256sum`, then:

```bash
sudo install -m 600 .env.dev .env.prd /opt/agiolab/tools-password-generator/
cd /opt/agiolab/tools-password-generator
./bin/check-env-parity.sh
./bin/start.sh check-env
```

Relevant `.env.prd` values:

```dotenv
APP_HOST=agiolab.com
SECRETS_MANAGER_HOST=secrets.agiolab.com
APP_PUBLIC_URL=https://agiolab.com
SECRETS_MANAGER_PUBLIC_URL=https://secrets.agiolab.com
PUBLIC_HTTPS_PORT=443

APP_BIND_ADDRESS=127.0.0.1
APP_PORT=18000
SECRETS_MANAGER_BIND_ADDRESS=127.0.0.1
SECRETS_MANAGER_PORT=18001
```

The environment files are line-aligned with `.env.example` (33 keys):

```bash
./bin/check-env-parity.sh
# env-parity: .env.example .env.dev .env.prd: 33 keys, line-aligned, ...
```

Rotate the Secrets Manager access key/secret for production and keep `.env.prd`
mode `600`. The app and Secrets Manager bind to loopback; host nginx is the only
public listener.

### Client credentials

The primary `SECRETS_MANAGER_ACCESS_KEY_ID` remains the full-access instance
credential used by the password generator. There are two ways to issue scoped
client credentials:

1. **Static bootstrap (`SM_CLIENTS_JSON`).** Entries are read at boot and are
   read-only through the API — edit the env file and recreate the container to
   change them. This is the break-glass/initial-onboarding path:

   ```dotenv
   SM_CLIENTS_JSON='[{"name":"acb","accessKeyId":"acb-prd-access","secretAccessKey":"<64-hex>","sessionToken":"","description":"ACB production client","allowedPrefixes":["client/acb/"]}]'
   ```

2. **Managed by the server (recommended for new clients).** Create credentials
   through the admin-only `CreateClientCredential` operation, or with the
   control script. They are stored encrypted in the data volume, survive
   restarts, and are included in backups:

   ```bash
   ./bin/start.sh credentials prd list
   ./bin/start.sh credentials prd create acme \
     --description "ACME billing integration" \
     --prefixes client/acme/
   ./bin/start.sh credentials prd show acme
   ./bin/start.sh credentials prd delete acme --yes
   ```

   `create` prints the generated secret (and the client's `*_SECRETS_AWS_*`
   variables) on stdout; `list` prints metadata only. `--description` is
   optional and may be up to 512 characters. If `--prefixes` is omitted, the
   prefix defaults to `client/<name>/`. `--access-key-id` pins an id; otherwise
   a random `AKIA…` id is generated.

Each client can only list, read, write, tag, delete or restore secrets whose
names start with one of its `allowedPrefixes`. The password generator's
`password-generator/...` secrets are not visible to the client. A managed
client is always non-admin: it receives `AccessDeniedException` for the four
`*ClientCredential` operations, so it cannot mint or inspect credentials.

Credential management is also **server-local**: the four `*ClientCredential`
operations are served only on the Secrets Manager container's loopback admin
listener (`127.0.0.1:8081` inside the container) and are rejected by the public
listener and the public nginx edge. `./bin/start.sh credentials …` uses that
listener automatically. The application itself uses an auto-generated, scoped,
read-only credential (managed by `./bin/start.sh` in `.run/`); it cannot mint
or modify credentials. To deploy this change without breaking existing clients:

```bash
# 1. Block credential management on the public edge (no client impact):
sudo cp deploy/nginx/agiolab.conf /etc/nginx/conf.d/agiolab.conf
sudo nginx -t && sudo systemctl reload nginx
# 2. Rebuild and recreate the stack (brief restart):
./bin/start.sh up prd
# 3. Verify:
./bin/start.sh secrets prd verify
```

Static changes still require a recreate:

```bash
./bin/start.sh recreate prd
```

Use a distinct access key and secret for dev and prd. Clients need the endpoint
(`https://secrets.agiolab.com` in prd) and `us-east-1`; session tokens are empty
because this service does not issue temporary STS credentials.

`./bin/start.sh credentials prd …` uses the running Secrets Manager for managed
clients. If the container is stopped, `list` and `show` fall back to the static
`SM_CLIENTS_JSON` entries and clearly say so. Treat every `show`/`create` output
as a secret and deliver it out of band. To revoke a managed client, delete it
(the key stops working immediately); to rotate, delete and create a replacement.
Because the registry lives in the encrypted data volume, take a volume backup
before bulk changes: `./bin/start.sh backup prd`.

---

## 6. Start, stop and status

```bash
# Start the Docker stack (app + secrets manager); host nginx is already running
./bin/start.sh up prd

# Health: internal, readiness, and public HTTPS through host nginx
./bin/start.sh health prd --strict

# Show public URLs, host-nginx state, compose status and volumes
./bin/start.sh status prd

# Logs
./bin/start.sh logs prd app
./bin/start.sh logs prd secrets-manager

# Stop (volumes and backups preserved)
./bin/start.sh down prd
```

`up prd` preflights host nginx:

- `nginx` must be installed and listening on `PUBLIC_HTTPS_PORT` (443),
- the enabled nginx configuration must contain `server_name` for both public
  names,
- after the app/Secrets Manager are healthy, `start.sh` waits for
  `https://password.agiolab.com/api/health` and
  `https://secrets.agiolab.com/healthz` through nginx.

If the nginx config is not installed, `up prd` fails before starting with
instructions. To diagnose:

```bash
./bin/start.sh doctor prd
sudo nginx -t
sudo systemctl status nginx
```

---

## 7. Verification

### 7.1 Public endpoints

```bash
curl -fsS https://agiolab.com/api/health
curl -fsS https://agiolab.com/api/ready
curl -fsS https://password.agiolab.com/api/health
curl -fsS -I https://www.agiolab.com/          # 301 to https://agiolab.com
curl -fsS https://secrets.agiolab.com/healthz
curl -fsS https://secrets.agiolab.com/readyz
```

Expected: HTTP 200 from the apex, password alias and Secrets Manager probes; `www` returns 301 to the apex.

### 7.2 AWS protocol through host nginx

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
export AWS_PAGER=""

aws --endpoint-url https://secrets.agiolab.com secretsmanager list-secrets
```

SigV4 signs `Host: secrets.agiolab.com` and the path. nginx must forward both
unchanged; `deploy/nginx/agiolab.conf` uses `$http_host` for this reason.

The verifier can use the public endpoint on the host:

```bash
SM_ENDPOINT=https://secrets.agiolab.com \
  ./bin/verify-secrets-manager.sh --env prd
```

The default verifier uses loopback `18001`; both hit the same service.

### 7.3 UI

```bash
curl -fsS https://agiolab.com/ | grep -o '<title>[^<]*'
```

The title should contain “Secure Password Generator”.

For a complete host/nginx/Docker/DNS/TLS inventory, use the generic discovery
script; the repository-specific command is in
[deploy-discovery.md](deploy-discovery.md).

---

## 8. Backups

```bash
./bin/start.sh backup prd
./bin/start.sh backups prd verify
```

The full-volume `.tar.gz` backup includes the encrypted Secrets Manager store:

- `passwordgenerator_prd_secrets_data`.

Host nginx certificates are managed by the host certificate tooling and are not
part of the Docker volume backup. Back them up through that tooling.

Restore:

```bash
./bin/start.sh restore prd backups/prd/<bundle>.tar.gz --yes
```

After a restore, start the app/Secrets Manager and verify the public endpoints
through host nginx.

---

## 9. Upgrades

Named volumes persist. Host nginx is **not** restarted by `start.sh`; its config
and certificates are managed separately — that is why step 4 below is manual.

### 9.1 Pre-flight (do not skip)

```bash
cd /path/to/tools-password-generator
git pull --ff-only
git log --oneline -2            # confirm the release you intend to ship
git status -sb                  # must be clean
python3 --version               # required by bin/ensure-app-credentials.py
```

`bin/start.sh` enforces `.env.example` ↔ `.env.dev` ↔ `.env.prd` parity on
**every** command. If `start.sh` aborts with `Environment parity check failed`,
add the missing keys to `.env.prd` before anything else. This release adds six:

```bash
APP_MEM_LIMIT=512m
APP_CPUS=1.0
APP_PIDS_LIMIT=256
SECRETS_MANAGER_MEM_LIMIT=256m
SECRETS_MANAGER_CPUS=0.5
SECRETS_MANAGER_PIDS_LIMIT=128
```

```bash
chmod 600 .env.prd
./bin/start.sh check-env prd
./bin/start.sh doctor prd
```

Only one environment runs per host (dev and prd share ports). Stop dev first:
`./bin/start.sh down dev`.

### 9.2 Backup and baseline

```bash
./bin/start.sh backup prd
./bin/start.sh backups list prd
curl -s https://secrets.agiolab.com/healthz
docker inspect --format '{{.Config.Image}} {{.Image}}' password_app_prd password_secrets_prd
sudo cp /etc/nginx/conf.d/agiolab.conf /root/agiolab.conf.bak.$(date +%F) 2>/dev/null || true
```

The bundle contains the store's `master.key`; it is `0600`, but still treat a
copy as a secret.

### 9.3 Deploy

```bash
./bin/start.sh rebuild prd
```

`rebuild` snapshots the images it is about to replace as
`<repo>:rollback-<UTC>` **before** building — that snapshot is your rollback
point. It then recreates, runs health checks and seeds any missing secrets.

### 9.4 Install the edge config (manual)

This release changes the edge: `X-Forwarded-For` is overwritten (not appended),
per-IP limits are added, and the four `*ClientCredential` targets are denied.

```bash
sudo cp deploy/nginx/agiolab.conf /etc/nginx/conf.d/agiolab.conf
sudo nginx -t && sudo systemctl reload nginx
```

### 9.5 Verify

```bash
./bin/start.sh health prd --strict
./bin/start.sh smoke prd
./bin/verify-secrets-manager.sh --env prd
```

The edge deny rule must be live for all four operations (expect `403` four
times — a `400` here means the service, not nginx, answered):

```bash
for op in CreateClientCredential GetClientCredential DeleteClientCredential ListClientCredentials; do
  printf '%-26s ' "$op"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://secrets.agiolab.com/ \
    -H "X-Amz-Target: secretsmanager.$op" \
    -H 'Content-Type: application/x-amz-json-1.1' -d '{}'
done
```

Data plane and app still answer:

```bash
curl -s https://secrets.agiolab.com/readyz          # {"status":"ready","ok":true,"version":"1.1.0"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://agiolab.com/api/generate \
  -H 'Content-Type: application/json' --data '{"mode":"words","wordCount":4}'
curl -s https://agiolab.com/api/health | grep -qE '/app/|/code/|"expected"|"actual"' \
  && echo 'LEAK' || echo 'health payload clean'
```

Then confirm both live clients: generate in the browser, and one
`GetSecretValue` from the integrating client.

### 9.6 Apply the new throttle value (optional)

The seeded policy for a new environment is 30 req/min; an existing secret keeps
its old value until rewritten.

```bash
./bin/start.sh secrets prd seed --force     # rewrites app-config from seed defaults
```

`--force` also resets any hand-tuned limits in that secret. If you customised
them, read the secret, edit `requestsPerMinute`, and write it back instead of
forcing.

### 9.7 Record the release

```bash
docker inspect --format '{{.Config.Image}} {{.Image}}' password_app_prd password_secrets_prd
curl -s https://secrets.agiolab.com/healthz
```

### 9.8 Rollback

```bash
./bin/start.sh rollback --list prd
./bin/start.sh rollback <stamp> prd
```

Rollback restores **images only** — it does not revert the nginx config and does
not touch data. If the edge is the problem, restore the saved config:

```bash
sudo cp /root/agiolab.conf.bak.<date> /etc/nginx/conf.d/agiolab.conf
sudo nginx -t && sudo systemctl reload nginx
```

Use `./bin/start.sh restore <bundle>` only for data loss, not for a bad deploy.

---

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| `up prd` says ports are in use | another environment is running; `./bin/start.sh down dev` (or `prd`) |
| `up prd` says host nginx is missing/not listening | install nginx; `systemctl status nginx`; `ss -ltnp` on 443 |
| `up prd` says server_name missing | install `deploy/nginx/agiolab.conf` and reload nginx |
| nginx `502` | app/Secrets Manager not running or loopback port wrong; `./bin/start.sh status prd` |
| nginx `504` | backend slow; check app/SM logs and `proxy_read_timeout` |
| Public HTTPS certificate error | certificate SAN covers both names; correct `ssl_certificate` paths; reload nginx |
| `InvalidSignatureException` | endpoint must be `https://secrets.agiolab.com`, region `us-east-1`, clock skew < 15 min; nginx must preserve `Host` and path |
| Client cannot connect | DNS points to the host; inbound TCP 443 open; client egress allows 443 |
| TLS certificate expired | renew via host tooling; reload nginx |

---

## 11. Client onboarding

Hand the client
[secrets-manager-client-guide.md](secrets-manager-client-guide.md). It contains
the final endpoint (`https://secrets.agiolab.com`), region, auth, AWS
CLI/SDK/boto3 examples, limits, error handling and the integration checklist.

The full API reference is
[../secrets-manager/API.md](../secrets-manager/API.md) and the OpenAPI document
is [../secrets-manager/openapi.yaml](../secrets-manager/openapi.yaml).

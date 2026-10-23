# Secure Password Generator

A complete, self-hosted password toolchain:

- **`password_generator.py`** — dependency-free Python CLI that generates
  character passwords or EFF Diceware passphrases with `secrets.SystemRandom`.
- **`password/`** — Next.js 16 web UI + API. The API shells out to the same
  Python script, so the browser and the CLI share one audited implementation.
- **`secrets-manager/`** — an **AWS Secrets Manager compatible** service
  (AWS JSON 1.1 protocol + SigV4) that holds the app's runtime policy and the
  word-list integrity digest.
- **`./bin/start.sh`** — one menu-driven control plane for build, start, stop,
  force rebuild, health, full-volume `.tar.gz` backup, restore, cleanup and
  secret operations, for both `dev` and `prd` environments.

Nothing is persisted by the app: passwords are generated on demand and never
written to disk or logs. The only Docker-managed stateful component is the
encrypted Secrets Manager volume. Production TLS certificates are managed by
the host nginx, outside Docker.

---

## 1. Architecture

```text
                    ┌──────────────────────────────────────────────┐
  Browser ────────► │ app  (Next.js 16, port 3000 inside)          │
                    │  • /              UI                        │
                    │  • POST /api/generate → python3 + wordlist  │
                    │  • GET  /api/health, /api/ready             │
                    │  • runtime policy fetched with SigV4        │
                    └───────────────┬──────────────────────────────┘
                                    │ AWS JSON 1.1 + SigV4
                                    ▼
                    ┌──────────────────────────────────────────────┐
  aws CLI / SDK ───►│ secrets-manager (port 8080 inside)          │
                    │  • GetSecretValue / PutSecretValue / ...     │
                    │  • AES-256-GCM encryption at rest            │
                    │  • versions, stages, soft delete, tags       │
                    └───────────────┬──────────────────────────────┘
                                    ▼
                    named volume: <project>_secrets_data
                    store.json (encrypted values) + master.key
```

Both stacks use the same host ports, so **only one environment can run per
host at a time** (`start.sh` enforces this):

| | `dev` | `prd` |
|---|---|---|
| Compose project | `passwordgenerator_dev` | `passwordgenerator_prd` |
| App (internal) | <http://127.0.0.1:18000> | <http://127.0.0.1:18000> |
| Secrets Manager (internal) | <http://127.0.0.1:18001> | <http://127.0.0.1:18001> |
| Public HTTPS | — | <https://agiolab.com> (aliases: password/www) / <https://secrets.agiolab.com> (host nginx) |
| Data volume | `passwordgenerator_dev_secrets_data` | `passwordgenerator_prd_secrets_data` |
| Backups | `backups/dev/` | `backups/prd/` |

---

## 2. Quick start

Requirements: Docker 24+ with Compose v2, Bash 3.2+, `curl`, `tar`, and
`sha256sum`/`shasum`/`openssl`. Optional: `aws` CLI v2 for AWS-protocol tests,
`python3` for host-side CLI tests, `jq` for pretty JSON.

```bash
# Interactive menu (recommended)
./bin/start.sh

# Or drive it directly
./bin/start.sh up dev            # build, seed secrets, wait for health
./bin/start.sh smoke dev         # end-to-end verification
./bin/start.sh backup dev        # full Docker volume backup
./bin/start.sh up prd            # the production profile
```

The menu shows the current environment and lets you switch context. Because
`dev` and `prd` share host ports, stop one before starting the other.

---

## 3. Environments and the `dev` / `prd` suffixes

Every environment-sensitive file follows the same convention:

| Purpose | Development | Production |
|---|---|---|
| Variables | `.env.dev` | `.env.prd` |
| Canonical reference | `.env.example` | `.env.example` |
| Compose stack | `docker-compose.dev.yml` | `docker-compose.prd.yml` |
| App image | `Dockerfile.password.dev` | `Dockerfile.password.prd` |
| Project / volume prefix | `passwordgenerator_dev` | `passwordgenerator_prd` |
| App port (host) | `18000` | `18000` (shared) |
| Secrets port (host) | `18001` | `18001` (shared) |
| Debug port (host) | `18002` | reserved / not published |
| Public HTTP/HTTPS | — | `80` / `443` (host nginx) |
| Secrets cache TTL | 15 s | 60 s |
| Backup retention | 7 bundles | 14 bundles |

`dev` uses a bind mount and the Next.js dev server (hot reload, debug port
`18002`). `prd` builds the Next.js **standalone** output and runs it with
`node server.js` as an unprivileged user. In production the host nginx is the
public TLS edge; the app and Secrets Manager are loopback-only. Each environment
is a separate Compose project, so containers, networks and volumes never
collide; the host ports are deliberately shared and only one environment may
run per host.

`.env.dev` and `.env.prd` are **local runtime files and are git-ignored**;
only the placeholder `.env.example` is tracked. Create the two local files from
the example, set local-only credentials, and never commit them. Rotate
`SECRETS_MANAGER_SECRET_ACCESS_KEY` (and optionally set
`SECRETS_MANAGER_MASTER_KEY`) before exposing the stack. The app and Secrets
Manager bind to `127.0.0.1`; the production host nginx publishes 80/443 and
proxies to those loopback ports. There is no Caddy service.

### Environment parity

`.env.example` is the canonical reference: it declares all 33 variables with
`# optional` and `# secret` annotations. All three files are **line-aligned** —
every key sits on the same line number — so a missing variable is a missing
line and a value-only diff is immediately visible.

```bash
./bin/check-env-parity.sh            # check all three files
./bin/check-env-parity.sh --quiet    # errors only (used by start.sh)
./bin/start.sh check-env             # same gate from the control script
```

`.env.dev` and `.env.prd` are **local, git-ignored runtime files**; only
`.env.example` is tracked. Create them from the example (or inject them from a
secret store in CI) and never commit them.

The checker enforces existence of all three files, key parity, line alignment,
no duplicates/malformed lines, required (non-empty) values, `# optional`
exceptions, `APP_ENV` suffixes, non-placeholder secrets, numeric and
shared host ports, project isolation, public HTTPS URLs, and that every
`${VAR}` interpolated by the Compose files is declared in `.env.example`. `./bin/start.sh` runs it before every command that
touches the stack.

### Production deployment (agiolab.com)

| Public name | Public URL | Host port | Edge → upstream |
|---|---|---|---|
| **`agiolab.com`** | <https://agiolab.com> | 443 | host nginx → `127.0.0.1:18000` (canonical) |
| `password.agiolab.com` | <https://password.agiolab.com> | 443 | host nginx → `127.0.0.1:18000` (alias) |
| `www.agiolab.com` | <https://www.agiolab.com> → `https://agiolab.com` | 443 | host nginx redirect |
| `secrets.agiolab.com` | <https://secrets.agiolab.com> | 443 | host nginx → `127.0.0.1:18001` |

Production uses the **host nginx** as the TLS edge; there is no Caddy service.
Ports 80/443 are host nginx; 18000/18001 are loopback. Dev/prd share
18000/18001/18002, so run one environment per host.

```bash
# 1. DNS: agiolab.com, www, password and secrets resolve to this host
# 2. Firewall: allow inbound TCP 80 and 443 (host nginx)
# 3. Install the nginx config and certificate (deploy/nginx/)
sudo cp deploy/nginx/agiolab.conf /etc/nginx/conf.d/agiolab.conf
# edit the certificate paths, then:
sudo nginx -t && sudo systemctl reload nginx

# 4. Start the Docker stack; start.sh checks host nginx first:
./bin/start.sh up prd
./bin/start.sh health prd --strict
```

The certificate must cover all four names (SAN or wildcard). Host nginx is outside
Compose; `start.sh` validates the installed config and waits for the public
endpoints. See [deploy/nginx/README.md](deploy/nginx/README.md), the full
runbook: [docs/production-deployment.md](docs/production-deployment.md), and the
client integration guide:
[docs/secrets-manager-client-guide.md](docs/secrets-manager-client-guide.md).

For an evidence-based deployment inventory (Docker, host nginx, other reverse
proxies, multiple domains/ports, DNS/TLS/HTTP), use the generic read-only
[`bin/deploy-discovery.sh`](bin/deploy-discovery.sh); see
[docs/deploy-discovery.md](docs/deploy-discovery.md) for the production command.

---

## 4. `./bin/start.sh` reference

The environment token (`dev` or `prd`) may appear anywhere on the command line.
Without it, `APP_ENV` from your shell is used, then `dev`.

```bash
./bin/start.sh <command> [dev|prd] [options]
```

| Command | What it does |
|---|---|
| *(no command)* | Interactive menu |
| `up`, `start` | Build with cache, start the Secrets Manager, seed secrets, start the app, wait for healthy |
| `down`, `stop` | Stop containers; volumes and backups are preserved |
| `restart` | Restart containers without rebuilding |
| `recreate` | Recreate containers to apply `.env` / Compose changes |
| `rebuild` | `docker compose build --no-cache --pull`, then recreate |
| `status` | Compose status, container health, volumes, latest backup |
| `logs [service]` | `app` or `secrets-manager`; `--follow`, `--tail N` |
| `health [--strict]` | `/api/health`, `/api/ready`, `/healthz` with bodies |
| `smoke` | API generation, validation, policy source, AWS protocol |
| `backup` | Full Docker-volume `.tar.gz` backup + manifest + checksums |
| `restore <path>` | Verified restore of a bundle or staging directory |
| `backups list\|verify\|prune` | Manage backup artifacts |
| `cleanup <scope>` | `containers`, `volumes`, `images`, `backups`, `all`, `dangling` |
| `secrets <sub>` | `list`, `get`, `put`, `create`, `describe`, `delete`, `seed`, `test`, `verify`, `endpoint`, `random`, `raw`, `credentials` |
| `credentials <sub>` | `list`, `show <name>`, `create <name> [--description TEXT] [--prefixes P1,P2]`, `delete <name>` |
| `shell [service]` | Shell in `app` (default) or `secrets-manager` |
| `exec <cmd...>` | Run a command in the app container |
| `test-cli` | Exercise `password_generator.py` (host `python3`, else container) |
| `config` | Resolved configuration with the secret key redacted |
| `check-env` | Verify `.env.example` / `.env.dev` / `.env.prd` parity |
| `doctor` | Prerequisites, LF endings, ports, parity, Compose validity, images |
| `help` | Full usage |

Examples:

```bash
./bin/start.sh up dev
./bin/start.sh up prd --attach
./bin/start.sh rebuild prd
./bin/start.sh logs dev app --follow --tail 100
./bin/start.sh health prd --strict
./bin/start.sh backup prd --retention 10 --keep-staging
./bin/start.sh restore prd backups/prd/backup-prd-20250101T000000Z.tar.gz --yes
./bin/start.sh backups dev verify
./bin/start.sh cleanup dev containers
./bin/start.sh cleanup prd all --yes
./bin/start.sh secrets dev test
./bin/start.sh secrets dev verify --sdk --boto3
./bin/start.sh secrets prd seed --force
./bin/start.sh check-env
./bin/start.sh secrets dev get password-generator/dev/app-config --json
./bin/start.sh secrets dev put password-generator/dev/app-config --file config.json
./bin/start.sh credentials dev list
./bin/start.sh credentials dev create acme --description "ACME billing"
./bin/start.sh credentials dev show acme --json
./bin/start.sh credentials dev delete acme --yes
```

Exit codes: `0` success, `1` failure, `2` usage error.

### Options

| Option | Applies to | Meaning |
|---|---|---|
| `--build` | `up` | Rebuild images with cache before start |
| `--no-build` | `up` | Skip the image build |
| `--force-rebuild` | `up` | No-cache build, pull base images, recreate |
| `--attach` | `up` | Follow app logs after a healthy start |
| `--live` | `backup` | Back up without quiescing the Secrets Manager |
| `--all-volumes` | `backup` | Include every project volume, not only labelled ones |
| `--retention N` | `backup` | Keep the N newest bundles (`0` = keep all) |
| `--keep-staging` | `backup` | Keep the per-volume staging directory |
| `--yes`, `-y` | `restore`, `cleanup`, `backups prune`, `secrets delete` | Non-interactive confirmation |
| `--no-snapshot` | `restore` | Skip the automatic pre-restore snapshot |
| `--merge` | `restore` | Merge into volumes instead of replacing contents |
| `--volume NAME` | `restore` | Target volume for a single-volume archive |
| `--strict` | `health` | Treat degraded readiness as a failure |
| `--sdk`, `--boto3` | `secrets verify` | Also run the AWS SDK v3 / boto3 client checks |
| `--description TEXT` | `credentials create` | Optional description (static `SM_CLIENTS_JSON` entries accept one too) |
| `--prefixes P1,P2` | `credentials create` | Comma-separated allowed prefixes; default `client/<name>/` |
| `--access-key-id ID` | `credentials create` | Pin the access key id; default is a generated `AKIA…` value |

---

## 5. Backups and restores

Backups are **complete Docker volume archives**, not database dumps:

1. The Secrets Manager is paused (unless `--live`) for a consistent snapshot.
2. Every stateful project volume (discovered through the
   `com.pwdgen.backup=true` label; `--all-volumes` includes every project
   volume) is streamed through a `tar` container:
   `docker run ... tar -czf - -C /volume .` → `volumes/<volume>.tar.gz`.
   This captures every file, mode and timestamp in the volume. Only the
   encrypted Secrets Manager volume is stateful in the Docker stack.
3. A `manifest.json` records the environment, project, timestamp, git commit,
   Compose/env hashes, word-list digest and per-volume size/SHA-256/labels.
4. `checksums.sha256` covers the manifest and every volume archive.
5. Everything is bundled into
   `backups/<env>/backup-<env>-<timestamp>.tar.gz`, with a sibling
   `.sha256` file. `backups/<env>/LATEST` points at the newest bundle.
6. Old bundles are pruned according to `BACKUP_RETENTION`.
7. The Secrets Manager is restarted and waited on.

TLS certificates are managed by the host nginx tooling and are not in a Docker
volume. Back them up through that tooling and include them in disaster-recovery
documentation.

Bundle layout:

```text
backup-dev-20250101T000000Z.tar.gz
├── manifest.json
├── checksums.sha256
└── volumes/
    └── passwordgenerator_dev_secrets_data.tar.gz
```

The volume archive includes `/data/store.json` and `/data/master.key` when the
master key is auto-generated. **Keep the bundle and its `.sha256` together.**
If `SECRETS_MANAGER_MASTER_KEY` is supplied through the environment instead,
the same key must be present when restoring, otherwise the store refuses to
decrypt (fail-fast, never silent data loss).

Restore is deliberately careful:

- verifies the bundle `.sha256` (when present) **before** extracting;
- extracts to `.run/restore-<ts>/` and verifies the internal `checksums.sha256`;
- shows the restore plan and requires typing `RESTORE` (or `--yes`);
- stops the stack;
- creates a `pre-restore-<env>-<ts>.tar.gz` safety snapshot of the current
  volumes unless `--no-snapshot` is passed;
- clears each target volume and extracts the archive (`--merge` preserves
  existing files instead);
- recreates missing volumes, starts the stack, re-seeds any missing secrets and
  waits for health.

Restore a single volume archive with `--volume`:

```bash
./bin/start.sh restore dev ./my-volume.tar.gz --volume passwordgenerator_dev_secrets_data
```

---

## 6. AWS-compatible Secrets Manager

`secrets-manager/` is a small, dependency-free Node.js service that speaks the
AWS Secrets Manager wire protocol. Client applications use it exactly like
AWS: the `aws` CLI v2, AWS SDK v3 and boto3 all work with SigV4.

- **Client integration guide:** [docs/secrets-manager-client-guide.md](docs/secrets-manager-client-guide.md)
- **Production runbook:** [docs/production-deployment.md](docs/production-deployment.md)
- **API reference:** [secrets-manager/API.md](secrets-manager/API.md)
- **OpenAPI spec:** [secrets-manager/openapi.yaml](secrets-manager/openapi.yaml)
- **SDK example:** [secrets-manager/examples/aws-sdk-v3.mjs](secrets-manager/examples/aws-sdk-v3.mjs)
- **Verification:** `./bin/verify-secrets-manager.sh --env dev --sdk --boto3`

The protocol details:

- **Endpoint:** `POST /` with `X-Amz-Target: secretsmanager.<Operation>`,
  `Content-Type: application/x-amz-json-1.1`. Public production clients use
  `https://secrets.agiolab.com`; host administration uses
  `http://127.0.0.1:18001`; the app uses `http://secrets-manager:8080`.
- **Auth:** AWS Signature Version 4 (`AWS4-HMAC-SHA256`), including signed
  headers, payload hash verification, credential scope, region and a 15-minute
  clock-skew window. The server signs and verifies a request at boot to prove
  the configuration is coherent.
- **Errors:** AWS-style `{"__type":"...","message":"..."}` envelopes with
  `x-amzn-RequestId` / `x-amzn-ErrorType` headers.
- **Storage:** AES-256-GCM per secret version, a random 96-bit IV and AAD bound
  to the secret ARN + version id. Metadata lives in `store.json`; the key lives
  in `master.key` (mode `0600`) or comes from `SM_MASTER_KEY`.
- **Versions:** `AWSCURRENT` / `AWSPREVIOUS` management, custom staging labels,
  idempotent `ClientRequestToken`.
- **Deletion:** soft delete with a recovery window (`7`–`30` days),
  `RestoreSecret`, or `ForceDeleteWithoutRecovery`.

### Supported operations

| Operation | Notes |
|---|---|
| `CreateSecret` | Optional initial value, description, tags, KMS key id (stored) |
| `PutSecretValue` | New version, staging labels, idempotency token |
| `GetSecretValue` | By id/ARN/partial ARN, `VersionId` or `VersionStage` |
| `DescribeSecret` | Tags, version→stages map, dates, `DeletedDate` |
| `ListSecrets` | `MaxResults`/`NextToken`, name/description/tag filters |
| `ListSecretVersionIds` | Paginated version history |
| `UpdateSecret` | Description and/or new value (new `AWSCURRENT`) |
| `DeleteSecret` | Soft delete or force delete |
| `RestoreSecret` | Clears the scheduled deletion |
| `TagResource` / `UntagResource` | Tag management |
| `BatchGetSecretValue` | Up to 20 ids, per-secret errors |
| `GetRandomPassword` | Character classes, exclusions, length |
| `CreateClientCredential` | **Extension, admin-only:** scoped client + optional `Description` |
| `ListClientCredentials` | **Extension, admin-only:** static + managed metadata (never secrets) |
| `GetClientCredential` | **Extension, admin-only:** read a client's secret |
| `DeleteClientCredential` | **Extension, admin-only:** revoke a managed client |

Unsupported AWS features (KMS rotation lambdas, resource policies, replication,
managed rotation) return protocol-compatible errors or are stored as metadata.
Secret values are limited to 64 KiB, like AWS. The four `*ClientCredential`
operations are local extensions, not AWS APIs: the AWS CLI cannot call them, but
`secrets-manager/cli.mjs` and `./bin/start.sh credentials` can.

### AWS CLI examples

```bash
export AWS_ACCESS_KEY_ID=<dev-access-key-id>
export AWS_SECRET_ACCESS_KEY="$(sed -n 's/^SECRETS_MANAGER_SECRET_ACCESS_KEY=//p' .env.dev)"
export AWS_REGION=us-east-1
export AWS_PAGER=""

aws --endpoint-url http://127.0.0.1:18001 secretsmanager list-secrets
aws --endpoint-url http://127.0.0.1:18001 secretsmanager \
  get-secret-value --secret-id password-generator/dev/app-config \
  --query SecretString --output text
aws --endpoint-url http://127.0.0.1:18001 secretsmanager \
  get-random-password --password-length 40

# Public production edge (clients; use the prd credentials):
aws --endpoint-url https://secrets.agiolab.com secretsmanager list-secrets
```

Or let the control script inject the credentials:

```bash
./bin/start.sh secrets dev test
./bin/start.sh secrets dev list
./bin/start.sh secrets prd get password-generator/prd/app-config --json
```

The bundled SigV4 client (`secrets-manager/cli.mjs`) needs neither the AWS CLI
nor an SDK:

```bash
./bin/start.sh secrets dev list
docker compose --env-file .env.dev -f docker-compose.dev.yml \
  exec -T secrets-manager node cli.mjs list-secrets
```

### SDK example (JavaScript v3)

```js
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:18001",
  credentials: {
    accessKeyId: "<dev-access-key-id>",
    secretAccessKey: process.env.SECRETS_MANAGER_SECRET_ACCESS_KEY,
  },
});

const result = await client.send(new GetSecretValueCommand({
  SecretId: "password-generator/dev/app-config",
}));
```

### Client credentials

The primary `SM_ACCESS_KEY_ID` / `SM_SECRET_ACCESS_KEY` pair is the full-access
instance credential. Scoped client credentials come from two places:

| Source | Provisioned by | Lifecycle |
|---|---|---|
| `static` | `SM_CLIENTS_JSON` in `.env.<env>` | read-only through the API; edit the env file and recreate the container |
| `managed` | `CreateClientCredential` / `./bin/start.sh credentials … create` | stored encrypted in the data volume; survives restart, backup and restore |

Managed credentials are always prefix-scoped and non-admin. They accept an
optional `Description` and a list of `AllowedPrefixes` (default
`client/<name>/`). `CreateClientCredential` returns the generated secret once;
`GetClientCredential` can retrieve it again for an administrator;
`ListClientCredentials` returns metadata only and never secret material. Static
`SM_CLIENTS_JSON` entries may also carry an optional `description`.

```bash
./bin/start.sh credentials dev list
./bin/start.sh credentials dev create acme --description "ACME billing" --prefixes client/acme/
./bin/start.sh credentials dev show acme
./bin/start.sh credentials dev delete acme --yes
```

The printed environment variables use the client name as prefix, so `acb` keeps
the existing `ACB_SECRETS_AWS_*` names and `acme` gets `ACME_SECRETS_AWS_*`.

**Why only predefined names worked before:** the service had no credential
registry. Scoped clients were validated from the in-memory `SM_CLIENTS_JSON`
array parsed at boot, and `./bin/start.sh credentials` only read that env file,
so any name other than a configured one was rejected. Adding a client meant
editing `.env.<env>` and recreating the container. The managed registry removes
that limitation while keeping credentials out of client reach: the four
`*ClientCredential` operations are admin-only, and a scoped client receives
`AccessDeniedException` if it tries to list, read, create or delete client
credentials.

> Managed credentials are stored in `store.json` with AES-256-GCM; the AAD binds
> each ciphertext to the client name and access key id. They are covered by the
> normal volume backup/restore flow and protected by the same master key. They
> are never written in plaintext, and listing never returns the secret.

### How the app uses it

At runtime the server-side API fetches two secrets with SigV4 (never from the
browser):

- `password-generator/<env>/app-config` — limits, features, rate limit and the
  word-list enforcement policy;
- `password-generator/<env>/integrity` — the expected SHA-256 of
  `eff_short_wordlist_1.txt`, checked on every passphrase request (cached).

The policy secret looks like this:

```json
{
  "schemaVersion": 1,
  "environment": "dev",
  "limits": {
    "lengthMin": 4,
    "lengthMax": 256,
    "specialCountMax": 64,
    "digitCountMax": 64,
    "mixedCaseCountMax": 128,
    "wordCountMin": 2,
    "wordCountMax": 16,
    "requestsPerMinute": 240
  },
  "features": {
    "characters": true,
    "passphrase": true,
    "qrCode": true,
    "historySize": 10
  },
  "wordlist": { "enforcement": "warn" }
}
```

`wordlist.enforcement` can be `off`, `warn` or `enforce`. `warn` (the seeded
value) keeps passphrase generation available if the word list changes without
re-seeding; `enforce` returns `503` on a digest mismatch. `requestsPerMinute: 0`
disables rate limiting.

The app caches the policy for `SECRETS_CACHE_TTL_MS`. If the Secrets Manager is
unavailable it logs a throttled warning and falls back to the built-in defaults,
so password generation keeps working. `/api/health` reports `degraded` and
`/api/ready` returns `503` in that state, while `/api/health` stays `200`.

Seeding is idempotent and happens automatically before the app starts. To
overwrite existing values (for example after changing the word list):

```bash
./bin/start.sh secrets dev seed --force
```

### Secrets Manager environment

| Variable | Default | Purpose |
|---|---|---|
| `SM_PORT` | `8080` | Listen port |
| `SM_DATA_DIR` | `/data` | Encrypted store directory |
| `SM_REGION` | `us-east-1` | SigV4 region / ARN region |
| `SM_ACCOUNT_ID` | `000000000000` | ARN account |
| `SM_ACCESS_KEY_ID` | — | SigV4 access key (required) |
| `SM_SECRET_ACCESS_KEY` | — | SigV4 secret (required) |
| `SM_SESSION_TOKEN` | — | Optional session token |
| `SM_CLIENTS_JSON` | — | Static bootstrap scoped clients (JSON array): `name`, `accessKeyId`, `secretAccessKey`, optional `description`, `allowedPrefixes`; managed clients are created at runtime |
| `SM_REQUIRE_AUTH` | `true` | Set `false` only for isolated debugging |
| `SM_MASTER_KEY` | — | 32-byte hex/base64 key; else `master.key` |
| `SM_MAX_SECRET_BYTES` | `65536` | Per-value limit |
| `SM_RECOVERY_WINDOW_DAYS` | `30` | Default soft-delete window |
| `SM_MAX_CLOCK_SKEW_SECONDS` | `900` | SigV4 clock tolerance |
| `SM_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Health endpoints (no auth): `GET /healthz`, `GET /readyz`, `GET /` (info).

---

## 7. Application

### HTTP API

`POST /api/generate`

```bash
# Local:  http://127.0.0.1:18000
# Public: https://agiolab.com
curl -s http://127.0.0.1:18000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"mode":"characters","length":24,"specialCount":3,"digitCount":3,"mixedCaseCount":6}'

curl -s http://127.0.0.1:18000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"mode":"words","wordCount":4,"wordSeparator":"-","passphraseDigitCount":2,
       "passphraseSpecialCount":1,"passphraseMixedCount":2,
       "randomizeWordCapitalization":true}'
```

```json
{
  "password": "…",
  "meta": { "mode": "characters", "length": 24, "source": "secretsmanager", "requestId": "…" }
}
```

Responses are `no-store`; a `X-Request-Id` header is always set. Errors are
`400` (invalid payload), `403` (mode disabled by policy), `429` (rate limited,
with `Retry-After`) or `500` (generator failure).

`GET /api/health` — liveness plus dependency report. `200` for `ok` or
`degraded`, `503` only when generation itself is broken.

`GET /api/ready` — readiness. `503` when the configured Secrets Manager cannot
be reached or an enforced word-list check fails.

### Reliability guards

- Python is resolved from `PYTHON_BIN` (`python3` in containers) and the script
  from `PASSWORD_GENERATOR_SCRIPT` with sane fallbacks.
- Every generation runs with a 10-second timeout, `SIGKILL` on expiry and a
  64 KiB output cap.
- The last non-empty stdout line is validated (must not be a CLI `Error:`/usage
  line, must be printable ASCII) and character passwords must have exactly the
  requested length.
- Configuration values are clamped server-side; the sum of required character
  classes cannot exceed the password length.
- A fixed-window, per-IP rate limiter (`X-Forwarded-For` / `X-Real-IP`) is
  configurable through the policy secret.
- The Secrets Manager runs read-only, drops all capabilities, uses `init: true`
  and logs through a size-limited `json-file` driver.
- Health checks use the container's own Node runtime; no shell tooling needed.

### Configuration

| App variable | Default | Purpose |
|---|---|---|
| `APP_ENV` | `dev` | Reported by health; selects the secret prefix |
| `APP_VERSION` | `1.0.0` | Reported by health |
| `PASSWORD_GENERATOR_SCRIPT` | fallback | Absolute path to the Python generator |
| `WORDLIST_PATH` | fallback | Absolute path to the EFF word list |
| `PYTHON_BIN` | `python3` | Interpreter |
| `SECRETS_MANAGER_ENABLED` | `true` | Set `false` to bypass the Secrets Manager |
| `SECRETS_MANAGER_ENDPOINT` | — | e.g. `http://secrets-manager:8080` |
| `APP_CONFIG_SECRET_ID` | — | Policy secret name |
| `INTEGRITY_SECRET_ID` | — | Word-list digest secret name |
| `SECRETS_CACHE_TTL_MS` | `30000` | Policy cache lifetime |
| `AWS_REGION` | `us-east-1` | SigV4 region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | SigV4 credentials |

### Python CLI

```bash
python3 password_generator.py                 # interactive
python3 password_generator.py --non-interactive --length 24 \
  --special-count 3 --digit-count 3 --mixed-case-count 6
python3 password_generator.py --use-words --word-count 5 --exclude-ambiguous
```

---

## 8. Local development without Docker

```bash
cd password
npm install
npm run dev          # http://localhost:3000
```

The API resolves `../password_generator.py` and `python3` automatically. To use
the Secrets Manager locally, run the dev stack for that service and point the
app at it:

```bash
docker compose --env-file .env.dev -f docker-compose.dev.yml up -d secrets-manager
./bin/start.sh secrets dev seed
cd password
SECRETS_MANAGER_ENABLED=true \
SECRETS_MANAGER_ENDPOINT=http://127.0.0.1:18001 \
AWS_ACCESS_KEY_ID=<dev-access-key-id> \
AWS_SECRET_ACCESS_KEY="$(sed -n 's/^SECRETS_MANAGER_SECRET_ACCESS_KEY=//p' ../.env.dev)" \
APP_CONFIG_SECRET_ID=password-generator/dev/app-config \
INTEGRITY_SECRET_ID=password-generator/dev/integrity \
WORDLIST_PATH="$PWD/../eff_short_wordlist_1.txt" \
npm run dev
```

Production build checks:

```bash
cd password
npm run typecheck
npm run build
```

---

## 9. Troubleshooting

```bash
./bin/start.sh doctor dev            # prerequisites, ports, LF endings, compose
./bin/start.sh status dev
./bin/start.sh logs dev app
./bin/start.sh logs dev secrets-manager
./bin/start.sh health dev
```

- **Docker build fails with a read-only `~/.docker`** — `start.sh` automatically
  falls back to `.run/docker-config` when the user's Docker config is not
  writable. This matters in sandboxes and CI.
- **`403 InvalidSignatureException` from the Secrets Manager** — check the
  access key/secret, `--region` and the host clock (SigV4 allows a 15-minute
  skew). `./bin/start.sh secrets dev test` uses the right environment.
- **App health is `degraded`** — the app cannot read the policy secret. Check
  `logs dev secrets-manager` and `secrets dev test`; generation still works with
  defaults.
- **Word-list digest mismatch** — the seeded digest no longer matches the file.
  Re-seed with `./bin/start.sh secrets dev seed --force`.
- **`Master key does not match this store`** — the encryption key and
  `store.json` came from different backups. Restore both from the same bundle,
  or set the original `SECRETS_MANAGER_MASTER_KEY`.
- **Restore refuses a bundle** — the `.sha256` next to the bundle is missing or
  the archive is corrupt. Re-copy the pair from `backups/<env>/`.
- **Environment parity failure** — run `./bin/check-env-parity.sh` for the
  exact file/key that drifted. The three files must stay line-aligned; update
  `.env.example` first and mirror the change in `.env.dev` and `.env.prd`.
- **`up prd` says a host port is in use** — dev and prd share ports by design.
  Stop the other environment first: `./bin/start.sh down dev` (or `prd`).
- **`up prd` says host nginx is missing / not listening** — install nginx,
  start it, and allow 443. `start.sh` preflights the host nginx.
- **`up prd` says a server_name is missing** — install
  [`deploy/nginx/agiolab.conf`](deploy/nginx/agiolab.conf), set the certificate
  paths, `sudo nginx -t`, and reload nginx. `start.sh` does not edit nginx.
- **Public HTTPS is unreachable** — allow inbound TCP 80/443, confirm DNS for
  both names, and check `systemctl status nginx` / `nginx -t`.
- **`502` through nginx** — the app or Secrets Manager is not running on its
  loopback port; run `./bin/start.sh status prd` and inspect the logs. nginx
  routes by `Host`; do not rewrite it.
- **`InvalidSignatureException` through nginx** — the client signs the exact
  `Host` and path. Keep `proxy_set_header Host $http_host;` and do not rewrite
  `/`. The repository nginx config does this.
- **CRLF line endings** — the repo enforces LF via `.gitattributes`; the doctor
  flags files that have been converted.
- **Build needs network** — `npm ci` pulls packages and `next/font` fetches the
  Geist fonts at build time.
- **Changed `password/package.json` in dev** — the dev stack keeps
  `node_modules` in an anonymous volume, so a dependency change needs a fresh
  one: `docker compose --env-file .env.dev -f docker-compose.dev.yml up -d
  --force-recreate -V` (this renews only anonymous volumes; the named Secrets
  Manager volume is preserved).

---

## 10. Project layout

```text
.
├── bin/start.sh                  # control plane (menu + commands)
├── bin/check-env-parity.sh       # .env.example / dev / prd parity gate
├── bin/verify-secrets-manager.sh # AWS-substitute compatibility test
├── bin/deploy-discovery.sh       # generic read-only deployment inventory
├── deploy/nginx/                 # host nginx edge config + runbook
├── docs/                         # client integration + production runbook
├── password/                     # Next.js 16 app
│   ├── app/api/generate/         # POST /api/generate
│   ├── app/api/health/           # liveness + dependency report
│   ├── app/api/ready/            # readiness
│   └── lib/                      # SigV4, secrets client, policy, generator
├── secrets-manager/              # AWS-compatible service (zero deps)
│   ├── server.mjs                # HTTP + SigV4 verification
│   ├── client.mjs / cli.mjs      # SigV4 client + operator CLI
│   ├── seed.mjs                  # idempotent policy bootstrap
│   ├── API.md                    # full API reference
│   ├── openapi.yaml              # machine-readable spec
│   ├── examples/                 # AWS SDK v3 client example
│   └── lib/                      # store, operations, sigv4, errors
├── docker-compose.dev.yml
├── docker-compose.prd.yml
├── Dockerfile.password.dev
├── Dockerfile.password.prd
├── .env.example                  # canonical reference (all 33 variables)
├── .env.dev / .env.prd         # local runtime, git-ignored
├── password_generator.py
├── eff_short_wordlist_1.txt
└── backups/<env>/                # generated, git-ignored
```

---

## 11. Security notes

- All generation happens server-side with `secrets.SystemRandom`; passwords are
  never stored, logged or sent to a third party.
- The Secrets Manager binds to `127.0.0.1` in both profiles. Do not publish it
  to the internet; use a private network and rotate the local credentials.
- In production only the host nginx is public (TCP 80/443). It terminates TLS,
  adds HSTS and security headers, and proxies to the loopback app/Secrets
  Manager ports while preserving `Host` and path for SigV4.
- Dev and prd share host ports by design; run only one environment per host.
- Secret values are encrypted at rest with AES-256-GCM. The master key lives in
  the same volume by default; set `SECRETS_MANAGER_MASTER_KEY` to keep it
  outside the volume (then backups require that key).
- Backups contain the encrypted store **and** the master key when auto-generated.
  Treat backup bundles as secrets. `bin/start.sh` sets `umask 077`, so new
  backup directories and files are private on POSIX filesystems (exFAT/NTFS
  mounts ignore modes; protect the host path yourself).
- Run `./bin/start.sh cleanup <env> all --yes` before decommissioning a host.
- The two local `.env.*` files contain development credentials for the local
  endpoint only and are **git-ignored**. Rotate them for any shared deployment,
  and set `APP_BIND_ADDRESS`/`SECRETS_MANAGER_BIND_ADDRESS` deliberately.
  Only `.env.example` is committed, and it contains placeholders only; never put
  real values in a tracked file.

---

## 12. License

MIT — see [LICENSE](LICENSE). Retain attribution to Alejandro Castro,
AIEpicStudio.com and AIEpic.app in copies or substantial portions of the
software.

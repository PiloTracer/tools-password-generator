# AWS-compatible Secrets Manager

A small, dependency-free Node.js service that implements the AWS Secrets Manager
wire protocol well enough for the **AWS CLI v2**, the **AWS SDKs** and the
bundled SigV4 client. It backs the password generator's runtime policy and
word-list integrity digest.

- **Protocol:** AWS JSON 1.1 (`X-Amz-Target`, `application/x-amz-json-1.1`)
- **Auth:** AWS Signature Version 4 (`AWS4-HMAC-SHA256`)
- **Storage:** encrypted JSON in a Docker volume (`/data`)
- **Dependencies:** none — Node.js core modules only

**Documentation:** [API reference](API.md) · [OpenAPI spec](openapi.yaml) ·
[AWS SDK v3 example](examples/aws-sdk-v3.mjs) · [boto3 example](examples/boto3_example.py) ·
[client guide](../docs/secrets-manager-client-guide.md)

## Run it

Inside the stack (recommended):

```bash
./bin/start.sh up dev
./bin/start.sh secrets dev test
./bin/start.sh secrets dev verify --sdk --boto3
```

`secrets verify` runs the full AWS-substitute compatibility test: health,
SigV4 auth, CRUD, versions, tags, soft delete/restore, wrong-key/wrong-region
rejection, and (with `--sdk` / `--boto3`) real AWS SDK clients.

Standalone for development:

```bash
SM_PORT=8080 \
SM_DATA_DIR=./.data \
SM_ACCESS_KEY_ID=<dev-access-key-id> \
SM_SECRET_ACCESS_KEY="$(openssl rand -hex 32)" \
node secrets-manager/server.mjs
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/` | SigV4 | Secrets Manager API |

- **Public production endpoint:** `https://secrets.agiolab.com` (host nginx TLS edge on 443)
- **Loopback administration:** `http://127.0.0.1:18001` (never published)
- **Internal Compose network:** `http://secrets-manager:8080`
| `GET` | `/healthz` | no | Liveness |
| `GET` | `/readyz` | no | Store/volume readiness |
| `GET` | `/` | no | Service info + supported operations |

Example:

```bash
export AWS_ACCESS_KEY_ID=<dev-access-key-id>
export AWS_SECRET_ACCESS_KEY="$(sed -n 's/^SECRETS_MANAGER_SECRET_ACCESS_KEY=//p' ../.env.dev)"
export AWS_REGION=us-east-1
export AWS_PAGER=""

aws --endpoint-url https://secrets.agiolab.com secretsmanager list-secrets

# Local loopback administration:
aws --endpoint-url http://127.0.0.1:18001 secretsmanager list-secrets
aws --endpoint-url http://127.0.0.1:18001 secretsmanager \
  get-secret-value --secret-id password-generator/dev/app-config \
  --query SecretString --output text
```

The bundled client is useful in containers and CI where the AWS CLI is absent:

```bash
docker compose --env-file .env.dev -f docker-compose.dev.yml \
  exec -T secrets-manager node cli.mjs list-secrets
```

or, from the repository root:

```bash
SM_ENDPOINT=http://127.0.0.1:18001 \
SM_ACCESS_KEY_ID=<dev-access-key-id> \
SM_SECRET_ACCESS_KEY=... \
node secrets-manager/cli.mjs ping
```

## Supported operations

| Operation | Behaviour |
|---|---|
| `CreateSecret` | Creates a secret; optional `SecretString`/`SecretBinary`, `Description`, `Tags`, `KmsKeyId` (metadata only). `ResourceExistsException` on duplicates. |
| `PutSecretValue` | New version. Defaults to `AWSCURRENT`; the previous current version receives `AWSPREVIOUS`. `ClientRequestToken` is idempotent. |
| `GetSecretValue` | Accepts name, full ARN or ARN without suffix; optional `VersionId`/`VersionStage` (default `AWSCURRENT`). |
| `DescribeSecret` | ARN, description, tags, dates, `VersionIdsToStages`, `DeletedDate`. |
| `ListSecrets` | `MaxResults` (1–100), opaque `NextToken`, filters on name/description/tag key/tag value/all, `IncludePlannedDeletion`. |
| `ListSecretVersionIds` | Version history with staging labels and pagination. |
| `UpdateSecret` | Updates the description and/or creates a new `AWSCURRENT` version. |
| `DeleteSecret` | Soft delete with `RecoveryWindowInDays` (7–30) or `ForceDeleteWithoutRecovery`. |
| `RestoreSecret` | Cancels a scheduled deletion. |
| `TagResource` / `UntagResource` | Tag management. |
| `BatchGetSecretValue` | Up to 20 ids **or** filters; per-secret errors in `Errors`. |
| `GetRandomPassword` | `PasswordLength`, exclude flags/characters, `RequireEachIncludedType`. |

All other AWS operations return `UnknownOperationException` (400).

### Request/response shape

```http
POST / HTTP/1.1
Host: 127.0.0.1:18001
X-Amz-Target: secretsmanager.GetSecretValue
Content-Type: application/x-amz-json-1.1
X-Amz-Date: 20250101T120000Z
X-Amz-Content-SHA256: ...
Authorization: AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...

{"SecretId":"password-generator/dev/app-config"}
```

The response is JSON encoded with AWS epoch-second timestamps and an
`x-amzn-RequestId` header. Errors use the AWS envelope:

```json
{"__type": "ResourceNotFoundException", "message": "Secrets Manager can't find the specified secret."}
```

### Signature verification

- Header-based SigV4 only; presigned URLs are rejected.
- Credential scope must match `SM_REGION` and the `secretsmanager` service.
- `SignedHeaders` must include `host`.
- The declared `x-amz-content-sha256` (when present) must match the body hash;
  `UNSIGNED-PAYLOAD` is accepted.
- Requests older/newer than `SM_MAX_CLOCK_SKEW_SECONDS` (default 900) are
  rejected with `RequestExpired`.
- A self-test signs and verifies a request at boot so misconfiguration fails
  immediately.

## Verification

```bash
./bin/verify-secrets-manager.sh --env dev
./bin/verify-secrets-manager.sh --env dev --sdk --boto3
./bin/start.sh secrets dev verify --sdk --boto3
```

The verifier creates a uniquely named test secret and always force-deletes it.
It checks:

- `/healthz` and `/readyz`;
- AWS CLI lifecycle: create, get, put, describe, list, version stages, tags,
  batch get, random password;
- soft delete → inaccessible → restore → accessible;
- force delete cleanup;
- `InvalidSignatureException` for a wrong secret key and a wrong region;
- with `--sdk`: `@aws-sdk/client-secrets-manager` (ListSecrets + GetSecretValue)
  from a throwaway Node container on the Compose network;
- with `--boto3`: `boto3` (ListSecrets + GetSecretValue) from a throwaway
  Python container on the Compose network.

The API reference is [API.md](API.md); the OpenAPI document is
[openapi.yaml](openapi.yaml).

## Storage and encryption

```text
/data/
├── store.json   # metadata + per-version ciphertext
└── master.key   # 32-byte AES key, mode 0600 (generated on first boot)
```

- Values are encrypted with **AES-256-GCM** (96-bit random IV, 128-bit tag).
  The additional authenticated data binds the ciphertext to
  `<secret ARN>|<version id>`.
- The key comes from `SM_MASTER_KEY` when set (64 hex chars or base64 of 32
  bytes), otherwise it is generated into the volume.
- On startup every stored version is decrypted once. A wrong key or corrupt
  store aborts startup with a clear error instead of serving broken data.
- `store.json` is fsync'd and atomically replaced through a temporary file.
- Writes are serialised by Node's single-threaded event loop.
- The container runs as the unprivileged `node` user with a read-only root
  filesystem and a tmpfs `/tmp`.
- The master key lives in the same volume by default. That makes volume
  backups self-contained, but backups must then be handled as secrets. Set
  `SM_MASTER_KEY` to keep the key outside the volume.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SM_PORT` | `8080` | HTTP port |
| `SM_HOST` | `0.0.0.0` | Bind address |
| `SM_DATA_DIR` | `/data` | Store directory |
| `SM_REGION` | `us-east-1` | SigV4/ARN region |
| `SM_ACCOUNT_ID` | `000000000000` | ARN account id (12 digits) |
| `SM_ACCESS_KEY_ID` | — | Required when auth is on |
| `SM_SECRET_ACCESS_KEY` | — | Required when auth is on |
| `SM_SESSION_TOKEN` | — | Optional; verified when set |
| `SM_CLIENTS_JSON` | — | Optional JSON array of scoped client credentials: `accessKeyId`, `secretAccessKey`, optional `sessionToken`, `name`, `allowedPrefixes` |
| `SM_REQUIRE_AUTH` | `true` | `false` disables verification (debug only) |
| `SM_MASTER_KEY` | — | 32-byte key, hex or base64 |
| `SM_MAX_SECRET_BYTES` | `65536` | Value limit |
| `SM_RECOVERY_WINDOW_DAYS` | `30` | Default soft-delete window |
| `SM_MAX_CLOCK_SKEW_SECONDS` | `900` | SigV4 tolerance |
| `SM_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SM_ENDPOINT` | `http://127.0.0.1:8080` | Client only |
| `SEED_ENV`, `SEED_FORCE`, `SEED_WORDLIST`, `SEED_PREFIX` | — | `seed.mjs` |
| `SEED_CONFIG_SECRET_ID`, `SEED_INTEGRITY_SECRET_ID` | derived from prefix | Explicit secret names; wired from `.env.*` by Compose |

## Seeding the app policy

`seed.mjs` is idempotent and runs automatically before the app starts:

```bash
docker compose --env-file .env.dev -f docker-compose.dev.yml \
  exec -T -e SEED_ENV=dev secrets-manager node seed.mjs
```

It creates:

- `password-generator/<env>/app-config` — limits, features, rate limit,
  word-list enforcement;
- `password-generator/<env>/integrity` — `wordlistSha256` for
  `eff_short_wordlist_1.txt`.

Use `SEED_FORCE=true` (or `./bin/start.sh secrets <env> seed --force`) to
overwrite operator edits and rotations.

## Limitations

This is a faithful local endpoint, not a complete AWS emulator:

- one SigV4 principal (no IAM/resource policies or per-secret permissions);
- no KMS integration, customer managed keys or automatic rotation lambdas;
- resource policies and replication return unsupported errors;
- `KmsKeyId` is accepted and stored, but encryption uses the local master key;
- secret values are capped at 64 KiB and the request body at 1 MiB;
- SigV4 header auth only (no presigned URLs); the primary credential is full-access and `SM_CLIENTS_JSON` entries are prefix-scoped;
- The service uses HTTP inside the private Compose network. The production
  host nginx terminates TLS on port 443 and proxies to loopback 18001; the
  loopback port is not public.

## Source map

```text
server.mjs            HTTP server, SigV4 verification, routing, self-test
API.md                full API reference (protocol + operations)
openapi.yaml          OpenAPI 3.1 specification
examples/             AWS SDK v3 + boto3 client examples
lib/sigv4.mjs         canonicalisation, signing and verification
lib/store.mjs         AES-256-GCM store, versions, tags, pagination
lib/operations.mjs    operation dispatch table
lib/errors.mjs        AWS error types and status codes
lib/logger.mjs        structured JSON logging
lib/util.mjs          hashing, encoding, small helpers
client.mjs            SigV4 client used by the CLI and seeder
cli.mjs               operator CLI
seed.mjs              application secret bootstrap
```

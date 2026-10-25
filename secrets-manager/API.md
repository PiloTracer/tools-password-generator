# Secrets Manager API

An AWS Secrets Manager compatible API for client applications. The service
implements the **AWS JSON 1.1** protocol and **AWS Signature Version 4**, so
existing AWS clients — the `aws` CLI v2, AWS SDKs, boto3 — can manage secrets
without any custom SDK.

- **Wire protocol:** `POST /` with `X-Amz-Target: secretsmanager.<Operation>`
- **Content type:** `application/x-amz-json-1.1`
- **Authentication:** AWS Signature Version 4 (`AWS4-HMAC-SHA256`)
- **Storage:** local, AES-256-GCM encrypted, in a Docker volume
- **Machine-readable spec:** [openapi.yaml](openapi.yaml)
- **Client examples:** [AWS SDK v3](examples/aws-sdk-v3.mjs) · [boto3](examples/boto3_example.py)
- **Client guide:** [docs/secrets-manager-client-guide.md](../docs/secrets-manager-client-guide.md)
- **Verification:** `./bin/verify-secrets-manager.sh --env dev --sdk --boto3`

> This is a protocol-compatible secrets service for a private deployment, not a
> full AWS account emulator. See [Compatibility](#12-compatibility-and-limitations)
> for the exact scope.

---

## 1. Endpoint and transport

| Environment | Internal endpoint | Host endpoint (published) |
|---|---|---|
| dev | `http://secrets-manager:8080` | `http://127.0.0.1:18001` |
| prd | `http://secrets-manager:8080` | `http://127.0.0.1:18001` |
| **prd public** | `http://secrets-manager:8080` | `https://secrets.agiolab.com` |

The app talks to the internal endpoint over the private Compose network.
Operator tooling (AWS CLI, SDKs, the bundled CLI) can use loopback for host-side
administration. **Client applications use the public endpoint
`https://secrets.agiolab.com`**, where the host nginx edge terminates TLS on
port 443. Port 18001 is never published to the internet.

**Transport security.** The service speaks HTTP on the private Compose network
and loopback. The production host nginx terminates TLS on port **443** and
proxies to `127.0.0.1:18001`. The loopback port 18001 is not public. SigV4
protects requests from tampering/replay and TLS protects them in transit. The
edge preserves the `Host` header and path, both signed by SigV4.

**Admin listener.** The service also listens on `SM_ADMIN_HOST:SM_ADMIN_PORT`
(default `127.0.0.1:8081`) inside the container. The four `*ClientCredential`
operations are served **only** there; the public listener returns
`AccessDeniedException` for them, and the production nginx edge returns `403`.
The admin listener is not published through Compose. Use
`./bin/start.sh credentials <env> ...`, or a direct `cli.mjs` call inside the
container with `SM_ENDPOINT=http://127.0.0.1:8081`.

**Health endpoints** (no SigV4, no secret data):

| Request | Response |
|---|---|
| `GET /healthz` | `200 {"status":"ok","service":"secrets-manager",...}` |
| `GET /readyz` | `200`/`503 {"status":"ready","ok":true,"secrets":2,...}` |
| `GET /` | service info and supported operation names |

---

## 2. Authentication

Every API request must be signed with AWS Signature Version 4:

```http
POST / HTTP/1.1
Host: 127.0.0.1:18001
Content-Type: application/x-amz-json-1.1
X-Amz-Target: secretsmanager.GetSecretValue
X-Amz-Date: 20250101T120000Z
X-Amz-Content-SHA256: <hex sha256 of the body>
X-Amz-Security-Token: <optional>
Authorization: AWS4-HMAC-SHA256 Credential=<access-key>/20250101/us-east-1/secretsmanager/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target, Signature=<hex>
```

Through the public edge the request line and `Host` header are:

```http
POST / HTTP/1.1
Host: secrets.agiolab.com
```

The **`Host` header and path are part of the signature.** Any proxy in front of
the service must forward both unchanged.

The server verifies:

- the access key id (maps to the primary or a scoped client credential),
- the credential scope (`<date>/<region>/secretsmanager/aws4_request`),
- the signed `host` header (it must be part of `SignedHeaders`),
- the payload hash when `X-Amz-Content-SHA256` is present
  (`UNSIGNED-PAYLOAD` is accepted),
- the request timestamp within a 15-minute window
  (`SM_MAX_CLOCK_SKEW_SECONDS`),
- the optional session token when configured,
- the HMAC signature, in constant time.

AWS clients do all of this automatically. Configuration:

```bash
export AWS_ACCESS_KEY_ID=<dev-access-key-id>
export AWS_SECRET_ACCESS_KEY="$(sed -n 's/^SECRETS_MANAGER_SECRET_ACCESS_KEY=//p' .env.dev)"
export AWS_REGION=us-east-1
export AWS_PAGER=""
export AWS_ENDPOINT_URL_SECRETSMANAGER=http://127.0.0.1:18001
```

> **Multiple clients, prefix-scoped.** The primary credential is full-access.
> Additional credentials are limited to their `allowedPrefixes`: list/batch
> operations are filtered, and operations on other secret names return
> `AccessDeniedException`. Scoped clients come from `SM_CLIENTS_JSON` (static,
> fixed at boot, optional `readOnly`) or are created through the admin-only
> `*ClientCredential` operations (managed, encrypted in the data volume). This
> is not IAM/STS; there are no policies, roles, or temporary credentials.
> Only the primary credential can manage client credentials; a scoped client
> receives `AccessDeniedException` for every `*ClientCredential` operation.
> Those operations are served only on the container-loopback admin listener;
> the public listener and the nginx edge reject them for every principal.

Only header-based SigV4 is supported; presigned query URLs are rejected.

---

## 3. Protocol

### 3.1 Request

```http
POST / HTTP/1.1
X-Amz-Target: secretsmanager.<Operation>
Content-Type: application/x-amz-json-1.1
```

The body is a JSON object whose fields are documented per operation below.
Unknown fields are ignored. An empty body is treated as `{}`.

### 3.2 Response

A successful response is HTTP `200` with
`Content-Type: application/x-amz-json-1.1`, a JSON object, and an
`x-amzn-RequestId` header. Timestamps are **epoch seconds** (JSON numbers) and
binary values are **base64**.

### 3.3 Errors

Errors use the AWS envelope and an `x-amzn-ErrorType` header:

```json
{
  "__type": "ResourceNotFoundException",
  "message": "Secrets Manager can't find the specified secret."
}
```

| `__type` | HTTP | Meaning |
|---|---|---|
| `ResourceNotFoundException` | 400 | Secret or version does not exist |
| `ResourceExistsException` | 400 | `CreateSecret` name already exists |
| `InvalidParameterException` | 400 | Missing/invalid field, bad limit, bad base64 |
| `InvalidRequestException` | 400 | Deleted secret, unknown path, bad state |
| `SerializationException` | 400 | Body is not valid JSON |
| `UnknownOperationException` | 400 | Missing/unknown `X-Amz-Target` |
| `MissingAuthenticationTokenException` | 400 | No `Authorization` header |
| `UnrecognizedClientException` | 400 | Unknown access key |
| `InvalidSignatureException` | 403 | Bad signature, wrong scope/region, signed header missing |
| `RequestExpired` | 400 | Timestamp outside the skew window |
| `XAmzContentSHA256Mismatch` | 400 | Declared body hash does not match |
| `InternalServiceError` | 500 | Unexpected server failure |

Retry `500` responses with backoff. Do not retry `4xx` signature errors
without fixing the credentials or clock.

---

## 4. Data model

A secret has:

- a **name** (`^[A-Za-z0-9/_+=.@-]{1,512}$`),
- an **ARN** of the form
  `arn:aws:secretsmanager:<region>:<account>:secret:<name>-<6 alphanumeric>`,
- a description, tags, creation/last-changed/last-accessed dates,
- zero or more **versions**, each with a UUID `VersionId`, a creation date, and
  one or more **staging labels**.

Staging labels:

- `AWSCURRENT` — the version returned by default. Exactly one version holds it.
- `AWSPREVIOUS` — the previous current version. Managed by the server; a
  request cannot set it directly.
- Custom labels (`[A-Za-z0-9_]{1,256}`) may be assigned; a label points at one
  version at a time.

`SecretId` accepts a name, a full ARN, or an ARN without the six-character
suffix.

Limits:

| Item | Limit |
|---|---|
| Secret name | 512 characters |
| `SecretString` | 64 KiB |
| `SecretBinary` (decoded) | 64 KiB |
| Request body | 1 MiB |
| Staging labels per version | 20 |
| `ListSecrets` page | 1–100 |
| `BatchGetSecretValue` ids | 20 |
| Soft-delete window | 7–30 days |

Deletion:

- `DeleteSecret` without `ForceDeleteWithoutRecovery` schedules deletion and
  returns a `DeletionDate`. `GetSecretValue` on that secret returns
  `InvalidRequestException` until `RestoreSecret` is called.
- `ForceDeleteWithoutRecovery: true` removes the secret and all versions
  immediately.
- Expired soft-deleted secrets are purged when the service starts.

Client credentials are a separate registry, not secrets. Each record has a
`Name`, `AccessKeyId`, optional `Description`, `AllowedPrefixes`, the encrypted
`SecretAccessKey`, and either `Source: static` (`SM_CLIENTS_JSON`) or
`Source: managed` (created by the admin API). Managed records also carry
`CreatedDate`, `LastUpdatedDate` and `CreatedBy`. See
[5.14](#514-listclientcredentials)–[5.17](#517-deleteclientcredential).

---

## 5. Operations

All requests target `POST /` with the corresponding
`X-Amz-Target: secretsmanager.<Operation>`.

### 5.1 CreateSecret

```json
{
  "Name": "app/prd/database",
  "Description": "Database password",
  "SecretString": "s3cr3t",
  "KmsKeyId": "alias/local",
  "Tags": [{ "Key": "team", "Value": "platform" }],
  "ClientRequestToken": "1b7d...c9",
  "VersionStages": ["AWSCURRENT"]
}
```

- `Name` is required. `SecretString` and `SecretBinary` are mutually exclusive.
- `KmsKeyId` is stored as metadata; values are always encrypted with the local
  master key.
- `ClientRequestToken` makes version creation idempotent.
- `VersionStages` defaults to `["AWSCURRENT"]`.

Response:

```json
{
  "ARN": "arn:aws:secretsmanager:us-east-1:000000000000:secret:app/prd/database-a1b2c3",
  "Name": "app/prd/database",
  "VersionId": "8b0d...",
  "VersionStages": ["AWSCURRENT"]
}
```

Errors: `ResourceExistsException`, `InvalidParameterException`.

### 5.2 PutSecretValue

```json
{
  "SecretId": "app/prd/database",
  "SecretString": "new-secret",
  "VersionStages": ["AWSCURRENT"]
}
```

Creates a new version. If the new version gets `AWSCURRENT`, the previous
current version becomes `AWSPREVIOUS`. Use `ClientRequestToken` to make retries
idempotent.

Response: `{ "ARN", "Name", "VersionId", "VersionStages" }`.

Errors: `ResourceNotFoundException`, `InvalidRequestException` (deleted),
`InvalidParameterException`.

### 5.3 GetSecretValue

```json
{ "SecretId": "app/prd/database", "VersionStage": "AWSCURRENT" }
```

Use `VersionId` instead of `VersionStage` to read a specific version.

Response:

```json
{
  "ARN": "...",
  "Name": "app/prd/database",
  "VersionId": "8b0d...",
  "VersionStages": ["AWSCURRENT"],
  "CreatedDate": 1735732800.123,
  "SecretString": "new-secret"
}
```

`SecretBinary` is returned (base64) instead of `SecretString` for binary
secrets. A deleted secret fails with `InvalidRequestException`; a missing
version fails with `ResourceNotFoundException`.

### 5.4 DescribeSecret

```json
{ "SecretId": "app/prd/database" }
```

Response:

```json
{
  "ARN": "...",
  "Name": "app/prd/database",
  "Description": "Database password",
  "CreatedDate": 1735732800.0,
  "LastChangedDate": 1735736400.0,
  "LastAccessedDate": 1735736500.0,
  "DeletedDate": 1735740000.0,
  "Tags": [{ "Key": "team", "Value": "platform" }],
  "VersionIdsToStages": {
    "8b0d...": ["AWSCURRENT"],
    "7c1e...": ["AWSPREVIOUS"]
  },
  "RotationEnabled": false
}
```

`DeletedDate`/`LastAccessedDate`/`KmsKeyId` appear only when set.

### 5.5 ListSecrets

```json
{
  "MaxResults": 100,
  "NextToken": "...",
  "Filters": [{ "Key": "name", "Values": ["app/"] }],
  "IncludePlannedDeletion": false
}
```

Filter keys: `name`, `description`, `tag-key`, `tag-value`, `all`. Values are
matched with substring semantics; filters are ANDed, values within one filter
are ORed. Deleted secrets are hidden unless `IncludePlannedDeletion` is true.

Response:

```json
{
  "SecretList": [
    {
      "ARN": "...",
      "Name": "app/prd/database",
      "Description": "...",
      "CreatedDate": 1735732800.0,
      "LastChangedDate": 1735736400.0,
      "Tags": [],
      "SecretVersionsToStages": { "8b0d...": ["AWSCURRENT"] }
    }
  ],
  "NextToken": "..."
}
```

`NextToken` is present only when more results exist.

### 5.6 ListSecretVersionIds

```json
{ "SecretId": "app/prd/database", "IncludeDeprecated": false }
```

Response:

```json
{
  "ARN": "...",
  "Name": "app/prd/database",
  "Versions": [
    { "VersionId": "8b0d...", "VersionStages": ["AWSCURRENT"], "CreatedDate": 1735736400.0 },
    { "VersionId": "7c1e...", "VersionStages": ["AWSPREVIOUS"], "CreatedDate": 1735732800.0 }
  ]
}
```

### 5.7 UpdateSecret

```json
{
  "SecretId": "app/prd/database",
  "Description": "Rotated by the operator",
  "SecretString": "new-value"
}
```

At least one of `Description`, `KmsKeyId`, `SecretString` or `SecretBinary`
must be supplied. Supplying a value creates a new `AWSCURRENT` version.

Response: `{ "ARN", "Name", "VersionId?", "VersionStages?" }`.

### 5.8 DeleteSecret

```json
{ "SecretId": "app/prd/database", "RecoveryWindowInDays": 7 }
```

or:

```json
{ "SecretId": "app/prd/database", "ForceDeleteWithoutRecovery": true }
```

Response: `{ "ARN", "Name", "DeletionDate" }`.

Only one of the two mutually exclusive options may be supplied.
`RecoveryWindowInDays` must be 7–30.

### 5.9 RestoreSecret

```json
{ "SecretId": "app/prd/database" }
```

Cancels a scheduled deletion. Response: `{ "ARN", "Name" }`. Restoring a
secret that is not scheduled for deletion is a no-op.

### 5.10 TagResource

```json
{
  "SecretId": "app/prd/database",
  "Tags": [{ "Key": "owner", "Value": "security" }]
}
```

Tags are merged. Response: `{}`.

### 5.11 UntagResource

```json
{ "SecretId": "app/prd/database", "TagKeys": ["owner"] }
```

Response: `{}`.

### 5.12 BatchGetSecretValue

```json
{ "SecretIdList": ["app/prd/database", "app/prd/api-key"] }
```

or use `Filters` (same syntax as `ListSecrets`). `MaxResults` is 1–20.
`SecretIdList` and `Filters` are mutually exclusive.

Response:

```json
{
  "SecretValues": [
    {
      "ARN": "...",
      "Name": "app/prd/database",
      "VersionId": "8b0d...",
      "VersionStages": ["AWSCURRENT"],
      "CreatedDate": 1735736400.0,
      "SecretString": "new-value"
    }
  ],
  "Errors": [
    {
      "SecretId": "missing",
      "ErrorCode": "ResourceNotFoundException",
      "ErrorMessage": "Secrets Manager can't find the specified secret."
    }
  ]
}
```

Per-secret failures do not fail the whole request; they appear in `Errors`.

### 5.13 GetRandomPassword

```json
{
  "PasswordLength": 32,
  "ExcludeCharacters": "01OIl",
  "ExcludeNumbers": false,
  "ExcludePunctuation": true,
  "RequireEachIncludedType": true
}
```

Response: `{ "RandomPassword": "..." }`.

`PasswordLength` is 1–4096 (default 32). When `RequireEachIncludedType` is true,
at least one character from every included class is guaranteed.

### 5.14 ListClientCredentials

**Local extension, admin-only, loopback admin listener only.** Lists static
(`SM_CLIENTS_JSON`) and managed client credentials. Request: `{}`. The response
never contains secret material.

```json
{
  "ClientCredentialList": [
    {
      "Name": "acb",
      "AccessKeyId": "acb-prd-access",
      "Description": "ACB production client",
      "AllowedPrefixes": ["client/acb/"],
      "ReadOnly": false,
      "Source": "static"
    },
    {
      "Name": "acme",
      "AccessKeyId": "AKIA0123456789ABCDEF",
      "Description": "ACME billing integration",
      "AllowedPrefixes": ["client/acme/"],
      "ReadOnly": false,
      "Source": "managed",
      "CreatedDate": 1730000000,
      "LastUpdatedDate": 1730000000,
      "CreatedBy": "instance-admin"
    }
  ]
}
```

`Source` is `static` or `managed`. `CreatedDate`, `LastUpdatedDate` and
`CreatedBy` are present only for managed entries. Static entries are fixed at
boot and cannot be modified through the API; `ReadOnly` reports whether the
credential itself can mutate, delete, restore or tag secrets.

### 5.15 CreateClientCredential

**Local extension, admin-only, loopback admin listener only.** Creates a
prefix-scoped, non-admin client.

```json
{
  "Name": "acme",
  "Description": "ACME billing integration",
  "AllowedPrefixes": ["client/acme/"],
  "AccessKeyId": "AKIACUSTOM1234567890"
}
```

| Field | Required | Rules |
|---|---|---|
| `Name` | yes | 1–64 chars, starts with a letter/number, then `A-Z a-z 0-9 . _ -`; unique across static and managed clients |
| `Description` | no | ≤512 chars |
| `AllowedPrefixes` | no | 1–16 strings; each is normalized to end in `/`; default `client/<Name>/` |
| `AccessKeyId` | no | 8–64 chars, starts with a letter/number, then `A-Z a-z 0-9 . _ -`; generated as `AKIA…` when omitted; unique |

Response (the secret is returned here and by `GetClientCredential`):

```json
{
  "Name": "acme",
  "AccessKeyId": "AKIACUSTOM1234567890",
  "SecretAccessKey": "<64 hex>",
  "SessionToken": "",
  "Description": "ACME billing integration",
  "AllowedPrefixes": ["client/acme/"],
  "ReadOnly": false,
  "Source": "managed",
  "CreatedDate": 1730000000,
  "LastUpdatedDate": 1730000000,
  "CreatedBy": "instance-admin"
}
```

`SecretAccessKey` values are generated with 32 random bytes. There is no
temporary-credential/STS flow, so `SessionToken` is empty. Duplicate names or
access key ids return `ResourceExistsException`; invalid fields return
`InvalidParameterException`; non-admin callers get `AccessDeniedException`.
Managed credentials are stored encrypted in `store.json` and survive restarts
and volume backups.

### 5.16 GetClientCredential

**Local extension, admin-only, loopback admin listener only.** Returns the
credential including its secret. Identify it by `Name` or `AccessKeyId`:

```json
{ "Name": "acme" }
```

or

```json
{ "AccessKeyId": "AKIACUSTOM1234567890" }
```

The response has the same shape as `CreateClientCredential`. This is the only
way to re-read a managed secret; `ListClientCredentials` deliberately omits it.
Treat the response as sensitive.

### 5.17 DeleteClientCredential

**Local extension, admin-only, loopback admin listener only.** Revokes a
managed credential immediately.

```json
{ "Name": "acme" }
```

Response:

```json
{ "Name": "acme", "AccessKeyId": "AKIACUSTOM1234567890", "DeletionDate": 1730000000 }
```

Deletion is permanent (no recovery window). A request signed with the deleted
credential fails with `UnrecognizedClientException` from the next request.
Static `SM_CLIENTS_JSON` entries cannot be deleted: the call returns
`InvalidRequestException`; remove the entry from the environment file and
recreate the container instead.

---

## 6. AWS CLI examples

```bash
export AWS_ACCESS_KEY_ID=<dev-access-key-id>
export AWS_SECRET_ACCESS_KEY="$(sed -n 's/^SECRETS_MANAGER_SECRET_ACCESS_KEY=//p' .env.dev)"
export AWS_REGION=us-east-1
export AWS_PAGER=""

ENDPOINT=http://127.0.0.1:18001

aws --endpoint-url "$ENDPOINT" secretsmanager list-secrets
aws --endpoint-url "$ENDPOINT" secretsmanager \
  get-secret-value --secret-id password-generator/dev/app-config \
  --query SecretString --output text

aws --endpoint-url "$ENDPOINT" secretsmanager \
  create-secret --name app/dev/example --secret-string 'value' \
  --tags Key=team,Value=platform

aws --endpoint-url "$ENDPOINT" secretsmanager \
  put-secret-value --secret-id app/dev/example --secret-string 'rotated'

aws --endpoint-url "$ENDPOINT" secretsmanager \
  get-secret-value --secret-id app/dev/example \
  --version-stage AWSPREVIOUS --query SecretString --output text

aws --endpoint-url "$ENDPOINT" secretsmanager \
  delete-secret --secret-id app/dev/example --force-delete-without-recovery
```

Binary secrets:

```bash
aws --endpoint-url "$ENDPOINT" secretsmanager \
  create-secret --name app/dev/cert --secret-binary fileb://cert.p12
```

The control script injects the right credentials automatically:

```bash
./bin/start.sh secrets dev test
./bin/start.sh secrets dev verify --sdk
./bin/start.sh secrets dev get password-generator/dev/app-config --json
```

The client-credential extensions are not part of the AWS CLI command model. Use
the bundled client/control script:

```bash
node secrets-manager/cli.mjs list-client-credentials
node secrets-manager/cli.mjs create-client-credential acme \
  --description "ACME billing" --prefixes client/acme/
node secrets-manager/cli.mjs get-client-credential acme
node secrets-manager/cli.mjs delete-client-credential acme

# or, on the server:
./bin/start.sh credentials dev list
./bin/start.sh credentials dev create acme --description "ACME billing"
./bin/start.sh credentials dev show acme
./bin/start.sh credentials dev delete acme --yes
```

`create` returns the secret once; `get` returns it again for an administrator;
`list` never returns secrets.

---

## 7. Client examples

### 7.1 AWS SDK for JavaScript v3

```bash
npm install @aws-sdk/client-secrets-manager
```

```js
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:18001",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const { SecretString } = await client.send(
  new GetSecretValueCommand({ SecretId: "app/dev/example" }),
);
```

The complete example is [examples/aws-sdk-v3.mjs](examples/aws-sdk-v3.mjs); the
verification script runs it against the live endpoint with `--sdk`.

### 7.2 Python / boto3

```bash
pip install -r secrets-manager/examples/requirements.txt
```

```python
import boto3

client = boto3.client(
    "secretsmanager",
    endpoint_url="http://127.0.0.1:18001",
    region_name="us-east-1",
    aws_access_key_id="<dev-access-key-id>",
    aws_secret_access_key="...",
)

secret = client.get_secret_value(SecretId="app/dev/example")
print(secret["SecretString"])
```

A runnable version is [examples/boto3_example.py](examples/boto3_example.py); it
reads the endpoint and credentials from the environment.


### 7.3 Bundled SigV4 client

`secrets-manager/cli.mjs` speaks the same protocol without the AWS CLI or SDK:

```bash
docker compose --env-file .env.dev -f docker-compose.dev.yml \
  exec -T secrets-manager node cli.mjs list-secrets

./bin/start.sh secrets dev list
./bin/start.sh secrets dev put app/dev/example --file ./value.txt
```

---

## 8. Application integration

The password generator itself is a client. It reads:

| Secret | Purpose |
|---|---|
| `password-generator/<env>/app-config` | Limits, features, rate limit, word-list enforcement |
| `password-generator/<env>/integrity` | Expected SHA-256 of the word list |

The app caches each value for `SECRETS_CACHE_TTL_MS` and falls back to safe
defaults if the endpoint is unavailable. `/api/health` reports `degraded`;
`/api/ready` returns `503`. Policy changes are picked up automatically after
the cache expires.

The policy payload is documented in the [root README](../README.md#6-aws-compatible-secrets-manager).

---

## 9. Secure deployment

- **Keep the service private.** The Compose files publish the Secrets Manager
  on `127.0.0.1:18001` only. Do not expose 18001 to the internet.
- **Use the host nginx edge.** In this deployment, the production host's nginx
  terminates TLS on port 443 and proxies to `http://127.0.0.1:18001`; the
  repository config is `deploy/nginx/agiolab.conf`. The public endpoint is
  `https://secrets.agiolab.com`. There is no Caddy service.
- **Nginx requirements:** preserve the exact `Host` header and path — SigV4
  signs both. Use `proxy_set_header Host $http_host;`. Minimal example:

  ```nginx
  server {
      listen 443 ssl;
      server_name secrets.agiolab.com;

      ssl_certificate     /etc/letsencrypt/live/agiolab.com/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/agiolab.com/privkey.pem;

      location / {
          proxy_pass http://127.0.0.1:18001;
          proxy_http_version 1.1;
          proxy_set_header Host $http_host;
          proxy_set_header X-Forwarded-For $remote_addr;
          proxy_set_header X-Forwarded-Proto $scheme;
      }
  }
  ```

  Do not strip or rewrite the request path; the signature covers it.

- **Rotate credentials.** Change `SECRETS_MANAGER_SECRET_ACCESS_KEY` and update
  the application. Rotate a static client by editing its `SM_CLIENTS_JSON` entry
  and recreating the container; rotate a managed client with
  `DeleteClientCredential` followed by `CreateClientCredential`, then update the
  client. Prefer distinct credentials per environment and per client.
- **Protect the master key.** Values are AES-256-GCM encrypted. The key lives
  in the data volume (`/data/master.key`, mode `0600`) or comes from
  `SECRETS_MANAGER_MASTER_KEY`. Backups include it when stored in the volume —
  treat backup bundles as secrets.
- **Limit the blast radius.** The primary credential is full-access; issue
  prefix-scoped clients (static or managed) for applications, and keep the admin
  credential off client hosts. Managed clients are always non-admin and cannot
  mint credentials. Isolate deployments or add a proxy-level ACL if multiple
  teams share a host.
- **Treat the client registry as secret.** Managed client secrets are encrypted
  in `store.json`, covered by the same volume backup and master key as secret
  values. `GetClientCredential` prints a secret; do not log it.
- **Back up before rotating.** Use `./bin/start.sh backup <env>`; restore with
  `./bin/start.sh restore <env> <bundle>`.

---

## 10. Verification

```bash
./bin/start.sh up dev
./bin/verify-secrets-manager.sh --env dev --sdk --boto3

# Against the public TLS endpoint (after DNS/certificates are live):
SM_ENDPOINT=https://secrets.agiolab.com \
  ./bin/verify-secrets-manager.sh --env prd
```

The verifier checks health, SigV4 authentication, create/get/put/describe/list,
version stages, tags, batch reads, random passwords, soft delete/restore,
force delete, wrong-key/wrong-region rejection, the admin-only
`ListClientCredentials` extension, and — with `--sdk` / `--boto3` — real
`@aws-sdk/client-secrets-manager` and `boto3` clients. It creates a uniquely
named test secret and removes it on exit.

Alternatively use the control script:

```bash
./bin/start.sh secrets dev verify --sdk --boto3
```

---

## 11. Health endpoints

```bash
# Public (production; host nginx TLS on 443)
curl https://secrets.agiolab.com/healthz
curl https://secrets.agiolab.com/readyz

# Loopback (host administration)
curl http://127.0.0.1:18001/healthz
curl http://127.0.0.1:18001/readyz
curl http://127.0.0.1:18001/
```

`READY` means the data directory is writable, the master key is loaded and the
store is initialized. These endpoints do not require authentication and never
return secret material.

---

## 12. Compatibility and limitations

Verified clients:

- `aws` CLI v2 (`secretsmanager` command family)
- AWS SDK for JavaScript v3 (`@aws-sdk/client-secrets-manager`)
- Python `boto3`
- The bundled SigV4 client (`cli.mjs`)

Supported AWS operations: `CreateSecret`, `PutSecretValue`, `GetSecretValue`,
`DescribeSecret`, `ListSecrets`, `ListSecretVersionIds`, `UpdateSecret`,
`DeleteSecret`, `RestoreSecret`, `TagResource`, `UntagResource`,
`BatchGetSecretValue`, `GetRandomPassword`.

Local extensions (admin-only, not AWS APIs): `CreateClientCredential`,
`ListClientCredentials`, `GetClientCredential`, `DeleteClientCredential`.

Not implemented:

- IAM/resource policies, per-secret permissions, cross-account access
- KMS customer-managed keys and automatic rotation lambdas
- Replication, cross-region secrets, `PrimaryRegion`
- Presigned URLs (header SigV4 only)
- Native TLS inside the service (host nginx terminates TLS)
- CloudTrail/audit exports and request throttling
- `RotationEnabled` is always `false`; `KmsKeyId` is metadata only

Unknown operations return `UnknownOperationException`. Unsupported fields in
supported operations are generally ignored, except where validation is noted.

---

## 13. OpenAPI

The machine-readable specification is [openapi.yaml](openapi.yaml). Because AWS
JSON 1.1 selects an operation through the `X-Amz-Target` header rather than the
URL, the spec models a single `POST /` with a `oneOf` request/response and an
`x-aws-target-map` extension linking each target to its schemas.

# Secrets Manager — Client Integration Guide

**Service:** AgioLab Secrets Manager (AWS-compatible)
**Audience:** First client application integrating with the secrets API
**Version:** 1.0
**Status:** Production

---

## 1. Service summary

The Secrets Manager exposes an **AWS Secrets Manager compatible API**. Client
applications use the standard AWS `secretsmanager` client (AWS CLI v2, AWS SDKs,
boto3) and only change the endpoint URL. Authentication is AWS Signature
Version 4. Values are encrypted at rest with AES-256-GCM.

| Item | Value |
|---|---|
| **API endpoint** | `https://secrets.agiolab.com` |
| **Protocol** | AWS JSON 1.1 |
| **TLS** | HTTPS, publicly trusted certificate |
| **Region** | `us-east-1` |
| **Service name** | `secretsmanager` |
| **Auth** | AWS Signature Version 4 |
| **Health check** | `GET https://secrets.agiolab.com/healthz` |
| **Public password generator** | `https://agiolab.com` (alias: `https://password.agiolab.com`) |

The endpoint uses standard HTTPS port **443** on the host nginx edge. There is
no plaintext HTTP endpoint.

---

## 2. Network requirements

| Requirement | Value |
|---|---|
| DNS | `secrets.agiolab.com` → production edge IP address(es) |
| Outbound TCP | `443` to `secrets.agiolab.com` |
| TLS | 1.2+ (certificate must validate; do not disable verification) |
| Proxy | If your egress proxy is used, allow CONNECT to `secrets.agiolab.com:443` |

The host nginx edge listens on 80/443. If your environment blocks outbound
TCP 443, contact AgioLab operations before development starts.

### Domain mapping

| Public name | Public URL | Transport | Backend service |
|---|---|---|---|
| `agiolab.com` | `https://agiolab.com` | HTTPS/TLS 443 | Password generator (canonical) |
| `password.agiolab.com` | `https://password.agiolab.com` | HTTPS/TLS 443 | Password generator alias |
| `www.agiolab.com` | `https://www.agiolab.com` → `https://agiolab.com` | HTTPS/TLS 443 | Alias redirect |
| `secrets.agiolab.com` | `https://secrets.agiolab.com` | HTTPS/TLS 443 | Secrets Manager API |

Both names resolve to the same AgioLab production host. Host nginx routes by
`Host`; do not rewrite or omit the `Host` header in any proxy between your
application and AgioLab.

---

## 3. Credentials

AgioLab provides the **client access key id / secret access key** out of band.
They are not included in this document.

Credentials are issued **per client**. Each client credential is scoped to an
allowed secret-name prefix; for this ACB onboarding the prefix is
`client/acb/`. The credential cannot read or list the password generator's own
`password-generator/...` secrets, and it cannot create secrets outside
`client/acb/`.

Additional scoped clients can be created on the server at any time with an
optional description, and managed credentials are stored encrypted and survive
restarts:

```bash
./bin/start.sh credentials prd create <client> --description "..." --prefixes client/<client>/
./bin/start.sh credentials prd list
./bin/start.sh credentials prd show <client>
```

Your credential never grants access to the credential-management operations.
Those are admin-only; a client calling `CreateClientCredential`,
`ListClientCredentials`, `GetClientCredential` or `DeleteClientCredential`
receives `AccessDeniedException`.

The service supports multiple client credentials, but it is not IAM/STS: there
are no roles, policies or temporary credentials. `ListSecrets` and
`BatchGetSecretValue` are filtered to the client's prefix, and operations on
other secrets return `AccessDeniedException`.

- Use the credential only from your server-side application; never ship it to
  browsers, mobile binaries or front-end code.
- Store it in your own secret manager or CI secret store. Do not commit it.
- Rotate the client credential on your normal security schedule; coordinate the
  rotation with AgioLab before the old secret is disabled.
- The field `region` must be exactly `us-east-1`; the signature is scoped to it.
- If a session token is issued with the credential, send it as
  `X-Amz-Security-Token` (all AWS SDKs do this automatically when configured).

> **Isolation note.** The client credential is restricted to `client/acb/`.
> Do not share it with other clients or with the password-generator application.
> If you need a different prefix or a separate deployment, contact AgioLab
> before issuing credentials.

---

## 4. Quick start

### 4.1 AWS CLI v2

```bash
export AWS_ACCESS_KEY_ID="<your-access-key-id>"
export AWS_SECRET_ACCESS_KEY="<your-secret-access-key>"
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export AWS_PAGER=""

ENDPOINT="https://secrets.agiolab.com"

# Smoke test
aws --endpoint-url "$ENDPOINT" secretsmanager list-secrets

# Create a secret
aws --endpoint-url "$ENDPOINT" secretsmanager create-secret \
  --name "client/example/db-password" \
  --description "Example database password" \
  --secret-string "initial-value"

# Read it (AWSCURRENT)
aws --endpoint-url "$ENDPOINT" secretsmanager get-secret-value \
  --secret-id "client/example/db-password" \
  --query SecretString --output text

# Rotate it
aws --endpoint-url "$ENDPOINT" secretsmanager put-secret-value \
  --secret-id "client/example/db-password" \
  --secret-string "rotated-value"

# Read the previous version
aws --endpoint-url "$ENDPOINT" secretsmanager get-secret-value \
  --secret-id "client/example/db-password" \
  --version-stage AWSPREVIOUS \
  --query SecretString --output text

# Delete (soft delete; restorable for 7 days)
aws --endpoint-url "$ENDPOINT" secretsmanager delete-secret \
  --secret-id "client/example/db-password" --recovery-window-in-days 7
```

### 4.2 AWS SDK for JavaScript v3

```bash
npm install @aws-sdk/client-secrets-manager
```

```js
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({
  region: "us-east-1",
  endpoint: "https://secrets.agiolab.com",
  credentials: {
    accessKeyId: process.env.SECRETS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRETS_SECRET_ACCESS_KEY,
  },
});

const { SecretString } = await client.send(
  new GetSecretValueCommand({ SecretId: "client/example/db-password" }),
);

await client.send(
  new PutSecretValueCommand({
    SecretId: "client/example/db-password",
    SecretString: "rotated-value",
  }),
);
```

### 4.3 Python / boto3

```bash
pip install boto3
```

```python
import boto3

client = boto3.client(
    "secretsmanager",
    endpoint_url="https://secrets.agiolab.com",
    region_name="us-east-1",
    aws_access_key_id="<your-access-key-id>",
    aws_secret_access_key="<your-secret-access-key>",
)

secret = client.get_secret_value(SecretId="client/example/db-password")
print(secret["SecretString"])
```

> Do not set global `AWS_ENDPOINT_URL` for all AWS services. Apply the endpoint
> only to the Secrets Manager client.

---

## 5. Secret naming and lifecycle

Use a stable, hierarchical name:

```text
client/<client-slug>/<application>/<purpose>
```

Examples:

```text
client/acme/billing/db-password
client/acme/billing/stripe-api-key
client/acme/worker/smtp-password
```

Allowed names: 1–512 characters from `A-Z a-z 0-9 / _ + = . @ -`.

Lifecycle:

1. `CreateSecret` with `SecretString` (or `SecretBinary`, base64).
2. Read with `GetSecretValue` (defaults to `AWSCURRENT`).
3. Rotate with `PutSecretValue`: the new version becomes `AWSCURRENT`; the
   previous one becomes `AWSPREVIOUS`.
4. Delete with `DeleteSecret`: soft delete for 7–30 days, or
   `ForceDeleteWithoutRecovery` for immediate removal.
5. Restore a soft-deleted secret with `RestoreSecret`.

Tags are supported for ownership, cost tracking and automation:

```bash
aws --endpoint-url "$ENDPOINT" secretsmanager tag-resource \
  --secret-id "client/example/db-password" \
  --tags Key=client,Value=example Key=environment,Value=production
```

---

## 6. Supported operations

| Operation | Purpose |
|---|---|
| `CreateSecret` | Create a secret (optional initial value, tags, description) |
| `GetSecretValue` | Read `AWSCURRENT` or a specific `VersionId`/`VersionStage` |
| `PutSecretValue` | Add a new version; rotates `AWSCURRENT`/`AWSPREVIOUS` |
| `UpdateSecret` | Update description and/or value |
| `DescribeSecret` | Metadata, tags and version→stage map |
| `ListSecrets` | Paginated list with name/description/tag filters |
| `ListSecretVersionIds` | Version history and staging labels |
| `DeleteSecret` | Soft delete or force delete |
| `RestoreSecret` | Cancel a scheduled deletion |
| `TagResource` / `UntagResource` | Manage tags |
| `BatchGetSecretValue` | Read up to 20 secrets in one call |
| `GetRandomPassword` | Generate a random password server-side |

Unsupported AWS features: IAM/resource policies, KMS customer-managed keys,
managed rotation lambdas, replication and presigned URLs. See the full API
reference for details.

The server also exposes four local, admin-only extensions for credential
lifecycle (`CreateClientCredential`, `ListClientCredentials`,
`GetClientCredential`, `DeleteClientCredential`). They are not part of the AWS
API and are not available to scoped client credentials.

---

## 7. Limits

| Item | Limit |
|---|---|
| Secret name | 512 characters |
| `SecretString` / decoded `SecretBinary` | 64 KiB |
| Request body | 1 MiB |
| `ListSecrets` page size | 1–100 |
| `BatchGetSecretValue` ids | 20 |
| Staging labels per version | 20 |
| Soft-delete window | 7–30 days |

Errors use the standard AWS envelope, for example:

```json
{
  "__type": "ResourceNotFoundException",
  "message": "Secrets Manager can't find the specified secret."
}
```

Common codes: `ResourceNotFoundException`, `ResourceExistsException`,
`InvalidParameterException`, `InvalidRequestException`,
`InvalidSignatureException` (clock/credentials/region), `RequestExpired`.

If you receive `InvalidSignatureException`:

1. Verify the endpoint is exactly `https://secrets.agiolab.com`.
2. Verify `region=us-east-1`.
3. Synchronize the server clock (NTP); signatures allow a 15-minute skew.
4. Verify the access key and secret are current and not truncated.

---

## 8. Health check

```bash
curl -fsS https://secrets.agiolab.com/healthz
```

Expected:

```json
{"status":"ok","service":"secrets-manager","version":"1.1.0","authRequired":true}
```

`/readyz` additionally verifies the encrypted store is writable and loaded.

Do not use `/healthz` as an authenticated API test; use `ListSecrets` for that.

---

## 9. Security responsibilities

- Keep the certificate chain in your HTTP client at its default verification
  setting. Do **not** use `--no-verify-ssl`, `-k` or
  `NODE_TLS_REJECT_UNAUTHORIZED=0` in production.
- Keep credentials in a server-side secret store, not in source control, logs,
  crash reports or analytics.
- Rotate credentials when staff changes or on your security schedule.
- Restrict who can read the credential and which systems can reach port 443.
- Enable TLS inspection only through AgioLab-approved proxies; proxies must
  preserve the `Host` header and the request path (SigV4 signs both).
- Delete unused secrets. Use soft delete first; force delete only on explicit
  approval.
- Do not store passwords in tags, descriptions or secret names.

The host nginx edge provides TLS 1.2+, HSTS, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` and hides the server banner. The API is encrypted at
rest with AES-256-GCM.

---

## 10. Integration checklist

- [ ] DNS resolves `secrets.agiolab.com` from the application host.
- [ ] Outbound TCP 443 is permitted.
- [ ] TLS certificate validation is enabled and succeeds.
- [ ] Credentials are stored server-side and injected at runtime.
- [ ] `region=us-east-1` and `endpoint=https://secrets.agiolab.com`.
- [ ] `ListSecrets` succeeds in a smoke test.
- [ ] Create/get/rotate/delete work for a test secret.
- [ ] The application handles `409`/`400` responses and retries transient
      `500` errors with backoff.
- [ ] Secret names follow `client/<client>/<app>/<purpose>`.
- [ ] Rotation and deletion runbooks are documented on your side.

---

## 11. Support

- **Operations contact:** AgioLab operations (contact provided separately)
- **Incident / availability:** check `GET /healthz` and include the timestamp,
  request id (response header `x-amzn-RequestId`) and error body in the report.
- **Security issues:** report privately to the AgioLab security contact; do not
  include secret values in tickets.

The full protocol reference is [API.md](../secrets-manager/API.md); the
machine-readable specification is [openapi.yaml](../secrets-manager/openapi.yaml).

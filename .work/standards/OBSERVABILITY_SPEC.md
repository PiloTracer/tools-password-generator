# OBSERVABILITY_SPEC — Secure Password Generator

**What this is:** how this stack reports health, logs, and failures.
**Status:** Draft — baseline generated 2026-10-25 from code evidence.
**Needs:** decision on whether metrics/alerting are in scope (§Gaps).

## Health

| Surface | Endpoint | Semantics |
|---------|----------|-----------|
| App (liveness) | `GET /api/health` | 200 while the generator can serve; Secrets Manager outage reports `degraded`, not down |
| App (readiness) | `GET /api/ready` | 503 when policy/integrity cannot be read from Secrets Manager (running on fallback policy) |
| Secrets Manager | `GET /healthz` | store readable |

Compose healthchecks poll these (`docker-compose.*.yml`); `./bin/start.sh up` waits on them before seeding/health checks.

## Logs

- App and secrets-manager log to stdout; `LOG_LEVEL` (default `info`) is passed through compose.
- Rotation: Docker `json-file`, `max-size: 10m`, `max-file: 3` per service.
- Never log secrets, master keys, access keys, generated passwords, or full request bodies.

## Metrics / tracing

- None: no Prometheus endpoint, no OpenTelemetry SDK, no APM agent.

## Backups

- The `secrets_data` volume carries `com.pwdgen.backup=true`; `./bin/start.sh backup <env>` writes an encrypted `.tar.gz` under `backups/`.
- Restore is manual: `./bin/start.sh restore <env> <archive>`.

## Gaps (open)

1. No external alerting on `/api/ready` failure — only the compose healthcheck plus container restart.
2. No request-id correlation between nginx and app logs.
3. Log retention beyond Docker rotation is undefined.

## Next action

Decide whether metrics/alerting are in scope, then record the decision as an ADR in `.work/decisions/`.

# BOUNDARY_MAP — Secure Password Generator

**What this is:** trust boundaries, network paths, and data flows between components.
**Status:** Draft — baseline generated 2026-10-25 from compose/nginx/code evidence.
**Needs:** security-owner review (`@soc-director`) before exposing a new surface.

## Zones

| Zone | Component | Listens | Exposure |
|------|-----------|---------|----------|
| Edge | host nginx (`deploy/nginx/agiolab.conf`) | 80 / 443 | public, Let's Encrypt TLS |
| App | `app` (Next.js) | 3000 | loopback `127.0.0.1:18000`; debug port `9229` in dev only |
| Platform | `secrets-manager` | 8080 API, 8081 admin | loopback `127.0.0.1:18001`; admin listener container-local |
| Data | `secrets_data` volume | — | Docker volume holding `store.json` + `master.key` |

## Trust rules

1. Browsers reach only nginx; nginx proxies to loopback. No container publishes on a public interface (`*_BIND_ADDRESS` defaults to `127.0.0.1`).
2. App → secrets-manager uses AWS JSON 1.1 over SigV4 with a scoped **read-only** client credential (`bin/ensure-app-credentials.py`); the master key never leaves the secrets-manager container.
3. Client-credential admin operations (`*ClientCredential`) are denied at the public edge by the nginx `map`, and exist only on the loopback admin listener.
4. nginx must forward `Host` and path unchanged — SigV4 signs both.
5. Generated passwords are ephemeral: never persisted, never logged, never sent to the secrets manager.

## Data flows

Browser → nginx → `app` (`POST /api/generate`) → `python3 password_generator.py` → response. Runtime policy and the wordlist integrity digest come from secrets-manager via SigV4 at readiness and are cached (15 s dev / 60 s prd).

## Out of scope

No database, no queue, no third-party SaaS calls at runtime.

## Next action

`@soc-director` review of this map before the next public-surface change.

# DIRECTORY_MAP — Secure Password Generator

**What this is:** repository layout, ownership, and boundary rules.
**Status:** Draft — baseline generated 2026-10-25 from repo evidence.
**Needs:** review whenever a new top-level area appears.

| Path | Owner | Purpose | Rule |
|------|-------|---------|------|
| `password/` | app | Next.js 16 UI + API (`app/api/{generate,health,ready}`) | Only place for TypeScript/React; never fork generator logic here |
| `password_generator.py` | app | Single generator implementation (CLI + API) | Never reimplement the algorithm in TS |
| `secrets-manager/` | platform | AWS-compatible secret store + `openapi.yaml` contract | Wire-contract changes update `openapi.yaml` and the client guide |
| `bin/` | ops | Host control plane (`start.sh`), env parity, secrets verification | No app imports; Docker and coreutils only |
| `deploy/nginx/` | ops | Host edge config (TLS, SigV4-preserving proxy) | Never rewrite `Host`/path headers for SigV4 |
| `docs/` | ops | Deployment and client guides | User-facing docs, not agent memory |
| `backups/` | ops | Encrypted volume backups (`.tar.gz`) | Contains keys — never commit, never print |
| `.run/` | runtime | Local runtime state and buildx caches | Never commit |
| `.work/` | project memory | Plans, SPECs, ADRs, HANDOFF, standards | Always local (thin and fat modes) |
| `.cursorrules` | agent config | Agent rules + `AGENT_OS_SOURCE` pointer | Protected — no wholesale rewrite |

## Boundaries

- app → secrets-manager: HTTP, AWS JSON 1.1 + SigV4, `secrets-manager:8080` inside the compose network.
- Host nginx → app/secrets-manager: loopback `18000`/`18001`; the admin listener `8081` stays container-local.
- No local `.ai/`: skills and framework standards resolve from `$AGENT_OS_SOURCE` (`/mnt/work/Projects/pilo.ai.logicbison`).

## Next action

`@plan-foundation` P3 — fold this into the foundation directory map.

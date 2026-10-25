# Technology stack — Secure Password Generator

**What this is:** pinned stack for the password-generator toolchain (Python CLI + Next.js 16 app + AWS-compatible secrets manager).
**Status:** Active — filled 2026-10-25 from repo evidence (README, compose files, Dockerfiles, package manifests).
**Needs:** owner triage of the open decisions in §5.

## 1. Summary

| Layer | Choice | Version (pin) | Notes |
|-------|--------|---------------|-------|
| Language (primary) | TypeScript (Next.js) + Python 3 (generator CLI) | TypeScript `^5`; Node 22 images; Python 3 (Debian bookworm) | `password_generator.py` is dependency-free (stdlib only) |
| HTTP API | Next.js 16 route handlers | `next` 16.0.1, `react` 19.2.0 | `/api/generate`, `/api/health`, `/api/ready` |
| Database | none — encrypted JSON store inside `secrets-manager` | `@pwdgen/secrets-manager` 1.1.0 | AES-256-GCM at rest; named volume `secrets_data` |
| Cache / queue | none (in-process policy cache) | — | `SECRETS_CACHE_TTL_MS` (15 s dev / 60 s prd) |
| Frontend | Next.js App Router + Tailwind CSS 4 | `tailwindcss` `^4`, `framer-motion` `^12`, `lucide-react` `^0.554` | `password/` |
| Auth | AWS SigV4 with a scoped read-only app credential; loopback admin listener | — | admin `127.0.0.1:8081` in-container |
| Hosting | Docker Compose per env + host nginx TLS | — | app `127.0.0.1:18000`, secrets manager `127.0.0.1:18001` |

## 2. Repository layout

| Path | Purpose |
|------|---------|
| `password/` | Next.js 16 UI + API (primary app tree) |
| `password_generator.py` | Dependency-free CLI — the single generator implementation the API shells out to |
| `secrets-manager/` | AWS Secrets Manager-compatible service (Node 22, zero npm dependencies) |
| `bin/` | Host operational scripts: `start.sh`, `check-env-parity.sh`, `verify-secrets-manager.sh`, `deploy-discovery.sh`, `ensure-app-credentials.py` |
| `deploy/nginx/` | Host edge config (TLS, SigV4-preserving proxy, client-credential deny map) |
| `docs/` | Deployment and client guides |
| `eff_short_wordlist_1.txt` | EFF short wordlist; its digest is seeded as an integrity secret |
| `.work/` | Plans, SPECs, ADRs, HANDOFF, project standards |
| `$AGENT_OS_SOURCE/` | Agent OS skills and framework standards (thin client: `/mnt/work/Projects/pilo.ai.logicbison`) |
| — | No SQL migrations: all persisted state is the encrypted secrets volume |

## 3. Local development

| Item | Value |
|------|-------|
| Dev stack script | `./bin/start.sh up dev` (or `up prd`) |
| Compose files | `docker-compose.dev.yml` + `.env.dev` · `docker-compose.prd.yml` + `.env.prd` |
| Test command | `npm run typecheck && npm run lint && npm test` in the `app` container |
| Lint | `npm run lint` (ESLint 9, `eslint-config-next`) |
| Type check | `npm run typecheck` (`tsc --noEmit`, `strict: true`) |
| Unit tests | `npm test` — `node --experimental-strip-types --test test/*.test.ts` (zero new dependencies; see the web-surface SPEC) |
| Service contract tests | `node --test secrets-manager/test/contract.test.mjs` (host, zero deps; 40 tests) |
| Stack checks | `./bin/check-env-parity.sh`, `./bin/verify-secrets-manager.sh --env dev`, `./bin/start.sh smoke dev` |
| Production build check | `NODE_ENV=production npx next build` inside the app container — the dev container pins `NODE_ENV=development`, which makes prerendering `/_global-error` fail (`useContext` of null). Build stages in the Dockerfile do not set it, so deploys are unaffected. |
| Rollback | `./bin/start.sh rollback [stamp\|latest\|--list] <env>` — per-build image snapshots, keeps 5 |
| Scope check | `bash /mnt/work/Projects/pilo.ai.logicbison/scripts/touch-scope-verify.sh` |
| Blast radius | `bash /mnt/work/Projects/pilo.ai.logicbison/scripts/blast-radius-check.sh` |

Containers: `password_app_dev` (workdir `/code/password`, port 3000) and `password_secrets_dev` (port 8080); both published on loopback only.

## 4. CI/CD

| Item | Status |
|------|--------|
| Platform | none configured (`.github/` absent) — gates run locally via `./bin/start.sh` and the commands in §3 |
| Deploy target | `prd` compose stack behind host nginx (`deploy/nginx/agiolab.conf`); TLS certificates live on the host |

## 5. Open decisions (track in `.work/plans/UNKNOWNS.md`)

| ID | Topic | Owner |
|----|-------|-------|
| U1 | ~~No automated test suite~~ — **resolved 2026-10-25**: 40 service contract tests + 22 app unit tests + 13-check smoke | owner |
| U2 | No CI pipeline — choose platform | owner |

## 6. ADR cross-reference

Decisions live in `.work/decisions/`. This file holds **pins** only; rationale belongs in ADRs.

## Next action

`@plan-foundation greenfield` — create the foundation docs (01–04) that later SPECs and the master plan reference.

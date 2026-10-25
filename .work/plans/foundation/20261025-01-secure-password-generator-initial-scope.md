# Secure Password Generator — Initial exploration and scope

**What this is:** foundation doc 01 — product scope, audience, assumption ledger and risks for the self-hosted password toolchain, rebuilt from the shipped code and operator statements.
**Status:** Approved — 2026-10-25
**Needs:** owner confirmation of the scope boundaries in §4 and the open questions in §9.

**Brownfield synthesis 2026-10-25:** this repository already ships and runs in production. This document was synthesized from code, `README.md`, `.work/` state and operator statements rather than from a greenfield interview. Anything inferred from behaviour is labelled **Inference**; anything cited from a file is **Confirmed**.

---

## 1. Audience and document purpose

People who need passwords they can defend in an audit: an operator running the stack, the engineers who consume the Secrets Manager, and the end users who press "generate". The document fixes **what v1 is** so that architecture, SPECs and the master plan have a stable anchor.

It is *not* the master implementation plan. The master plan is `{PLANS_ROOT}/full/*-full-plan.md` (plan-master). Architecture lives in [doc 04](20261025-04-foundation-architecture.md).

## 2. Assumption ledger

### Founder intent (verbatim — P0 capture)

> "@ai-director - Resolve all issues, - make plan vs code consistent, - make code profesional and reliable, - current clients that are using the secrets-manager must continue to work properly, - make this current software work reliable and professionally, -make it safe enough for production, - protect this system against abuse, - make it flexible to be used as reliable secrets-manager when using credentials that I generate from inside the production server (cli-style)."

> "yes, there's a live system using the secrets-manager, without the 531-line diff deployed."

> "/mnt/data/Projects/EPIC/tools-password-generator does not exist, make sure any references to the codebase for tools-password-generator are based on the new path /mnt/work/Projects/tools-password-generator"

### Confirmed facts (repository evidence)

| # | Fact | Evidence |
|---|------|----------|
| C1 | One generator implementation is shared by the browser and the CLI; the API shells out to `password_generator.py` | `README.md` §1; `password/app/api/generate/route.ts`; assumption `A1` |
| C2 | Randomness comes from `secrets.SystemRandom`; passwords are never persisted or logged | `password_generator.py` header; `README.md` §11 |
| C3 | The Secrets Manager is AWS-JSON-1.1 + SigV4 compatible with 17 operations | `secrets-manager/lib/operations.mjs:75-139`; [SPEC](../../features/secrets-manager/20261025-SPEC.md) |
| C4 | State is one AES-256-GCM encrypted JSON document on a named volume; no SQL, no queue | `secrets-manager/lib/store.mjs:191-197`, `:643` |
| C5 | Production runs commit `269b9c6` **without** the uncommitted hardening diff; live clients are the generator (static, read-only) and ACB (`client/acb/`) | operator statement; pilo-mail feedback F-02/F-05 |
| C6 | TLS terminates on host nginx outside Docker; only 80/443 are public | `deploy/nginx/agiolab.conf`; `README.md` §11 |
| C7 | The canonical checkout is `/mnt/work/Projects/tools-password-generator`; the previous location was removed | operator statement 2026-10-25 |
| C8 | There was **no foundation documentation, no ADR and no test suite** before 2026-10-25 | `.work/plans/foundation/` empty; `.work/decisions/` README-only |

### Inference (not yet confirmed by the owner)

| # | Inference | Basis |
|---|-----------|-------|
| I1 | The product is operated by one owner-operator, not a multi-tenant SaaS | single-host stack, one managed client, no tenant model in code |
| I2 | "Reliable Secrets Manager for credentials generated on the production host" means an operator CLI minting credentials **on the box**, never over the public internet | owner wording "cli-style", "from inside the production server"; existing loopback admin listener |
| I3 | The ACB client consumes a credential rather than minting one at runtime | `managedClients: 1` in the feedback probe; no client-side minting code found in this repo |

## 3. Product in one paragraph

A self-hosted password toolchain: a dependency-free Python CLI that produces character passwords and EFF Diceware passphrases from `secrets.SystemRandom`; a Next.js 16 UI + API that shells out to that same script so every password is auditable; an AWS-Secrets-Manager-compatible service holding the app's runtime policy and the word-list integrity digest; and one control plane (`./bin/start.sh`) for dev and prd behind host nginx. Nothing is persisted except the encrypted secrets volume.

## 4. Scope

### In scope for v1 (shipped)

| Capability | Where |
|---|---|
| Character passwords with length / special / digit / mixed-case controls, ambiguous-character exclusion | `password_generator.py` |
| EFF Diceware passphrases with separator, capitalization, digit/special/mixed suffixes | `password_generator.py`; `eff_short_wordlist_1.txt` |
| Browser UI + JSON API, server-side generation only | `password/app/` |
| Runtime policy (limits, feature flags) and word-list integrity digest from the Secrets Manager | `password/lib/runtime-config.ts`, `wordlist.ts` |
| AWS-compatible secrets service: 17 operations, SigV4, versions/stages, soft delete, tags, managed client credentials | `secrets-manager/` |
| Loopback-only administrative surface for credential management | `secrets-manager/server.mjs` (uncommitted) |
| Operator CLI for secrets and credential rotation | `secrets-manager/cli.mjs` |
| dev/prd compose stacks, backup/restore, host nginx TLS edge | `bin/start.sh`, `deploy/nginx/` |

### Out of scope for v1 (explicit)

- Multi-tenant hosting, per-customer isolation, or self-service signup.
- Password **storage**, vaulting, sharing, or breach monitoring — the product generates, it does not keep.
- A public credential-minting API. Credential lifecycle is loopback/CLI only.
- Automated tests for the Next.js app (the service has a contract suite as of 2026-10-25; the app still has none).
- CI/CD pipeline (`.github/` absent) — `U2`.
- High availability / multi-instance Secrets Manager (single volume, single writer) — `A4`.

## 5. Audience and journeys

| Persona | Journey | Success means |
|---|---|---|
| **Operator** (primary) | Deploy via `./bin/start.sh`, seed policy, back up, rotate client credentials, restore | Repeatable deploy, reversible changes, credentials rotated without client downtime |
| **End user** (browser) | Open the site, choose mode and options, generate, copy | A strong value in under 2 s, no account, no trace left behind |
| **Integrating engineer** | Read the client guide, obtain a scoped credential, call `GetSecretValue` with an AWS SDK | Works with stock AWS tooling; least privilege by prefix |

## 6. Non-functional targets

| Dimension | Target | Label | Basis |
|---|---|---|---|
| Password generation latency (p95) | < 2 s | **assumed** | internal single-host tool baseline; not measured |
| Availability | Single host; best-effort, no SLA | **Confirmed** | one compose stack, one volume |
| Secret confidentiality at rest | AES-256-GCM, key outside the store | **Confirmed** | `store.mjs:643`, `masterKeySource` |
| Abuse resistance | Per-IP throttle + bounded concurrency + edge limits | **partial** | app-side caps shipped 2026-10-25; edge `limit_req` still pending approval |
| Recovery point objective (RPO) | Last backup bundle | **assumed** | manual backups under `backups/<env>/` |
| Recovery time objective (RTO) | Restore + recreate, minutes | **assumed** | `start.sh restore`; no measured drill |
| Accessibility | Keyboard-operable, labelled controls | **Unverified** | no audit performed |
| i18n | English only | **Confirmed** | `p2-locales` never set; UI strings are English |

## 7. Risks (top 6)

Full lifecycle in [RISK_REGISTRY](../RISK_REGISTRY.md).

| ID | Risk | Why it matters here |
|---|---|---|
| R5 | Deploying the uncommitted hardening from a dirty tree | No commit/tag/changelog provenance for a security-relevant change set |
| R6 | No edge rate limiting | Throttling is per-process and bypassable by concurrency |
| R7 | App holds the **instance-admin** Secrets Manager credential in production | One app compromise yields every secret and minting rights |
| R8 | Live credential files are world-readable (0755) | Any local process reads the admin key |
| R10 | Backups contain `master.key` | A backup copy is plaintext-equivalent |
| R9 | Verification against a stale tree | Was live in this repo: the dev container mounted a removed path |

## 8. Architecture directions (non-prescriptive - architecture foundation in doc 04)

- Keep **one** generator implementation; the API is a surface, not a second generator.
- Keep the Secrets Manager **dependency-free** — its value is auditability and a tiny supply-chain surface, and its contract suite now enforces that it stays wire-compatible.
- Treat the **wire contract** as the product boundary: clients are AWS SDKs, so compatibility is the feature.
- Prefer **loopback + CLI** for privileged operations; the public edge stays data-plane only.
- Any hardening must land **behind the contract suite**, not around it.

## 9. Open questions

1. Does the ACB client mint credentials at runtime, or only consume one? (`U4`)
2. Is the generator's static client actually flagged `readOnly: true`? (`U5`)
3. Which monitor consumes `/readyz` fields? (`U6`)
4. Is `requestsPerMinute: 0` a supported "disable" switch? (`U7`)
5. Which image build is running in production? (`U8`)

## 10. Next action

None — foundation docs 01–04 and ADRs 001–005 are on disk. Next gate: `@plan-master greenfield` once the two `fail` dimensions in [doc 04 §7](20261025-04-foundation-architecture.md) (rollback, threat model) are closed.

Related: [doc 02 integration](20261025-02-integration-facts.md) · [doc 03 adjacency](20261025-03-adjacency.md) · [doc 04 architecture foundation](20261025-04-foundation-architecture.md) · [ADR index](../../decisions/README.md) · [secrets-manager SPEC](../../features/secrets-manager/20261025-SPEC.md)

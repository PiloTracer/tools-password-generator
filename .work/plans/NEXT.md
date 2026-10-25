# NEXT - planning backlog

**Updated:** 2026-10-25

---

## Done

| Item | Artifact |
|------|----------|
| Agent OS bootstrap | `.work/` skeleton, `.cursorrules` from template |
| Agent OS thin-client setup (2026-10-25) | `.cursorrules` tokens filled, `.work/standards/` baselines, `DOCS_TECH_STACK.md`, `opencode.json`, 4 git hooks |
| **S1 audit** (2026-10-25) | `.work/reports/20261025-s1-audit-findings.md` — 24 app + 1 secret-manager findings, ranked, with per-item status |
| **S2 compat net** (2026-10-25) | `.work/features/secrets-manager/20261025-SPEC.md` + `secrets-manager/test/` (**40 tests**). Green on deployed `269b9c6` (38 pass, 2 skipped) and on the working tree (40 pass). |
| **S4 first tranche** (2026-10-25) | 11 findings fixed and verified, incl. rate-limit bypass, XFF trust, body cap, child-env allowlist, 413 on oversized bodies, `/readyz` leak. Documented gate green for the first time. |
| **S3 foundation from code** (2026-10-25) | `.work/plans/foundation/20261025-{01-initial-scope,02-integration-facts,03-adjacency,04-foundation-architecture}.md`; ADRs 001–005 in `.work/decisions/`; threat model `.work/standards/20261025-threat-model.md`. Links verified. |
| **Final readiness pass** (2026-10-25) | Edge proven functionally (403×4 credential ops, data-plane 200, spoofed XFF/X-Real-IP discarded, `/api/generate` throttled 11/25); APP-12 `--wordlist` wired; reduced-motion + live-region a11y; doc links and counts corrected. No CI, per owner. |
| **rpm defaulting** (2026-10-25) | `password/lib/rate-limit.ts`: `DEFAULT_REQUESTS_PER_MINUTE=30`, `normalizeLimit`, `coerceRequestsPerMinute`; `runtime-config.ts` delegates. Verified live: policy source stopped → 30 allowed, 31st 429. Unit tests 11 → 22. |
| **Master plan authored** (2026-10-25) | `20261025-full-plan.md` — 25 mandatory sections, 6 milestones, 21 tasks; `master-plan-verify.sh` → *standard conformance satisfied*. Status **Draft** (owner approval required). |
| **Certify blockers closed → plan-master-ready: yes** (2026-10-25) | B1: [web-surface SPEC](features/web-surface/20261025-SPEC.md) + 22 unit tests + 3 smoke guards. B2: [personas v1](20261025-personas-v1.md). Certify re-run passes with waivers W1–W4. |
| ~~S6 certify assessment~~ (2026-10-25, superseded) | First certify returned *no* (B1/B2). Both blockers closed the same day — see the row above. |
| **S4 tranche 2 — protected files** (2026-10-25) | nginx XFF overwrite + `limit_req`/`limit_conn` (`nginx -t` ok); container `mem_limit`/`cpus`/`pids_limit` both envs, prd rootfs `read_only` (verified); **`./bin/start.sh rollback`** with per-build image snapshots (verified end-to-end); `.env.*`/`.run`/`backups` 0600; `/api/ready` now readiness = generation capability. |
| **S5 on-box credential rotation** (2026-10-25) | `secrets-manager/cli.mjs`: `rotate-client-credential` / `revoke-client-credential` + admin-endpoint routing. Verified live: old key valid after rotate, new key unaffected by revoking old, revoked key rejected. Contract rules R35–R40 + 4 new tests (40 total). |
| **Stale dev container fixed** (2026-10-25) | Both dev containers were bind-mounted to the project's *previous* location, which no longer exists, so the app served pre-edit code. Recreated against the canonical path `/mnt/work/Projects/tools-password-generator`; mounts and gate verified. See the audit report §1.1. |

---

## Blocked on owner

| # | Item | Notes |
|---|------|-------|
| 1 | Five protected-file changes | nginx XFF + `limit_req`, compose limits, image pinning/rollback, scoped credential wiring, `chmod 600` of `.env.prd`/`.run`/`backups`. Enumerated in `.work/reports/20261025-s1-audit-findings.md` §5 |
| 2 | Recreate the dev app container | Its bind mount points at a deleted directory; until recreated it serves stale code |
| 3 | Answer U4–U8 | Credential-mint behaviour, `readOnly` state, `/readyz` consumers, `rpm: 0` semantics, live image provenance |

---

## Recommended next

| Priority | Item | Notes |
|----------|------|-------|
| **0** | M1-T2 — gated prd deploy | Code is committed; the hardening is still not deployed (`R5` remains until then) | Unblocks the remaining abuse fixes (edge rate limiting, container limits, rollback) |
| **1** | M2-T1 — scoped app credential in compose | Least privilege (APP-04); follows the deploy window |
| **2** | Accessibility audit (`U10`) | Direction and targets are documented in personas v1 §5; the audit itself is still owed |
| **3** | Remaining remediation | APP-04 scoped credential, APP-12 `--wordlist`, APP-17/18 restore safety, APP-20 health leak, APP-06 backup custody |
| **3** | Commit + tag the hardening (R5) | Still uncommitted; snapshots make it reversible but provenance is missing |

---

## Current iteration - M1: Freeze and ship the verified hardening

**Milestone ref:** M1 · `.work/plans/full/20261025-full-plan.md` §19
**Status:** planning
**Started:** -

### In scope
- Commit/tag the hardening + this program's changes
- Gated prd deploy with nginx install and post-deploy verification
- Record version + image digest

### Out of scope (explicit)
- Least privilege wiring (M2)
- Any wire-contract change

### Tasks
| ID | Description | Files | Status | Notes |
|----|-------------|-------|--------|-------|
| M1-T1 | Commit the release | repo root | done 2026-10-25 | committed + pushed on `main`; **tag still pending** |
| M1-T2 | backup → rebuild → recreate → nginx install/reload → verify | `bin/start.sh`, `deploy/nginx/agiolab.conf` | pending | needs owner approval for deploy |
| M1-T3 | Verify edge 403 ×4 targets; admin listener health; both clients authenticate | `bin/verify-secrets-manager.sh` | pending | |
| M1-T4 | Record version + digest | `HANDOFF.md`, `docs/production-deployment.md` | pending | closes `U8` |

### Acceptance criteria
- [ ] Tagged release exists
- [ ] All four credential targets return 403 at the edge
- [ ] Both live clients authenticate
- [ ] Version + digest recorded

### Validation steps
- [ ] `node --test secrets-manager/test/contract.test.mjs` — 40
- [ ] `npm test` + `npm run typecheck && npm run lint`
- [ ] `./bin/start.sh smoke prd`
- [ ] 403 probe per credential operation

### Owner blockers
- Deploy approval for the M1-T2 window (commit is done)

### Done this iteration
| Task | Completed | Notes |
|------|-----------|-------|
| - | - | - |

```markdown
## Current iteration - M{N}: <milestone name>

**Milestone ref:** M{N} · `{MASTER_PLAN}` §<task section>
**Status:** planning | in-progress | complete
**Started:** YYYY-MM-DD

### In scope
- …

### Out of scope (explicit)
- …

### Tasks
| ID | Description | Files | Status | Notes |
|----|-------------|-------|--------|-------|
| M{N}-T1 | … | … | pending | |

### Acceptance criteria
- [ ] …

### Validation steps
- [ ] Tests: `npm run typecheck && npm run lint` (per `.cursorrules`)
- [ ] Lint: `npm run lint`
- [ ] Type: `npm run typecheck`

### Owner blockers
- none

### Concept / NFR registry (this iteration)
| Concept id | Applies | Status | Evidence / trigger |
|------------|---------|--------|-------------------|
| MOD-06 | yes | pending | AI-assisted session |

### Cross-LLM verification
- Triggered: no

### Done this iteration
| Task | Completed | Notes |
|------|-----------|-------|
```

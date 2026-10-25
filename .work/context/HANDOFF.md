# HANDOFF - session boundary

## Session status

**Open:** 2026-10-25 — S1–S6 program session (closed same day)

**Updated:** 2026-10-25

**Closed:** 2026-10-25 — committed and pushed on `main` (`2afb913`); working tree clean

**Repository state:** Brownfield, in production. Live clients run commit `269b9c6`; the working tree holds the hardening diff plus this session's remediation. Contract suite 40/40 green on both revisions. Edge config functionally verified against stub upstreams (not only `nginx -t`). App gate green (typecheck + lint + **22 unit tests**). Smoke **13/13** including abuse-refusal guards. Foundation docs 01–04, ADRs 001–005, threat model, personas, two SPECs and a rollback path exist. **`Foundation-complete: yes`** · **`Plan-master-ready: yes` (2026-10-25, waivers W1–W4)**. Master plan **Approved** by the owner 2026-10-25. Public health/readiness endpoints sanitised (`HEALTH_VERBOSE` for detail) and the health probe now exercises a real generation. **Next: M1-T2 deploy window.**

**Recommended pick-up file:** `.work/plans/NEXT.md` (next action: **M1-T2 — gated prd deploy**)

**First 3 commands next session:** `git pull --ff-only` · `./bin/start.sh status dev` · `./bin/start.sh smoke dev`

**Lost or new?** Read `.ai/START_HERE.md` (from repo root).

---

## Fresh start - what the next session should do first

1. Run **`@session-control start`** (or follow the manual list in `session-control` skill).
2. Read **`.cursorrules`**.
3. Read **P0 initial scope** when present: `.work/plans/foundation/*-01-*-initial-scope.md`.
4. Read **this file** through §Fresh start, then §Open owner actions.
5. Read `.work/plans/NEXT.md`.
6. Read `.work/plans/ASSUMPTIONS.md`, `RISK_REGISTRY.md`, `UNKNOWNS.md`.

End with **`@session-control close`** (add `commit` / `commit push` only when requested). For mid-session checkpoints use **`@session-control commit`** or **`@session-control commit push`** (no close).

### Conditional reads (customize per project)

| If the task touches… | Read first |
|----------------------|------------|
| Product scope / foundation | `.work/plans/foundation/*-01-*.md` … `*-04-*.md` |
| Any code or new feature | `.work/standards/*CONVENTIONS*`, `*FEATURE_STANDARD*` |
| External integration | `*-02-*.md`, `.work/docs/integration/MANIFEST.txt` (if any) |
| Security | `.work/standards/*threat-model*` |
| Stack / topology | `DOCS_TECH_STACK.md` |
| Master plan / milestones | `.work/plans/full/*-full-plan.md` |
| High-risk feature | Relevant `.work/features/<slug>/*-SPEC.md` |

---

## Open owner actions

| # | Action | Blocks | Owner |
|---|--------|--------|-------|
| 1 | Approve 5 protected-file changes (nginx XFF + `limit_req`, compose limits, image pinning/rollback, scoped credential wiring, `chmod 600` of `.env.prd`/`.run`/`backups`) | Remaining abuse/ops fixes | owner |
| 2 | ~~Recreate the dev app container~~ — **done 2026-10-25**: both dev containers were bind-mounted to the project's previous location (now removed); recreated against `/mnt/work/Projects/tools-password-generator` and verified | — | eng |
| 3 | ~~Answer `U4`–`U8`~~ — **answered 2026-10-25** (U4 manual on-box credentials, U7 `rpm:0` is the disable switch, U6 resolved in practice) | — | owner |
| 4 | **Approve the master plan** — set `Status: Approved` in `.work/plans/full/20261025-full-plan.md`, or request changes | `implementation-ready`; M1 start | owner |
| 5 | **Commit + tag the release** (M1-T1) — draft message in §Draft commit below | `R5` provenance; deployability | owner |
| 6 | **Approve the prd deploy window** (M1-T2) — backup → rebuild → nginx install → verify | Shipping the hardening to production | owner |
| 7 | Accessibility audit (`U10`) | Any a11y claim | owner |

---

## Commit message used (close commit push)

**Subject:**

```
fix: harden the secrets manager, web surface and deploy path
```

**Body:**

```
Pin the deployed wire contract before changing it, then close the findings
that made the deployment unsafe to operate: caller-controlled rate-limit
identity, a limiter that erased its own counters, unbounded generator
concurrency, no body cap, and a public readiness probe that fingerprinted
the store. Add per-build image snapshots with a rollback command, container
resource ceilings, a read-only production rootfs, 0600 credential files and
an edge rate limit. Make rotation outage-free with a two-phase CLI.

Contract compatibility is proven: 40 tests are green against the deployed
revision as well as the tree, so existing clients are unaffected.
```

**Suggested `git add` scope:**

- `.work/` (plans, features, decisions, reports, standards, context, touch-scope)
- `.env.example` · `README.md` · `DOCS_TECH_STACK.md` · `.cursorrules` · `opencode.json`
- `password/` · `password_generator.py` · `secrets-manager/` · `bin/` · `deploy/` · `docs/`
- `docker-compose.dev.yml` · `docker-compose.prd.yml`

**Never staged** (git-ignored, verified): `.env.dev`, `.env.prd`, `.run/`, `backups/`, `tmp/`.

**Tag suggestion:** `v1.1.0-hardening` (not yet applied).

---

## What this cycle produced (audit history - skim last session only)

| Date | Session | Artifacts |
|------|---------|-----------|
| 2026-10-25 | Final readiness pass | Edge proven functionally (403×4, data-plane 200, spoofed identity discarded, throttling at 11/25); `--wordlist` wired (APP-12); reduced-motion + live-region a11y; 10 broken plan links + stale counts fixed. |
| 2026-10-25 | rpm defaulting | `requestsPerMinute`: absent/junk/negative/sub-1 → built-in **30**; only explicit `0` disables. Proven live by stopping the Secrets Manager: 30×200 then 429. Tests 11 → 22. Seed: prd 30, dev 120. |
| 2026-10-25 | Certify blockers closed | `.work/features/web-surface/20261025-SPEC.md`; `.work/plans/20261025-personas-v1.md`; `password/test/` (22 unit tests) + `npm test`; 3 smoke guards → smoke 13/13. Certify re-run: **plan-master-ready: yes** |
| 2026-10-25 | S6 certify assessment | `.work/reports/20261025-s6-certify.md` — integrity checklist + 10 S4 criteria; verdict *no* (B1, B2) |
| 2026-10-25 | S4 tranche 2 (owner-approved) | nginx XFF + `limit_req`/`limit_conn`; container limits + prd `read_only`; **`rollback` command** (verified end-to-end); file modes 0600; `/api/ready` readiness semantics |
| 2026-10-25 | S3 foundation + S5 rotation | `.work/plans/foundation/20261025-01..04`; ADRs 001–005; `.work/standards/20261025-threat-model.md`; `cli.mjs` two-phase rotation (live-verified); contract suite 40 tests |
| 2026-10-25 | S1 audit + S2 compat net + S4 tranche 1 | `.work/reports/20261025-s1-audit-findings.md`; `.work/features/secrets-manager/20261025-SPEC.md`; `secrets-manager/test/` (36 tests, now 40); 11 fixes in `secrets-manager/`, `password/lib/`, `password/app/`, `password_generator.py` |

---

## Explicit unknowns (promoted from UNKNOWNS)

| ID | Summary | Blocks |
|----|---------|--------|
| - | | |

---

## Cross-LLM verification

- **Triggered:** no
- **Result:** -
- **Notes:** -

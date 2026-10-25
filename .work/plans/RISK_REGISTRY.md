# RISK_REGISTRY - planning registry

**Updated:** 2026-10-25 · **Maintained by:** plan-foundation / plan-master

Status: **Open** | **Mitigated** | **Accepted** | **Closed**

| ID | Risk | Category | Likelihood | Impact | Mitigation | Status | Owner |
|----|------|----------|------------|--------|------------|--------|-------|
| R1 | Scope creep before foundation complete | process | M | M | plan-foundation gates; no broad coding until implementation-ready | Open | eng |
| R2 | Agent marks gate pass without evidence | process / agent | M | M | `.cursorrules` Completion Gate; code-verify | Mitigated | eng |
| R3 | Secrets committed to git | security | L | H | `.cursorrules` secrets scan; pre-commit | Open | eng |
| R4 | Wordlist edited without re-seeding the integrity digest → `/api/ready` returns 503 | data | M | M | wordlist is protected (`.work/PROTECTED_SURFACES.json`); re-seed with `./bin/start.sh secrets <env> seed` | Open | eng |
| R5 | Deploying the uncommitted 531-line hardening from a dirty tree loses provenance (no commit, tag or changelog) | process / ops | H | H | Contract suite proves behaviour-compatibility; build snapshots + `rollback` make a bad deploy reversible. **Still needs a commit + tag before deploy** (feedback R1). | Mitigated (partial) | owner |
| R6 | The deployed edge has no `limit_req`/`limit_conn`, so throttling is per-process and bypassable by concurrency | abuse / availability | H | H | App-side cap (8 concurrent) + container limits + **edge `limit_req` 20 r/m / `limit_conn` 5 added 2026-10-25**. Edge config still needs installing on the host. | Mitigated | eng |
| R7 | The app authenticates to the Secrets Manager with the **instance admin** key in production | security | M | H | Scoped read-only credential exists in `bin/ensure-app-credentials.py` + compose override, but is uncommitted/undeployed (APP-04) | Open | owner |
| R8 | Live credentials are world-readable on the host | security | M | H | **Fixed 2026-10-25** — `.env.*`, `.run/*`, `backups/**` now 0600 (dirs 0700) | Closed | eng |
| R9 | Local verification was silently validating the wrong tree (stale bind mount to a deleted path) | process / agent | H | M | Gate now runs as a one-off container against this workspace; dev container must be recreated | Mitigated | eng |
| R10 | Backups contain the store `master.key` and only a self-written SHA-256 | security | M | H | Files are now 0600, but an off-host copy is still plaintext-equivalent. Needs key-custody design (APP-06). | Open | owner |
| R11 | No `read_only` app rootfs in dev, and Next.js may write outside `/tmp` on a future version bump | ops | L | M | prd verified read-only; dev intentionally writable (bind-mounted dev server) | Accepted | eng |
| R12 | Secrets Manager is a single-writer, single-volume service — no horizontal scaling and no concurrent-instance safety | scalability | H (if demanded) | H | Accepted for the stated single-host use; resolving it means replacing the store backend (ADR 004), not adding replicas | Accepted | owner |
| R13 | Public web surface (`/api/generate`) has no SPEC and no automated tests, while being the top abuse target | verification / abuse | H | M | Threat model covers it (T1–T5); app-level behavioural tests are still owed — blocks plan-master-ready | Open | eng |

## Review log

| Date | Reviewer | Action |
|------|----------|--------|
| 2026-10-25 | deploy-basic | Seeded from repo evidence |
| 2026-10-25 | S1 audit | R5–R10 added (deploy provenance, edge abuse limits, least privilege, host file modes, stale-mount verification trap, backup key custody) |
| 2026-10-25 | Tranche 2 | R5/R6 mitigated, R8 closed, R10 narrowed to off-host custody, R11 added |
| 2026-10-25 | Certify prep | R12 (single-writer scaling, accepted), R13 (no web-surface SPEC/tests, open) added |

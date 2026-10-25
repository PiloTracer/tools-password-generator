# ASSUMPTIONS - planning registry

**Updated:** 2026-10-25 · **Maintained by:** plan-foundation / plan-master

Label every entry: **Confirmed** | **Inference** | **Unverified** | **Rejected**

| ID | Assumption | Label | Source | Notes |
|----|------------|-------|--------|-------|
| A1 | Browser and CLI must share one generator implementation (`password_generator.py`) so every password is auditable | Confirmed | `README.md` §1, `password/app/api/generate/route.ts` | API shells out to the same script |
| A2 | Docker Compose (dev/prd) is the only supported runtime; app commands run inside the `app` service | Confirmed | `.cursorrules` §Docker, `docker-compose.*.yml` | Host-side npm/next is not supported |
| A3 | Production TLS terminates on host nginx, outside Docker | Confirmed | `deploy/nginx/agiolab.conf` | Certificates issued on the host |
| A4 | No relational DB or queue is needed; the encrypted secrets volume is the only persisted state | Confirmed | `docker-compose.*.yml`, `README.md` §1 | Revisit if multi-instance scaling is required |
| A5 | Production runs commit `269b9c6` **without** the uncommitted 531-line hardening | Confirmed | owner statement 2026-10-25; feedback F-02 | The contract suite is pinned against that revision |
| A6 | The uncommitted hardening is backwards-compatible with both live clients, and its only intended behaviour change is BC9 (credential operations become loopback-only) | Confirmed | 40/40 contract tests pass on the working tree; 38 pass + 2 skipped on `269b9c6` | Evidence, not opinion — but only covers the wire contract, not throughput |
| A7 | The password-generator uses a static **read-only** credential scoped to `password-generator/<env>/` | Unverified | feedback §5 | `ReadOnly` is absent from `GetClientCredential` on `269b9c6`; whether the deployed client sets it is unconfirmed (U5) |
| A8 | One managed client exists in the production store (most plausibly ACB) | Inference | feedback §7 (`/readyz` reported `managedClients: 1`) | Not confirmed by `ListClientCredentials` (no credential used) |

## Rejected

| ID | Assumption | Reason |
|----|------------|--------|
| 1 | "The repo's documented gate passes" | Rejected 2026-10-25: `npm run lint` failed on `HEAD` (`ThemeToggle.tsx:11`), and the dev container was serving a stale tree. Both fixed/identified this session. |
| 2 | "The dev container reflects the working tree" | Rejected (then fixed): it was bind-mounted to the project's previous location, which had been removed. Recreated 2026-10-25 against the canonical path `/mnt/work/Projects/tools-password-generator`; the container now serves the working tree. |

## Review log

| Date | Reviewer | Action |
|------|----------|--------|
| 2026-10-25 | deploy-basic | Seeded from repo evidence |
| 2026-10-25 | S1 audit | A5–A8 added; two assumptions rejected (gate state, container fidelity) |

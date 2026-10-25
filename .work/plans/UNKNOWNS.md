# UNKNOWNS - planning registry

**Updated:** 2026-10-25 · **Maintained by:** plan-foundation / plan-master

| ID | Question / blocker | Blocks | Owner | Status |
|----|-------------------|--------|-------|--------|
| U1 | No automated test suite — **resolved 2026-10-25**: `secrets-manager/test/` pins the wire contract (40 tests) and `password/test/` covers the limiter, concurrency ceiling and rpm coercion (22 tests). Remaining gap: no CI to run them (`U2`). | CI quality gate | owner | Resolved |
| U2 | No CI pipeline (`.github/` absent) — choose platform | Pipeline design | owner | Open |
| U3 | tools-project MCP not provisioned (entry removed from `opencode.json`) — decide whether this repo needs it | Optional tooling | owner | Open |
| U4 | Does the ACB client mint credentials at runtime, or only consume one? | — | owner | **Answered 2026-10-25:** admin supplies credentials manually on the server (bash or a non-internet-exposed API). BC9 confirmed safe. |
| U5 | Is the generator's static client flagged `readOnly: true`? If not, BC7 is inert today. | S4 hardening value | owner | Open |
| U6 | Which monitor consumes `/readyz` payload fields? | — | owner | **Resolved in practice:** no in-repo consumer reads the fields (healthchecks use `/healthz`; `verify-secrets-manager.sh` checks only the status code). Public payload reduced to `{status, ok, version}`. External monitors, if any, would see fewer fields. |
| U7 | Is `requestsPerMinute: 0` a supported "disable throttling" switch? | — | owner | **Answered 2026-10-25:** yes, it is a valid disable switch. Left unclamped by design. |
| U8 | Which build/image is actually running in production (`docker image inspect` on the host)? Feedback F-04 suggests `269b9c6`, but this was inferred from `GET /`, not inspected. | Every deploy decision | owner | Open |
| U9 | Separator edge cases (R12) and integrity-enforcement flips (R13) are manual-only; automate or accept? | Web-surface test matrix | owner | Open |
| U10 | Accessibility audit not run — reduced motion, live announcements and control labelling are now implemented; contrast, focus visibility, 360 px layout and a keyboard walkthrough remain unverified | Any a11y claim; UI polish scope | owner | Partially resolved |

## Review log

| Date | Reviewer | Action |
|------|----------|--------|
| 2026-10-25 | deploy-basic | Populated from repo evidence (no tests, no CI, no MCP) |
| 2026-10-25 | S1 audit | U1 partially resolved (contract suite); U4–U8 added from the S1 audit + pilo-mail feedback |

# FEATURE_STANDARD — Secure Password Generator

**What this is:** how a feature travels from idea to shipped code in this repository.
**Status:** Draft — baseline generated 2026-10-25; on conflict the framework contract wins (`$AGENT_OS_SOURCE/standards/20260517-FEATURE_STANDARD.md`).
**Needs:** maintainer review before the first SPEC.

## Lifecycle

1. **SPEC** — `.work/features/<slug>/YYYYMMDD-SPEC.md` (status line, goal, non-goals, testable acceptance criteria, affected paths).
2. **Plan** — link the SPEC to a milestone in `.work/plans/full/*-full-plan.md`. No master plan exists yet → propose one via `@plan-master`.
3. **Implement** — `@code-implementation` from `.work/plans/NEXT.md`; declare scope in `.work/touch-scope` first.
4. **Verify** — `@code-verify`. Gates: `npm run typecheck && npm run lint` inside the `app` container; add `./bin/check-env-parity.sh` when env files change.
5. **Close** — `@session-control close` updates HANDOFF/NEXT; add an ADR when a boundary or wire contract changed.

## Required SPEC sections

Context · Goal · Non-goals · Acceptance criteria (testable) · Affected paths · Secrets/env impact · Rollback · Open questions.

## Non-negotiables

- Security-sensitive changes (secrets-manager contract, SigV4, nginx headers) need a threat note and `@soc` review.
- Any change to `secrets-manager/openapi.yaml` also updates `docs/secrets-manager-client-guide.md`.
- No feature ships without evidence of the §Lifecycle step 4 gates.

## Next action

`@plan-foundation greenfield` — create the foundation docs that SPECs will cite.

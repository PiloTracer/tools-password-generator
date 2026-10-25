# Architectural Decision Records (ADRs)

Project-specific ADRs. Process: `.ai/skills/plan-foundation/skill.md` P2 · pointer: `.ai/decisions/README.md`.

## Conventions

- **Filename:** `YYYYMMDD-NNN-short-slug.md` (3-digit zero-padded NNN)
- **Status:** `Proposed | Decided | Deferred | Superseded by <ADR id>`
- **Sections:** Context · Decision · Consequences · Alternatives · References
- **Never edit** a `Decided` ADR - supersede with a new file
- Foundation register in `*-04-foundation-architecture.md` §13 must agree; **ADRs win** on conflict

## Index

| ADR | Topic | Status |
|-----|-------|--------|
| [001](20261025-001-backend-stack.md) | Generator core in Python, surface in Next.js | Decided (synthesized 2026-10-25) |
| [002](20261025-002-hosting-and-edge.md) | Single host, Compose per environment, host nginx TLS | Decided (synthesized 2026-10-25) |
| [003](20261025-003-tenancy-and-credentials.md) | Single tenant; instance admin + prefix-scoped clients; loopback admin | Decided (synthesized 2026-10-25) |
| [004](20261025-004-secrets-storage.md) | Encrypted single-document store instead of a database | Decided (synthesized 2026-10-25) |
| [005](20261025-005-credential-rotation.md) | Two-phase client credential rotation | Proposed — needs owner approval |

**Template:** `.ai/templates/work/decisions/YYYYMMDD-NNN-slug.md.template`

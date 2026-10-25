# `.work/` - project working tree

**Purpose:** All **project-specific** artifacts: plans, SPECs, ADRs, prompts, and session handoff.

**Agnostic** process (skills, standards, concepts, guides) lives under **`.ai/`** only.

## Layout

| Path | Contents |
|------|----------|
| `.work/plans/` | Foundation docs (`*-01-*` … `*-04-*`), master plan (`full/*-full-plan.md`), registries, `NEXT.md`, operations runbooks |
| `.work/features/<slug>/` | Feature SPECs, amendments, `CHANGELOG.md` per FEATURE_STANDARD |
| `.work/docs/` | Human-readable docs: guides, tutorials, reference, feature docs |
| `.work/docs/guides/` | How-to guides (`YYYYMMDD-<slug>.md`) |
| `.work/docs/tutorials/` | Step-by-step tutorials (`YYYYMMDD-<slug>.md`) |
| `.work/docs/reference/` | Reference / API docs (`YYYYMMDD-<slug>.md`) |
| `.work/docs/features/<slug>/` | Per-feature user documentation |
| `.work/prompts/` | Decision questionnaires; optional user scratch (`initial.md` - **not read by skills** unless user names it) |
| `.work/decisions/` | ADRs (`YYYYMMDD-NNN-*.md`) |
| `.work/context/` | `HANDOFF.md` - read/write via `@session-control` |

## Placeholder map

Configured in `.cursorrules` § Workflow bootstrap:

| Placeholder | Resolves to |
|-------------|-------------|
| `{WORK_ROOT}` | `.work/` |
| `{PLANS_ROOT}` | `.work/plans/` |
| `{FEATURE_SPEC_ROOT}` | `.work/features/` |
| `{PROMPTS_ROOT}` | `.work/prompts/` |
| `{DOCS_ROOT}` | `.work/docs/` |
| `{DECISIONS_ROOT}` | `.work/decisions/` |
| `{ITERATION_CARRIER}` | `.work/plans/NEXT.md` |
| `{MASTER_PLAN}` | `.work/plans/full/*-full-plan.md` (latest **Approved**) |
| `{HANDOFF}` | `.work/context/HANDOFF.md` |

## Quick pick-up

1. `.work/context/HANDOFF.md`
2. `.work/plans/NEXT.md`

Operator entry: `.ai/START_HERE.md`

## Bootstrap

If this tree was created empty, run from repo root:

```bash
bash .ai/templates/bootstrap.sh
```

Or invoke `@project-bootstrap init`.

Foundation docs **01–04** are created by `@plan-foundation greenfield` (templates under `.ai/templates/work/plans/foundation/`).

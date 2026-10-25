# Project documentation (`.work/docs/`)

Human-readable documentation: guides, tutorials, reference material, and feature docs (not formal SPECs).

## Layout

| Path | Contents |
|------|----------|
| `.work/docs/guides/` | Task-oriented how-to guides (`YYYYMMDD-<slug>.md`) |
| `.work/docs/tutorials/` | Step-by-step walkthroughs (`YYYYMMDD-<slug>.md`) |
| `.work/docs/reference/` | Reference / API docs (`YYYYMMDD-<slug>.md`) |
| `.work/docs/features/<slug>/` | Per-feature user documentation — what it does, how to use it |

## Scaffold templates (Agent OS)

| Output | Template (literal `slug` / `example-slug` in the path — never `<>`) |
|--------|---------------------------------------------------------------------|
| `.work/docs/guides/YYYYMMDD-<slug>.md` | `templates/work/docs/guides/YYYYMMDD-slug.md.template` |
| `.work/docs/tutorials/YYYYMMDD-<slug>.md` | `templates/work/docs/tutorials/YYYYMMDD-slug.md.template` |
| `.work/docs/reference/YYYYMMDD-<slug>.md` | `templates/work/docs/reference/YYYYMMDD-slug.md.template` |
| `.work/docs/features/<slug>/README.md` | `templates/work/docs/features/example-slug/README.md.template` |

## Feature docs vs SPECs

- **`.work/features/<slug>/SPEC.md`** — formal behavioural SPEC per FEATURE_STANDARD (for planning & implementation)
- **`.work/docs/features/<slug>/README.md`** — human-readable feature documentation (for users, operators, brownfield discovery)

**Create:** `@docs create guide - <slug>` · `@docs create tutorial - <slug>` · `@docs create reference - <slug>` · `@feature-spec document - <slug>` (brownfield feat. docs)

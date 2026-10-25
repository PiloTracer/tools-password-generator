# CONVENTIONS — Secure Password Generator

**What this is:** binding code layout, naming, and maintainability rules for this repository.
**Status:** Draft — baseline generated 2026-10-25 from repo evidence (`password/`, `secrets-manager/`, `bin/`); refine via `@plan-foundation` P3.
**Needs:** maintainer review before the first feature SPEC.

## Layout

- One Next.js app (`password/`) holds both UI and API; route handlers live in `password/app/api/<name>/route.ts`.
- One Node service (`secrets-manager/`) owns the secret store; `password_generator.py` at repo root is the single generator implementation shared by CLI and API.
- Host operations live in `bin/` (bash, plus one Python helper); edge config in `deploy/nginx/`. Do not introduce a root `src/` or `lib/`.

## Naming

- Files: kebab-case (`runtime-config.ts`, `check-env-parity.sh`); `password_generator.py` is the historical exception.
- React components: PascalCase file (`components/PasswordGeneratorForm.tsx`).
- Secrets-manager modules: ESM `.mjs` under `secrets-manager/lib/`; CommonJS is not used there.
- Env vars: SCREAMING_SNAKE_CASE, one key per line in `.env.example` — line alignment is enforced by `bin/check-env-parity.sh`.

## TypeScript / Python

- `tsconfig.json`: `strict: true`, `moduleResolution: bundler`, alias `@/*` → app root. No new `any`.
- Python: standard library only (`secrets.SystemRandom`), `argparse` CLI, no third-party imports in `password_generator.py`.

## Errors and logs

- Never log secrets, master keys, access keys, or generated passwords; log internal IDs/status only (`secrets-manager/lib/logger.mjs`).
- API responses are sanitized: do not echo upstream AWS error payloads to the browser.

## Change hygiene

- Follow `.cursorrules`: minimal diffs, declared scope, MOD-06 for agent-authored code.
- Protected paths: `.work/PROTECTED_SURFACES.json` (compose, Dockerfiles, app config, wordlist, edge nginx).

## Next action

`@plan-foundation` P3 — promote this baseline into the foundation CONVENTIONS document.

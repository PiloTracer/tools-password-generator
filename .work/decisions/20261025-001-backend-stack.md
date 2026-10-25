# ADR 001 — Generator core in Python, surface in Next.js

**Status:** Decided (brownfield synthesis 2026-10-25) · **Needs:** nothing
**Brownfield synthesis:** reconstructed from the shipped tree; the original deciding discussion is not recorded.

## Context

Two consumers need identical password generation: a browser UI and a command-line interface. Duplicating the algorithm would make "the password you saw in the browser" and "the password the CLI produced" two different claims to audit. The operator also needs the tool to work on a host with no package manager privileges.

## Decision

Keep **one** generator implementation in Python (`password_generator.py`, stdlib only, `secrets.SystemRandom`) and make the Next.js app a *surface* that executes it as a child process. The app validates input, maps policy, runs the script with a timeout and output cap, and returns the last non-empty output line.

## Consequences

- Auditability: one file to review, one entropy source, no second implementation to drift.
- Cost: a process spawn per request (~18 MB, 20-30 ms) — bounded to 8 concurrent as of 2026-10-25.
- The app cannot be deployed without a Python 3 runtime in its image.
- Changes to generation semantics are a change to a file that the CLI also exposes — a single review point.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Reimplement generation in TypeScript | Two implementations = two truths; `secrets.SystemRandom` parity is hard to prove |
| Pure in-process Node crypto | Would abandon the shared-CLI guarantee that motivates the product |
| Python HTTP service for generation | Extra network hop and a third deployable for no benefit at this scale |

## References

`password_generator.py`; `password/app/api/generate/route.ts`; `password/lib/generator.ts`; `README.md` §1; foundation doc 04 §1 (BC-GEN).

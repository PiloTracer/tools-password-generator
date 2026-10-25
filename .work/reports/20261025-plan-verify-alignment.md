# plan-verify alignment — NEXT ↔ master plan

**What this is:** the alignment gate result for S6, comparing the iteration carrier (`.work/plans/NEXT.md`) with the master plan (`.work/plans/full/20261025-full-plan.md`).
**Status:** Pass — 2026-10-25
**Needs:** nothing.

---

## 1. Mechanical results

| Check | Result |
|---|---|
| Master plan conformance (`master-plan-verify.sh`) | **pass** — all 25 mandatory H2 sections present and ordered; approval/integrity consistent |
| Tasks defined in the plan | 21 (6 milestones) |
| Tasks in the NEXT iteration block | 4 — all from M1 |
| NEXT tasks absent from the plan | **none** |
| M1 coverage | **complete** — `M1-T1 … M1-T4` in both, same IDs and file paths |
| Recommended next references a real task | **yes** — `M1-T1` |
| Tasks with an FR/NFR link | **21 / 21** |
| FRs defined → referenced in the traceability matrix | **11 / 11**, untraced: none |

## 2. Semantic checks

| Check | Result |
|---|---|
| NEXT recommends exactly one action | **yes** (priority 0 = M1-T1) |
| Owner blockers in NEXT match the plan's dependencies | **yes** — commit approval (M1-T1) and deploy approval (M1-T2) |
| Plan's stated test counts match reality | **yes** — contract 40, unit 11, smoke 13 (verified this session) |
| Plan cites foundation + SPECs that exist | **yes** — all links resolve |
| Plan status honest | **Draft** — not Approved; the owner has not signed off |
| No milestone contradicts an ADR | **yes** — M2 follows ADR 003, M4 follows ADR 004, rotation follows ADR 005 |

## 3. Drift found and corrected this pass

| Item | Was | Now |
|---|---|---|
| NEXT `Recommended next` | "`@plan-master greenfield`" (plan did not exist) | `M1-T1` from the plan |
| NEXT `Current iteration` | placeholder template | M1 block with the plan's four task rows |
| NEXT test counts | 36 tests / 34+2 | 40 tests / 38+2 |
| NEXT certify row | said plan-master-ready **no** | marked superseded (both blockers closed) |

## 4. Verdict

**Alignment: pass.** The carrier points at the plan, the plan points at the foundation, and the foundation points at the code. No orphan task, no orphan requirement.

## 5. Next action

Owner review of the master plan: set **Status: Approved** in `.work/plans/full/20261025-full-plan.md` header, or request changes.

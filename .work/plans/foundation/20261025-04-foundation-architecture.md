# Secure Password Generator — Architecture foundation (doc 04)

**What this is:** the approved-shape architecture proposal for the password toolchain — bounded contexts, dependency direction, runtime topology and the decisions register. **Not** the master implementation plan (`*-full-plan.md`).
**Status:** Approved — 2026-10-25
**Needs:** owner acknowledgement of the two open shape questions in §11.

**Brownfield synthesis 2026-10-25:** derived from the shipped tree at `269b9c6` plus the uncommitted hardening. Inferred structure is labelled **Inference**.

---

## 1. Bounded contexts

| # | Context | Owns | Code | Depends on |
|---|---------|------|------|-----------|
| **BC-GEN** | Generator core | Password/passphrase construction, entropy source, word list | `password_generator.py`, `eff_short_wordlist_1.txt` | nothing |
| **BC-WEB** | Web surface | UI, HTTP API, input validation, throttling, policy consumption | `password/app/`, `password/lib/` | BC-GEN (process), BC-SM (read-only) |
| **BC-SM** | Secrets service | Wire contract, SigV4, authorization, encrypted store, credential lifecycle | `secrets-manager/` | nothing (zero npm deps) |
| **BC-OPS** | Control plane | Compose orchestration, backup/restore, seeding, credential provisioning, operator CLI | `bin/`, `secrets-manager/cli.mjs`, `secrets-manager/seed.mjs` | BC-SM (client), Docker |
| **BC-EDGE** | Edge | TLS termination, HSTS, header hygiene, credential-op deny, request limits | `deploy/nginx/` | BC-WEB, BC-SM |

**Inference:** the context split follows the deployable units and the credential boundary, not a folder name; nothing in the repo declares it.

## 2. Dependency direction (must stay acyclic)

```text
BC-EDGE ──► BC-WEB ──► BC-GEN            (spawn: one process per request, bounded at 8)
   │           │
   │           └────► BC-SM  (SigV4, read-only policy + integrity digest)
   │                     ▲
   └─────────────────────┘ (data-plane only on the public edge)

BC-OPS ──► BC-SM (admin loopback only)
BC-OPS ──► Docker / volumes / backups
```

**Rules**

| ID | Rule | Evidence |
|---|---|---|
| A1 | BC-GEN is a leaf: it imports nothing from this repo and must stay dependency-free. | `password_generator.py` imports stdlib only |
| A2 | BC-WEB never re-implements generation; it validates input and executes BC-GEN. | `password/app/api/generate/route.ts` → `lib/generator.ts` |
| A3 | BC-SM never imports BC-WEB or BC-GEN; it is a generic secrets service. | `secrets-manager/package.json` has zero dependencies |
| A4 | Privileged operations reach BC-SM only through the loopback listener, never through the public edge. | `server.mjs` admin listener (uncommitted); contract rule BC9 |
| A5 | BC-EDGE carries no business logic — only transport concerns and deny rules. | `deploy/nginx/agiolab.conf` |

## 3. Runtime topology

```text
Internet ──443──► host nginx (TLS, HSTS, deny-map, [limit_req pending])
                     ├──► app  :3000  (Next.js UI + /api/*)
                     │        └── python3 password_generator.py  (bounded, 8 in flight)
                     │        └── SigV4 read ──► secrets-manager :8080 (data plane)
                     └──► secrets-manager :8080 (data plane only)
                  secrets-manager :8081  (loopback admin: credential lifecycle only)
                     └── encrypted volume: store.json + master.key
```

Only 80/443 are public. Both app and secrets ports are published on loopback only (`README.md` §1).

## 4. Data ownership

| Data | Owner | Persistence | Sensitivity |
|---|---|---|---|
| Generated passwords | BC-GEN → caller | **never persisted** | secret-in-transit only |
| Policy (limits, feature flags) | BC-SM | encrypted store | low |
| Word-list digest | BC-SM | encrypted store | low (integrity) |
| Client credentials | BC-SM | encrypted store (managed) or env (static) | **high** |
| Master key | BC-SM | env or `master.key` in volume | **critical** |
| Backups | BC-OPS | `backups/<env>/` | **critical** (contains master key — APP-06) |

## 5. Cross-cutting concerns

| Concern | Current state |
|---|---|
| **Auth** | SigV4; instance admin vs prefix-scoped clients; `readOnly` flag (uncommitted) |
| **Observability** | Structured JSON logs with `requestId`; `/healthz` liveness; `/readyz` readiness (public payload reduced 2026-10-25); no metrics endpoint, no tracing |
| **Throttling** | Fixed-window per-IP in the app (fail-closed at capacity); concurrency cap 8; **edge `limit_req` not deployed** |
| **Secrets handling** | AES-256-GCM at rest; AAD binds version to secret; Python child gets an allowlisted env |
| **Failure modes** | Policy layer fails **open** (defaults) on a Secrets Manager outage — intentional but unmonitored (`APP-11`) |

## 6. Deployment realism

| Dimension | Assessment |
|---|---|
| Deploy path | `./bin/start.sh up|recreate|rebuild <env>`; compose per env |
| Rollback | **Missing.** Images are mutable local tags, previous images deleted (`APP-08`). This is the weakest operational link. |
| Migrations | None; store carries `schemaVersion: 1` and no migration runner yet |
| Backup/restore | Exists and is exercised by `start.sh`; restore trusts the archive (`APP-18`) |
| Single points of failure | The host itself; one volume; one Secrets Manager writer |
| Portability | dev/prd share host ports by design — one environment per host |

## 7. Architecture fitness review (2026-10-25)

| Dimension | Verdict | Note |
|---|---|---|
| Scalability | **partial** | Single writer/volume is the ceiling; adequate for the stated single-host use, not for HA |
| Maintainability | **pass** | Clear contexts; the generator is one file shared by both surfaces |
| Operational complexity | **partial** | No rollback; destructive verbs in a 111 KB `start.sh` without `set -e` (`APP-17`) |
| Coupling | **pass** | Acyclic; BC-SM has zero dependencies |
| SPOFs | **known** | Single host, single volume — accepted for v1 |
| Extensibility | **pass** | Wire contract is the boundary; AWS SDK clients work unmodified |
| Deployment realism | **pass** | Build snapshots + `./bin/start.sh rollback` added 2026-10-25 (`APP-08` closed) |
| Observability | **partial** | Good request-level logs; no metrics/traces |
| Rollback | **pass** | `rollback [stamp\|latest\|--list]`, keeps 5 snapshots, snapshots current images before rolling back |
| Security | **partial** | Contract hardened; least privilege (APP-04) and host file modes (APP-05) open |

Both former `fail` dimensions were **operational**, not architectural — they closed in `bin/start.sh` + compose (rollback, resource ceilings) without reshaping any context.

## 8. What must not change

- The 17-operation wire contract and SigV4 acceptance for existing credentials (`BC1`, `BC2`, `BC3`).
- Store ciphertext compatibility — AAD format, key derivation, layout (`BC8`).
- Version/stage/soft-delete semantics (`BC10`).
- "No password is ever persisted or logged."

## 9. Decisions register (§13)

| ADR | Decision | Status |
|---|---|---|
| [001](../../decisions/20261025-001-backend-stack.md) | Python CLI + Next.js/Node surface | Decided (synthesized) |
| [002](../../decisions/20261025-002-hosting-and-edge.md) | Single host, Docker Compose per env, host nginx TLS | Decided (synthesized) |
| [003](../../decisions/20261025-003-tenancy-and-credentials.md) | Single-tenant; instance admin + prefix-scoped clients; loopback admin | Decided (synthesized) |
| [004](../../decisions/20261025-004-secrets-storage.md) | Encrypted single-document store instead of a database | Decided (synthesized) |
| [005](../../decisions/20261025-005-credential-rotation.md) | Two-phase credential rotation | Proposed |

## 10. Foundation gate (§14)

| Criterion | State |
|---|---|
| Bounded contexts + dependency direction documented | **yes** (§1–§2) |
| NFR targets recorded with labels | **yes** (doc 01 §6) |
| Data model + sensitivity classified | **yes** (§4) |
| Core ADRs decided | **yes** — 4 decided, 1 proposed |
| Highest-risk context has a SPEC | **yes** — [secrets-manager SPEC](../../features/secrets-manager/20261025-SPEC.md) (40 rules, 10 BC invariants) and [web-surface SPEC](../../features/web-surface/20261025-SPEC.md) (20 rules, 4 invariants) |
| Contract pinned by tests | **yes** — 40 tests, green on deployed `269b9c6` and on the tree |
| Rollback strategy | **yes** — per-build image snapshots + `./bin/start.sh rollback` (verified end-to-end) |
| Threat model document | **yes** — [20261025-threat-model.md](../../standards/20261025-threat-model.md) (18 threats, 6 trust boundaries) |

**Verdict: foundation-complete = yes** and **plan-master-ready = yes** (certified 2026-10-25, with waivers U5/U8 open and the accessibility audit outstanding). See `.work/reports/20261025-s6-certify.md`.

## 11. Open shape questions

1. **Should the Secrets Manager be reachable from the public internet at all?** Today the data plane is; the admin plane is not. Binding it to the private network would cut a whole class of abuse but changes how clients reach it.
2. **Is single-host acceptable long-term?** If not, the current single-writer store is the constraint that must be resolved first.

## 12. Next action

Write ADRs 001–005 into `.work/decisions/` and link them from §9.

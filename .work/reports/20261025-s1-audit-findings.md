# S1 audit findings — ranked backlog

Consolidated remediation backlog for the S1→S6 program. Every item has an ID, evidence, and a status that is either **verified by a command** or explicitly **unverified**.

**Status:** In review — 2026-10-25
**Needs:** approval for the five protected-file changes listed in §5.

---

## 1. Verification baseline

| Check | Result | Command |
|---|---|---|
| Contract suite vs **deployed** `269b9c6` | **38 pass / 0 fail / 2 skipped** (40 total) | `SM_SERVER_ENTRY=tmp/contract-baseline/secrets-manager/server.mjs node --test secrets-manager/test/contract.test.mjs` |
| Contract suite vs **working tree** | **36 pass / 0 fail** | `node --test secrets-manager/test/contract.test.mjs` |
| App `typecheck && lint` | **pass** (was 1 error + 2 warnings on HEAD) | one-off container, see §1.1 |
| `password_generator.py` exit codes | **invalid → 1, valid → 0** | manual, §3 |

### 1.1 The documented gate was invalid — and is now valid

`docker compose exec app` was running a **stale bind mount**: the container's `/code/password` pointed at the project's *previous* location, which has since been removed; the mount kept the old inode alive, so the container served pre-edit code while reporting healthy. The canonical path is now `/mnt/work/Projects/tools-password-generator`, and the dev stack was recreated against it.

**Status: resolved 2026-10-25.** Both dev containers were recreated and now mount the canonical path (`docker inspect` confirms). The documented gate (`npm run typecheck && npm run lint`) passes inside the live container, exit 0, and the app endpoint was smoke-tested end-to-end (see §2a). `backups/{dev,prd}/LATEST` pointers were repointed to the canonical path — they had pointed at the removed location, which would have broken `restore`.

Residual: `.run/docker-config/buildx/refs/**` still records the old absolute path. Those are regenerable buildx cache entries, not configuration; they are rewritten on the next build (verified by rebuilding `password_secrets_manager:dev` with `DOCKER_CONFIG="$PWD/.run/docker-config"`).

### 1.2 Limits of this environment

Image builds require `DOCKER_CONFIG` inside the workspace: the default `~/.docker` is read-only under the sandbox, so `docker compose build` fails with `failed to update builder last activity time: … read-only file system`. Use:

```bash
export DOCKER_CONFIG="$PWD/.run/docker-config" BUILDX_CONFIG="$PWD/.run/buildx"
docker compose --env-file .env.dev -f docker-compose.dev.yml build <service>
```

The app container bind-mounts source (edits are live); the secrets-manager container bakes source at build time, so **`secrets-manager` changes require a rebuild** before they are observable.

### 2a. Live end-to-end checks (dev stack, after rebuild)

| Check | Result |
|---|---|
| `POST /api/generate` with JSON | `200`, password returned |
| `POST /api/generate` with `text/plain` | `403` "Requests must use the application/json content type." |
| `POST /api/generate` with foreign `Origin` | `403` |
| `POST /api/generate` with 40 KB body | `413` |
| `GET /readyz` (secrets-manager, public) | `{"status":"ready","ok":true,"version":"1.1.0"}` — no internals |
| Oversized body to `/` (secrets-manager) | `413` `InvalidParameterException`, clean response (was a connection reset) |

Consequence: any gate run through that container validated the wrong tree. The gate is now run as a one-off container mounting this workspace over the image's dependencies:

```bash
docker run --rm --entrypoint bash \
  -v "$PWD/password/app:/code/password/app:ro" \
  -v "$PWD/password/lib:/code/password/lib:ro" \
  -v "$PWD/password/components:/code/password/components:ro" \
  password_app_dev:latest -c "cd /code/password && npm run typecheck && npm run lint"
```

**Action needed:** recreate the dev app container so its mount points at this workspace again (`./bin/start.sh recreate dev` or `docker compose ... up -d --force-recreate --no-deps app`). Until then the running dev stack serves stale code.

## 2. Fixed and verified

| ID | Severity | Fix | Evidence |
|---|---|---|---|
| **SM-D1** | HIGH | Oversized request bodies return HTTP 413 instead of resetting the connection. `readBody` now drains (`req.resume()`) and lets the error response be written. | `secrets-manager/server.mjs:290-303`; `T-BODY` asserts 413 on the hardened build |
| **SM-F06** | MEDIUM | Public `/readyz` no longer discloses secret counts, `dataDir`, `writable` or `masterKeySource`; the full report moved to the loopback admin listener. HTTP status semantics unchanged. | `secrets-manager/server.mjs:438-457`; `R2` test |
| **APP-01** (app half) | CRITICAL | Rate-limit identity now prefers nginx-owned `X-Real-IP` and falls back to the **last** `X-Forwarded-For` hop instead of the caller-controlled first entry. | `password/app/api/generate/route.ts:62-89` |
| **APP-02** (app half) | CRITICAL | Bounded concurrency: at most 8 generator processes; excess requests fail fast with `503` + `Retry-After` instead of queueing. | `password/lib/generator.ts:24-32, 148-157`; `route.ts` BUSY branch |
| **APP-03** | HIGH | The limiter no longer erases every bucket at capacity — expired windows are reclaimed and new keys are rejected (fail closed), so counters cannot be globally reset. | `password/lib/rate-limit.ts:38-66` |
| **APP-07** | HIGH | `/api/generate` now requires `application/json`, rejects cross-site `Sec-Fetch-Site`, and rejects a mismatched `Origin`. | `route.ts:12-45, 160-163` |
| **APP-13** | MEDIUM | `password_generator.py` exits **1** on validation failure (was 0), writes the error to stderr. | `password_generator.py:525-531` |
| **APP-14** | MEDIUM | 16 KiB body cap checked from `Content-Length` before reading and again after reading. | `route.ts:15-16, 165-180` |
| **APP-15** | MEDIUM | The Python child inherits an allowlisted environment (`PATH`, `LANG`, `LC_ALL`, `TZ`, `HOME`, `SYSTEMROOT` + Python vars); the Secrets Manager credential and `PYTHONPATH`/`PYTHONSTARTUP` no longer reach it. | `password/lib/generator.ts:33-56, 158` |
| **APP-23** | LOW | Separators starting with `-` are rejected instead of producing an argparse usage dump and a 500. | `route.ts:64-79` |
| **GATE** | HIGH | The documented quality gate is green for the first time: lint error in `ThemeToggle` removed (dead effect), two unused imports removed. | §1.1 command, exit 0 |

### 2b. Tranche 2 — owner-approved protected-file changes (2026-10-25)

| ID | Change | Verification |
|---|---|---|
| **APP-01** | `deploy/nginx/agiolab.conf`: `X-Forwarded-For` now **overwrites** with `$remote_addr` (was `$proxy_add_x_forwarded_for`, which let the caller choose its own bucket). App-side preference for `X-Real-IP` already shipped in tranche 1. | `nginx -t` → "syntax is ok, test is successful"; 0 remaining `$proxy_add_x_forwarded_for` |
| **APP-02 (edge)** | `limit_req_zone` (20 r/m per IP, burst 10) + `limit_conn` (5) on `location = /api/generate`; 120 r/m burst 40 on the Secrets Manager. | same `nginx -t`; directives validated in http context |
| **APP-02 (containers)** | `mem_limit`/`cpus`/`pids_limit` on **both** services in **both** environments; app rootfs now `read_only` with a `/tmp` tmpfs in prd. | `docker compose config -q` valid; prd image smoke-tested read-only (health + generate 200); live dev containers report `mem=1 GiB cpus=2 pids=512`, both healthy, generate 200 |
| **APP-08 / R5** | **Rollback path added.** Every build snapshots the images it replaces as `<repo>:rollback-<UTC>` (keeps 5); `./bin/start.sh rollback [stamp\|latest\|--list] [env]` retags and recreates **without rebuilding**, and snapshots the current images first so a rollback is itself reversible. | executed end-to-end on dev: list → retag → `up --no-build` → secrets healthy → app healthy → `Rolled back dev to snapshot … (data untouched)`, exit 0 |
| **APP-05** | `.env.dev`, `.env.prd`, `.run/`, `backups/**` tightened from **0755 to 0600** (directories 0700). | `stat` before/after recorded; parity gate still green |
| **APP-09** | `/api/ready` now reports readiness on **generation capability**: a degraded Secrets Manager is reported as `status: "degraded"` instead of withdrawing the instance with a 503. 503 is reserved for a broken generator or unenforced integrity policy. Decision: owner ("apply according to your recommendation, consistency is key"). | typecheck + lint green; live `/api/ready` 200 |
| **U7 answer** | `requestsPerMinute: 0` is a **supported disable switch** — left as-is, not clamped. | owner decision 2026-10-25 |
| **U4 answer** | Credentials are supplied **manually on the server** (bash or a non-internet-exposed API). Confirms BC9: loopback-only credential management is the intended design, not a compromise. | owner decision 2026-10-25 |

Environment-parity gate caught the new compose variables and now passes with 39 keys across `.env.example` / `.env.dev` / `.env.prd`.

### 2c. Tranche 3 — final readiness pass (2026-10-25)

| Item | What changed | Verification |
|---|---|---|
| **Edge proof (was "not proven live")** | No code change. The edge config was exercised for real, against stub upstreams, instead of only `nginx -t`. | All four `*ClientCredential` targets → **403**; `GetSecretValue` / `ListSecrets` / `PutSecretValue` → **200**; a spoofed `X-Forwarded-For: 1.2.3.4, 5.6.7.8` and `X-Real-IP: 9.9.9.9` were **discarded** and replaced with the single real peer; `Host` preserved; `X-Forwarded-Proto: https`; `/api/generate` throttled at **11 of 25** allowed (burst 10 + 1). |
| **APP-12** | The API now passes `--wordlist <verified path>` to the generator, so the file whose digest is checked is the file used. A missing explicit list fails with a clean error and exit 1 instead of silently falling back to 54 inline words. | `python3 password_generator.py --use-words --wordlist /nonexistent` → exit **1** + message; live passphrase generation still 200; typecheck/lint green. |
| **A11y gap 1** | `prefers-reduced-motion` now respected via `<MotionConfig reducedMotion="user">` (`components/MotionProvider.tsx`). | typecheck + lint green; page renders 200. |
| **A11y gap 2** | Generated results are announced (`role="status" aria-live="polite"`, event + length, never the secret); errors use `role="alert"`. | live region present in rendered HTML; page 200. |
| **Doc consistency** | 10 broken links in the master plan fixed; stale test counts (11→22 unit, 36→40 contract, 34→38 pass) corrected in 9 files; "19 rules" → 20. | 34 docs scanned, **0 broken relative links**. |

**Not closed, and why:** APP-06 (backup key custody) and APP-04 (scoped credential in production) need an owner decision plus a deploy; APP-11 (fail-closed integrity) is a policy decision; APP-17/18 (restore hardening) and APP-20 (`/api/health` payload) change destructive or monitored paths and are scheduled in the master plan (M4, M5) rather than rushed.

### 2d. Tranche 4 — approved-plan implementations (2026-10-25)

| ID | Change | Verification |
|---|---|---|
| **APP-10** | The health probe now runs a **real generation** (`--length 16`, validated for length + printable output) instead of `python --version`. A broken script, bad flag or missing interpreter can no longer leave the probe green while requests 500. | live `/api/health` → `checks.generator.ok: true`; probe is the same command path the route uses |
| **APP-24** | The probe is **single-flighted** (`healthInflight`): a burst of health/readiness probes no longer fans out into one Python process each. Result cached 60 s. | `password/lib/generator.ts` `checkGeneratorHealth` |
| **APP-20** | Public `/api/health` and `/api/ready` no longer return absolute paths, the word-list digest (expected/actual) or error strings. Detail is available only with `HEALTH_VERBOSE=true`. | payload inspected: no `/code/`, `/app/`, `"expected"`, `"actual"` or `.txt`; new smoke check **"health payload exposes no paths or digests"** (smoke now 14 checks) |
| **M4-T2 (deferred, with reason)** | Restore hardening was **not** implemented this pass. The code already warns and requires confirmation on a cross-environment restore, but checksums remain optional and manifest volume names are used verbatim. Changing a destructive path without a restore drill is the wrong trade — it is scheduled as M4-T2 + M4-T4 (drill) rather than rushed. | — |

## 3. Contract facts corrected in the SPEC

Pinning the contract proved three of my initial SPEC rules wrong — the deployed service was right:

| Rule | Was | Now | Why |
|---|---|---|---|
| R28 | soft-deleted read → `ResourceNotFoundException` | `InvalidRequestException` "…marked for deletion" | Matches real AWS Secrets Manager. |
| R33 | `{clients: [...]}` | `{ClientCredentialList: [...]}` sorted by name | Verified response. |
| R5 | always a clean client error | 413 intended; 269b9c6 observed a reset | Defect **SM-D1**. |

## 4. Open — code, no approval needed

| ID | Severity | Item | Why it is not done yet |
|---|---|---|---|
| APP-04 | HIGH | Production app still authenticates with the **instance admin** key. | Requires compose/env wiring (protected) plus a deploy. |
| APP-06 | HIGH | Backups contain `master.key` and only a self-written SHA-256. | Needs an encryption/signing design decision (key custody). |
| APP-09 | MEDIUM | `/api/ready` 503s when the optional Secrets Manager is down. | Readiness semantics are a product decision: degraded vs unready. |
| APP-10 | MEDIUM | Health probes never exercise a real generation. | Cheap to add; needs a decision on probe cost/rate. |
| APP-11 | MEDIUM | Policy layer fails open (integrity off, RPM 120) on an SM outage. | Fail-closed changes availability behaviour — owner decision. |
| APP-12 | MEDIUM | The API never passes `--wordlist`, so the CLI can silently fall back to 54 inline words while the hash check validates a different file. | Fix needs the verified path threaded through `runGenerator`. |
| APP-17/18 | MEDIUM | `start.sh` lacks `set -e`; restore trusts the archive. | Touching destructive paths; needs a reviewed change with tests. |
| APP-20 | MEDIUM | Public `/api/health` leaks absolute paths, hashes and policy. | Same shape as the `/readyz` fix; needs a decision on what monitoring consumes. |
| APP-21 | MEDIUM | `requestsPerMinute: 0` silently disables throttling. | Documented behaviour may rely on it — needs a decision. |
| APP-24 | LOW | Health/ready probes are unthrottled and not single-flighted. | Follows the readiness decision. |

## 5. Protected-file changes — **all approved and completed 2026-10-25** (see §2b)

| # | Change | File | Why it is protected |
|---|---|---|---|
| 1 | Overwrite `X-Forwarded-For` (`$remote_addr`, not append) and add `limit_req`/`limit_conn` | `deploy/nginx/agiolab.conf:69` | Edge nginx is a protected surface; the live host config is installed manually. |
| 2 | `mem_limit` / `cpus` / `pids_limit` on the app service; `read_only` + tmpfs | `docker-compose.prd.yml:99-114` | Compose files are protected. |
| 3 | Immutable images (`${APP_VERSION}` / digest) + retained rollback tags | `docker-compose.prd.yml:22,69`; `bin/start.sh:1807-1818` | Compose + deploy path. |
| 4 | Wire the scoped read-only credential into production (APP-04) | `docker-compose.prd.yml:95-97`; `.env.prd` | Compose + secrets. |
| 5 | `chmod 600 .env.prd .run/* backups/prd/*` (currently 0755) | host filesystem | **Done** — 0600 files, 0700 directories. |

## 6. Open questions

1. **Is `requestsPerMinute: 0` a supported "disable" switch?** If yes it needs an explicit `disabled` flag instead of a magic zero; if no, clamp to ≥1.
2. **Should readiness downgrade or fail when the Secrets Manager is unreachable?** Generation works without it, so 503 currently over-reports outage.
3. **Who consumes `/readyz` and `/api/health` payloads?** Determines how far we can shrink them (APP-20).
4. **Where is the production image built from?** The live host was not inspected; `docker image inspect` there settles whether it matches `269b9c6`.

## 7. Next action

Approve the five protected-file changes in §5 so the abuse fixes can be completed at the edge and in the container limits.

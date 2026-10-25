# Threat model — Secure Password Generator

**What this is:** assets, adversaries, threats and the control that answers each one, mapped to the code that implements it. The reference for every security review of this repo.
**Status:** In review — 2026-10-25
**Needs:** owner decisions on `T7` (public data plane) and `T9` (backup key custody).

**Brownfield synthesis 2026-10-25:** built from the S1 audit (`.work/reports/20261025-s1-audit-findings.md`), the wire-contract SPEC and code inspection. Threat ratings are qualitative; no exploit was executed against production.

---

## 1. Assets, ranked by consequence of loss

| # | Asset | Where it lives | Consequence if lost |
|---|---|---|---|
| A1 | **Master key** | `SM_MASTER_KEY` env or `master.key` in the volume | Total disclosure of every stored secret and client credential |
| A2 | **Instance admin credential** | container env; host `.env.*` | Full read/write + credential minting on the secrets store |
| A3 | **Client credentials** | static env (`SM_CLIENTS_JSON`) or encrypted store | Scoped read/write within one prefix |
| A4 | **Secret values** (policy, word-list digest) | encrypted store | Policy tampering, integrity-check bypass |
| A5 | **Backup bundles** | `backups/<env>/` | Equivalent to A1+A4 (they contain the master key) |
| A6 | **Generated passwords** | in transit only, never persisted | The product's core promise: no lasting exposure |
| A7 | **Availability of generation** | app + Python child | Public endpoint unusable; the tool's reason to exist |

## 2. Adversaries

| # | Adversary | Capability assumed |
|---|---|---|
| E1 | Anonymous internet caller | Can call `https://agiolab.com/api/generate` and the public secrets endpoint at will; can spoof headers; can open many concurrent connections |
| E2 | Malicious website visitor | Can make a victim's browser issue cross-site requests |
| E3 | Local unprivileged user on the host | Can read world-readable files, inspect processes, read env of own processes |
| E4 | Compromised application dependency (supply chain) | Code execution inside the app container |
| E5 | Curious holder of a scoped client credential | Can call any operation the credential permits |

Out of scope: nation-state physical access, Docker daemon compromise, host root compromise (root defeats every control here by design).

## 3. Threats and controls

| ID | Threat | Adversary | Control (current) | Status |
|---|---|---|---|---|
| **T1** | Mass generation to exhaust CPU/memory | E1 | Per-IP fixed-window throttle (fail-closed at capacity) + **max 8 concurrent Python children**, `503` + `Retry-After` | **Mitigated (app)**; edge `limit_req` pending |
| **T2** | Bypass the throttle by spoofing client identity | E1 | Key derives from nginx-owned `X-Real-IP` (last XFF hop only); nginx currently **appends** XFF, so this relies on the app fix | **Mitigated (app)**; nginx overwrite pending |
| **T3** | Reset everyone's throttle counters by flooding distinct keys | E1 | Table never cleared wholesale; expired windows reclaimed; new keys fail closed at capacity | **Mitigated** |
| **T4** | Cross-site request makes third-party browsers into distinct clients | E2 | `application/json` required, `Sec-Fetch-Site` and `Origin` checked | **Mitigated** |
| **T5** | Memory amplification via oversized bodies | E1 | 16 KiB app cap (declared + actual); 1 MiB secrets cap returning clean `413` | **Mitigated** |
| **T6** | Steal the admin credential via the app | E4 | Python child receives an allowlisted env only | **Mitigated**; **open**: the app itself still holds the admin key (`APP-04`) |
| **T7** | Reach credential-minting operations from the internet | E1, E5 | Loopback-only admin listener + edge deny-map | **Implemented, not deployed** (contract BC9; feedback F-03) |
| **T8** | Read secrets/backups from the host as an unprivileged user | E3 | Intended 0600/0700 on `.env.*`, `.run/`, `backups/` | **Open** — files are 0755 (`APP-05`) |
| **T9** | Steal a backup and decrypt the store | E3, off-host | None: backups contain `master.key`, integrity is a self-written SHA-256 | **Open** (`APP-06`) |
| **T10** | Forge or replay a signed request | E1, E5 | SigV4 with timing-safe compare, 900 s skew, body-hash check, per-credential scoping | **Mitigated** (contract R11–R17, tests) |
| **T11** | Escape a credential's prefix scope | E5 | Prefix normalised with a trailing `/`; boundary test (`client/acb2/`) | **Mitigated** (contract R19, test) |
| **T12** | Infer store internals from the public readiness probe | E1 | Public `/readyz` reduced to `{status, ok, version}` | **Mitigated** |
| **T13** | Learn topology/limits from the public health probe | E1 | — | **Open** (`APP-20`) |
| **T14** | Disable integrity enforcement by causing a policy outage | E4, E1 | None — the policy layer fails **open** to defaults | **Open** (`APP-11`) |
| **T15** | Hide a broken generator behind green health checks | accident | Health probes never generate | **Open** (`APP-10`) |
| **T16** | Persist malware across restarts in the app container | E4 | `no-new-privileges`, `cap_drop: ALL`; no `read_only` rootfs | **Partial** (`APP-19`) |
| **T17** | Recover from a bad deploy | accident | None — no rollback, images rebuilt in place | **Open** (`APP-08`) |
| **T18** | Log or persist a generated password | accident | Passwords are returned and discarded; no logging of values | **Mitigated by design** (doc 01 §4) |

## 4. Trust boundaries

```text
[internet] ──TLS──► [host nginx]  ← boundary 1: header trust (X-Real-IP / XFF)
                         │
                         ├──► [app container]  ← boundary 2: untrusted request body
                         │        └─ spawn ──► [python child]  ← boundary 3: env allowlist
                         └──► [secrets container] :8080 data plane
                                  └─ :8081 admin  ← boundary 4: loopback only
                         └──► [encrypted volume]  ← boundary 5: at-rest encryption
[host filesystem]  ← boundary 6: file modes on .env / .run / backups
```

## 5. Residual risk statement

The generation path itself is sound: CSPRNG entropy, argv-array spawn with no shell, timeout and output cap, printable/length validation, and no persistence of generated values.

The **weakest links are operational, not algorithmic**: least privilege is designed but not deployed (`T6`, `T7`), host file modes and backup custody expose the master key (`T8`, `T9`), and a bad deploy is unrecoverable (`T17`). Those four are the honest answer to "is this production-safe?" — the product is, the deployment is not yet.

## 6. Decisions needed

1. **T7** — Approve deploying the loopback admin listener and the edge deny-map, or move the Secrets Manager data plane off the public internet entirely.
2. **T9** — Choose backup key custody: encrypt off-host copies (age/GPG) and/or move the master key out of the archive.
3. **T14** — Should integrity enforcement fail **closed** in production?

## 7. Next action

Owner decision on §6.1, then complete the protected-file tranche in `.work/reports/20261025-s1-audit-findings.md` §5.

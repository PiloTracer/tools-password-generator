# ADR 005 — Two-phase client credential rotation

**Status:** Proposed — 2026-10-25 · **Needs:** owner approval
**Origin:** pilo-mail feedback F-05 / recommendation R3; owner request for on-box, CLI-style credential management.

## Context

The documented rotation procedure is *"delete and create a replacement"* (`docs/production-deployment.md:251`). The old key stops working the instant it is deleted, so every rotation is an outage for the client until its new credential is deployed. The service already supports multiple credentials with the same prefix — nothing technical forces revoke-then-create; it was simply never written down differently.

## Decision

Adopt **two-phase rotation** as the only supported procedure, implemented in the operator CLI:

1. **Mint the successor** — `rotate-client-credential <name>` creates `<name>-<suffix>` inheriting the predecessor's `AllowedPrefixes` and `Description`, and prints the new access key/secret **once**. The predecessor stays valid.
2. **Cut the client over** — deploy the new credential to the consumer at its own pace; both keys work simultaneously.
3. **Revoke the predecessor** — `revoke-client-credential <name>` once the new credential is confirmed in use.

`--revoke-old` performs steps 1 and 3 atomically for the case where an overlapping window is explicitly unwanted.

Privileged operations go through the **loopback admin listener** (`SM_ADMIN_ENDPOINT`, default `http://127.0.0.1:8081`), because the contract makes credential management loopback-only (BC9). On a pre-hardening deployment the CLI falls back to the public endpoint and says so on stderr; an explicitly configured `SM_ADMIN_ENDPOINT` never falls back.

## Consequences

- Rotation becomes a no-outage operation, which removes the standing objection to rotating credentials regularly.
- Operators must remember step 3, or the store accumulates stale credentials. `list-client-credentials` exposes them, and the managed-client limit bounds the leak.
- The CLI needs an authenticated path to the admin listener; running it inside the container is the supported route.
- Verified end-to-end 2026-10-25 against the dev stack: old key valid after rotation, new key unaffected by revoking the old, revoked key rejected with `UnrecognizedClientException`.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Revoke-then-create (status quo) | Guarantees an outage per rotation |
| Overlapping validity windows with automatic expiry | Needs a per-credential expiry the store does not model; two-phase achieves the goal with operator control |
| Atomic "replace secret for name" operation | Changes the wire contract; two names per rotation is already AWS-compatible |

## References

`secrets-manager/cli.mjs` (`rotate-client-credential`, `revoke-client-credential`, `callAdmin`); `docs/production-deployment.md:251`; contract rules R35–R40; pilo-mail feedback F-05/R3.

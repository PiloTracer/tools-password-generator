# ADR 003 — Single tenant; instance admin plus prefix-scoped clients

**Status:** Decided (brownfield synthesis 2026-10-25) · **Needs:** nothing — `U4` answered 2026-10-25: the administrator supplies credentials manually on the server, so loopback-only credential management (BC9) is the intended design.
**Brownfield synthesis:** reconstructed from the shipped tree.

## Context

The Secrets Manager serves at least two consumers with different trust levels: the password-generator app (reads two secret names under one prefix) and an integrating client (ACB, prefix `client/acb/`). Giving every consumer the root credential would make one app compromise equal to total secret-store compromise. There is exactly one operator and no customer-facing tenant model.

## Decision

- **Single tenant.** One deployment serves one operator; there is no schema-per-tenant or RLS layer.
- **Two principal classes:**
  - *Instance administrator* — full access plus credential minting. Lives in the container environment and host tooling; never handed to an application.
  - *Client credential* — non-admin, restricted to an `allowedPrefixes` list; may be **static** (`SM_CLIENTS_JSON`) or **managed** (created via the API and stored encrypted). Optionally `readOnly` (uncommitted).
- **Credential-management operations are loopback-only.** `Create/Get/List/DeleteClientCredential` are served on a separate admin listener bound to `127.0.0.1:8081`; the public listener returns `AccessDeniedException`, and the edge denies those targets.
- Prefix matching normalises to a trailing `/`, so `client/acb/` never authorises `client/acb2/…`.

## Consequences

- Least privilege is expressible per consumer, and a compromised app credential can only read its own prefix.
- The admin listener introduces a second port to operate and to firewalls; it must never be published.
- Making the credential operations loopback-only changes the public surface (contract BC9) — an intentional, documented change requiring an ADR (this one) and a changelog entry before deploy.
- **Currently not honoured in production:** the app still authenticates with the instance-admin credential (`APP-04`). The scoped-client provisioning exists but is uncommitted/undeployed.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| One shared credential | No blast-radius reduction; any consumer reads everything |
| Row-level tenancy per customer | No customers-as-tenants; adds schema that the product does not need |
| Public credential-minting API | Turns the secrets store into an internet-reachable privilege-escalation surface |
| mTLS per client | Stronger, but certificate distribution exceeds the operator's tooling at this size |

## References

`secrets-manager/server.mjs` (admin listener, uncommitted); `secrets-manager/lib/operations.mjs:13-56`; `bin/ensure-app-credentials.py`; `deploy/nginx/agiolab.conf`; contract rules BC9/R19–R22.

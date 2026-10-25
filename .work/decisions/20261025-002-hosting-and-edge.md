# ADR 002 — Single host, Compose per environment, host nginx for TLS

**Status:** Decided (brownfield synthesis 2026-10-25) · **Needs:** nothing — the rollback gap this ADR flagged (`APP-08`) closed on 2026-10-25 via per-build image snapshots and `./bin/start.sh rollback`.
**Brownfield synthesis:** reconstructed from the shipped tree.

## Context

The product must run on a VPS the operator controls, serve HTTPS publicly, and keep certificate material out of the image. Two environments (dev/prd) must be selectable without a second codebase. The budget is one host.

## Decision

- One physical host; **Docker Compose** with a per-environment file pair (`docker-compose.dev.yml` + `.env.dev`, `docker-compose.prd.yml` + `.env.prd`).
- Containers publish on **loopback only**; the public edge is **host nginx** terminating TLS, adding HSTS/security headers and proxying to loopback ports.
- `./bin/start.sh` is the single control plane for both environments.
- dev and prd deliberately share host ports, so **only one environment runs per host**.

## Consequences

- Certificates and their renewal live on the host, outside Docker — no key material in images.
- The host is a single point of failure; no HA, no horizontal scaling.
- Deploys are in-place rebuilds. **There is no rollback path today** because images are mutable local tags and old images are removed — recorded as `APP-08`, a known gap.
- Environment parity is a real risk surface; `bin/check-env-parity.sh` exists to compare `.env.example`/dev/prd.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Cloud-managed container platform | Cost and operational control; certificate handling moves to the vendor |
| Kubernetes | Wildly disproportionate for two services and one host |
| TLS terminated in the app container | Certificate material inside images; ACME renewal harder |
| Separate hosts per environment | Duplicates a single-operator burden for a small tool |

## References

`docker-compose.{dev,prd}.yml`; `deploy/nginx/agiolab.conf`; `bin/start.sh`; `README.md` §3; foundation doc 04 §3, §6.

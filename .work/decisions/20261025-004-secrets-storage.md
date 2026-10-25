# ADR 004 — Encrypted single-document store instead of a database

**Status:** Decided (brownfield synthesis 2026-10-25) · **Needs:** nothing
**Brownfield synthesis:** reconstructed from the shipped tree.

## Context

The service must be AWS-Secrets-Manager-compatible for a handful of secrets and a handful of client credentials, and it must be auditable by a human. A relational database would add a second stateful service, a migration path, credentials, and a much larger review surface. The data is small, write-light, and must be encrypted at rest as a whole rather than per-column.

## Decision

Persist **one JSON document** (`store.json`) on a named Docker volume, with every secret **value** encrypted using **AES-256-GCM**. Metadata (names, ARNs, tags, dates, stages) stays in clear so the service can list and scope without decrypting. The additional authenticated data is `<arn>|<versionId>`, binding a ciphertext to its exact slot. The master key comes from `SECRETS_MANAGER_MASTER_KEY` or a `master.key` file in the volume; a store that cannot be decrypted fails fast instead of serving empty data.

## Consequences

- Zero npm dependencies; the whole service is reviewable in one sitting.
- Backups are a single file — but they **contain the master key** when auto-generated, so a backup copy is plaintext-equivalent (`APP-06`).
- Single writer: no horizontal scaling, no concurrent-instance safety beyond process-level serialisation.
- The store carries `schemaVersion: 1` with no migration runner yet; any format change needs one.
- Losing the master key loses the store; losing the volume loses everything. Backups are the only recovery path.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| PostgreSQL + column encryption | A second stateful service, migrations and DB credentials for a few KB of data |
| SQLite | Closer, but the encrypted-document model already satisfies the requirement without a schema |
| External KMS | Strongest key custody, but adds a cloud dependency the self-hosted product avoids; still the natural upgrade for `APP-06` |
| Plain files per secret | Loses atomic updates, versioning and stage semantics required by the AWS contract |

## References

`secrets-manager/lib/store.mjs:40-52, 120-200, 643-700`; `secrets-manager/Dockerfile`; `docker-compose.*.yml` (`secrets_data` volume); contract rules R23–R31, BC8.

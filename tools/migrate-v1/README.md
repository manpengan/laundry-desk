# v1 → v2 migration

The extractor reads a private copy of a stopped, standalone v1 SQLite backup. It
never opens the supplied file for writing, rejects links and WAL/SHM/journal
sidecars, checks integrity, and uses readonly/query_only/trusted_schema=OFF.
Input is bounded to 64 MiB, 100000 rows per table and 65536 characters per field.
Unknown tables/columns require an explicit mapping; they do not disappear through
SELECT projections. Only synthetic fixtures belong in this repository.

```sh
pnpm --filter @laundry/migrate-v1 test
pnpm --filter @laundry/migrate-v1 migrate -- --source /secure/backups/v1-final.db
```

The default CLI prints only a reconciliation report and digest, never names,
phones, notes, database URLs or source paths. It exits nonzero on differences.
`order_items.quantity` becomes one line plus one garment per piece. Original
nullable fields remain in the validated source snapshot. Staff, SMS and audit
history are extracted separately; old password hashes are deliberately never
read and their excluded count is explicit.

The supported installed-runtime entry is the administrator **旧版数据迁移** panel,
followed by Windows maintenance **导入旧版数据** with its approved request ID.
`apps/server/src/data-transfer` owns the real schema mapping, trusted current
session, app-role/RLS transaction, verified backup port, immutable photo files,
complete readback, idempotence and privacy lifecycle. The panel describes legacy
photo association, replaced duplicate pickup codes, excluded credentials and
historical privacy rules before password approval. See [ADR-74](../../docs/adr/2026-10-03-adr-74-windows-v1-migration.md).

`loadV2Migration` is the internal loader port; its exclusive maintenance callback
covers both backup creation and apply. The legacy external-loader CLI remains
available for controlled rehearsals and requires explicit `--apply`, `--target`,
`--loader` and `--confirm-source-sha256`. It does not accept tenant IDs. Only a
schema-owned loader that enforces the same session, backup, RLS and audit rules
is suitable for actual apply.

The server imports the pure `@laundry/migrate-v1/plan` entry during startup;
SQLite is loaded dynamically only for extraction. Windows packaging must rebuild
`better-sqlite3` on Node 22 x64 and read a synthetic SQLite file there; a macOS
native addon must never be copied into the Windows runtime.

Real customer data remains gated by the local production admission decision.
All development and regression evidence uses generated data and isolated PG.

# v1 → v2 migration tool

This tool reads the frozen v1 SQLite backup and prepares a deterministic V2-M2
migration plan. It never opens the supplied source for writing: it verifies a
stable SHA-256, copies the file to a private temporary directory, and opens only
that copy with SQLite `readonly` and `query_only` enabled. Intake rejects symbolic
links and any `-wal`, `-shm`, or `-journal` sidecar, then requires SQLite's full
integrity check to pass. The final backup must therefore be checkpointed and
detached from the frozen v1 process before rehearsal.

Only use a final v1 backup that has been authorized for migration. Do not point
this tool at a live v1 database or commit a customer database to this repository.
The checked-in fixture contains only virtual customer names and `13800000xxx`
numbers.

The repository gate includes a repeatable sanitized rehearsal using that fixture:

```bash
pnpm --filter @laundry/migrate-v1 test
```

It runs the real extractor/transformer/reconciliation path twice, verifies an
unchanged source hash and identical zero-difference evidence, and rejects customer
PII in output.

## Dry run (default)

```bash
pnpm --filter @laundry/migrate-v1 migrate -- --source /secure/backups/v1-final.db
```

The only output is a JSON reconciliation report: orders, garments, customers,
receivable, paid, debt, photos, and their differences. It deliberately never
prints customer names, phones, notes, paths, or the target URL. A non-zero
difference exits non-zero.

`order_items.qty` is converted to one `order_line` plus one garment for every
piece. Generated barcodes are deterministic (`V1-order-item-seq`) and unique in
the migration plan. Legacy photo rows are mapped to the first garment in their
order because v1 has no piece-level association; a production loader must show
that association for operator review when copying assets.

## Apply is intentionally gated

There is no built-in PostgreSQL writer or memory fallback. Task 6 owns the live
schema and must provide a local loader module with a `v2-postgresql` port. The
loader must inject org/store/actor from a trusted server-side migration session,
create the V2 backup point, write business rows plus migration audit in one
transaction, copy/verify photo assets, and make the deterministic IDs idempotent.

After reviewing the dry-run SHA-256, an authorized operator can run:

```bash
pnpm --filter @laundry/migrate-v1 migrate -- \
  --source /secure/backups/v1-final.db \
  --apply \
  --target "$DATABASE_URL" \
  --loader /secure/migration/v2-postgres-loader.mjs \
  --confirm-source-sha256 "<sha256 from the dry run>"
```

`--apply` refuses to start without all four explicit values. It requires a
zero-difference plan, creates the target backup point before invoking the
idempotent loader, and never logs the database URL. CLI grammar is exact: duplicate,
positional, unknown, or dry-run-only misuse of apply options is rejected. Failures
emit only a stable `V1_MIGRATION_*` code, never a loader exception or target URL.

## Current integration contract

The loader receives a `V2MigrationPlan` with deterministic UUIDs and the
reconciliation report through `loadV2Migration`. The current target schema does
not yet define migration metadata for v1 staff IDs, item display names/notes,
pickup codes, expected dates, or order-level photo asset storage. The Task 6
loader must settle those mappings with the production schema rather than having
this tool guess or silently discard them.

Under ADR-37 this remains historical migration evidence, not an active generic V2
production loader. A real apply is not claimed or rehearsed until a separately
approved schema-owned PostgreSQL loader and authorized source backup exist.

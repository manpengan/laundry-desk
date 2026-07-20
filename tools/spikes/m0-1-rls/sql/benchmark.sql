\set ON_ERROR_STOP on
\pset pager off

BEGIN;
\if :rls_enabled
\else
ALTER TABLE orders DISABLE ROW LEVEL SECURITY;
\endif

SET LOCAL ROLE laundry_app;
SET LOCAL app.org_id = '00000000-0000-0000-0000-000000000001';
SET LOCAL app.store_id = '10000000-0000-0000-0000-000000000001';

CREATE TEMP TABLE benchmark_samples (
  query_name text NOT NULL,
  duration_ms double precision NOT NULL
) ON COMMIT DROP;

DO $benchmark$
DECLARE
  iteration integer;
  started_at timestamptz;
BEGIN
  FOR iteration IN 1..250 LOOP
    started_at := clock_timestamp();
    PERFORM id, status, total_cents, created_at
    FROM orders
    WHERE org_id = '00000000-0000-0000-0000-000000000001'
      AND store_id = '10000000-0000-0000-0000-000000000001'
      AND created_at >= '2026-07-19 00:00:00+00'::timestamptz
      AND created_at < '2026-07-20 00:00:00+00'::timestamptz
    ORDER BY created_at DESC
    LIMIT 50;
    INSERT INTO benchmark_samples VALUES (
      'daily-list',
      extract(epoch FROM clock_timestamp() - started_at) * 1000
    );

    started_at := clock_timestamp();
    PERFORM id, status, total_cents, created_at
    FROM orders
    WHERE org_id = '00000000-0000-0000-0000-000000000001'
      AND store_id = '10000000-0000-0000-0000-000000000001'
      AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 50;
    INSERT INTO benchmark_samples VALUES (
      'status-filter',
      extract(epoch FROM clock_timestamp() - started_at) * 1000
    );

    started_at := clock_timestamp();
    PERFORM id, status, total_cents, created_at
    FROM orders
    WHERE org_id = '00000000-0000-0000-0000-000000000001'
      AND store_id = '10000000-0000-0000-0000-000000000001'
      AND customer_id = 2
    ORDER BY created_at DESC
    LIMIT 50;
    INSERT INTO benchmark_samples VALUES (
      'customer-orders',
      extract(epoch FROM clock_timestamp() - started_at) * 1000
    );
  END LOOP;
END
$benchmark$;

SELECT
  :'benchmark_mode' AS mode,
  query_name,
  round((percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms))::numeric, 3) AS p50_ms,
  round((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::numeric, 3) AS p95_ms,
  round((percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms))::numeric, 3) AS p99_ms
FROM benchmark_samples
GROUP BY query_name
ORDER BY query_name;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, total_cents, created_at
FROM orders
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND store_id = '10000000-0000-0000-0000-000000000001'
  AND created_at >= '2026-07-19 00:00:00+00'::timestamptz
  AND created_at < '2026-07-20 00:00:00+00'::timestamptz
ORDER BY created_at DESC
LIMIT 50;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, total_cents, created_at
FROM orders
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND store_id = '10000000-0000-0000-0000-000000000001'
  AND status = 'open'
ORDER BY created_at DESC
LIMIT 50;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, total_cents, created_at
FROM orders
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND store_id = '10000000-0000-0000-0000-000000000001'
  AND customer_id = 2
ORDER BY created_at DESC
LIMIT 50;

RESET ROLE;
\if :rls_enabled
\else
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
\endif
COMMIT;

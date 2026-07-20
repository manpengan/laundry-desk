\set ON_ERROR_STOP on

INSERT INTO orders (
  org_id,
  store_id,
  id,
  customer_id,
  status,
  total_cents,
  created_at
)
SELECT
  CASE WHEN (number - 1) % 4 < 2
    THEN '00000000-0000-0000-0000-000000000001'::uuid
    ELSE '00000000-0000-0000-0000-000000000002'::uuid
  END,
  CASE (number - 1) % 4
    WHEN 0 THEN '10000000-0000-0000-0000-000000000001'::uuid
    WHEN 1 THEN '10000000-0000-0000-0000-000000000002'::uuid
    WHEN 2 THEN '20000000-0000-0000-0000-000000000001'::uuid
    ELSE '20000000-0000-0000-0000-000000000002'::uuid
  END,
  number,
  (number % 500) + 1,
  CASE number % 3 WHEN 0 THEN 'ready' WHEN 1 THEN 'open' ELSE 'closed' END,
  1000 + (number % 10000),
  '2026-07-19 00:00:00+00'::timestamptz
    + ((number % 86400) * interval '1 second')
FROM generate_series(1, 100000) AS source(number);

INSERT INTO order_lines (org_id, store_id, order_id, id, unit_price_cents)
SELECT org_id, store_id, id, id, total_cents
FROM orders;

INSERT INTO garments (org_id, store_id, order_id, order_line_id, id, barcode)
SELECT org_id, store_id, id, id, id, 'G-' || lpad(id::text, 8, '0')
FROM orders;

ANALYZE orders;
ANALYZE order_lines;
ANALYZE garments;

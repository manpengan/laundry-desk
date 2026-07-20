\set ON_ERROR_STOP on
\set ECHO all
\pset pager off

DO $test$
DECLARE
  visible_rows bigint;
  blocked boolean := false;
BEGIN
  SELECT count(*) INTO visible_rows FROM orders;
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'uninjected worker exposed % orders', visible_rows;
  END IF;
  BEGIN
    INSERT INTO orders VALUES (
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      900020, 1, 'open', 1000, now()
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    blocked := true;
    RAISE NOTICE 'worker write SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'uninjected worker write was not blocked';
  END IF;
  RAISE NOTICE 'PASS worker missing injection: read=% write=RLS-blocked', visible_rows;
END
$test$;

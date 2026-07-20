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
    RAISE EXCEPTION 'missing GUC exposed % orders', visible_rows;
  END IF;
  BEGIN
    INSERT INTO orders VALUES (
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      900001, 1, 'open', 1000, now()
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    blocked := true;
    RAISE NOTICE 'missing GUC write SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'missing GUC write was not blocked';
  END IF;
  RAISE NOTICE 'PASS missing GUC: read=% write=RLS-blocked', visible_rows;
END
$test$;

SET app.org_id = '';
SET app.store_id = '';
DO $test$
DECLARE
  visible_rows bigint;
  blocked boolean := false;
BEGIN
  SELECT count(*) INTO visible_rows FROM orders;
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'empty GUC exposed % orders', visible_rows;
  END IF;
  BEGIN
    INSERT INTO orders VALUES (
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      900002, 1, 'open', 1000, now()
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    blocked := true;
    RAISE NOTICE 'empty GUC write SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'empty GUC write was not blocked';
  END IF;
  RAISE NOTICE 'PASS empty GUC: read=% write=RLS-blocked', visible_rows;
END
$test$;
RESET app.org_id;
RESET app.store_id;

BEGIN;
SET LOCAL app.org_id = '00000000-0000-0000-0000-000000000001';
SET LOCAL app.store_id = '10000000-0000-0000-0000-000000000001';
DO $test$
DECLARE
  visible_rows bigint;
BEGIN
  SELECT count(*) INTO visible_rows FROM orders;
  IF visible_rows <> 25000 THEN
    RAISE EXCEPTION 'tenant A/store 1 expected 25000 rows, got %', visible_rows;
  END IF;
  RAISE NOTICE 'transaction-local tenant A read=%', visible_rows;
END
$test$;
ROLLBACK;

DO $test$
DECLARE
  visible_rows bigint;
  blocked boolean := false;
BEGIN
  SELECT count(*) INTO visible_rows FROM orders;
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'rollback leaked % orders', visible_rows;
  END IF;
  BEGIN
    INSERT INTO orders VALUES (
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      900003, 1, 'open', 1000, now()
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    blocked := true;
    RAISE NOTICE 'rollback residual write SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'rollback residual write was not blocked';
  END IF;
  RAISE NOTICE 'PASS rollback residual: read=% write=RLS-blocked', visible_rows;
END
$test$;

BEGIN;
SET LOCAL app.org_id = '00000000-0000-0000-0000-000000000001';
SET LOCAL app.store_id = '10000000-0000-0000-0000-000000000001';
DO $test$
DECLARE
  visible_rows bigint;
BEGIN
  SELECT count(*) INTO visible_rows FROM orders;
  IF visible_rows <> 25000 THEN
    RAISE EXCEPTION 'pool tenant A expected 25000 rows, got %', visible_rows;
  END IF;
  RAISE NOTICE 'pool tenant A committed transaction read=%', visible_rows;
END
$test$;
COMMIT;

DO $test$
DECLARE
  visible_rows bigint;
BEGIN
  SELECT count(*) INTO visible_rows FROM orders;
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'pool post-commit leaked tenant A context: % rows', visible_rows;
  END IF;
  RAISE NOTICE 'pool post-commit missing GUC read=%', visible_rows;
END
$test$;

BEGIN;
SET LOCAL app.org_id = '00000000-0000-0000-0000-000000000002';
SET LOCAL app.store_id = '20000000-0000-0000-0000-000000000001';
DO $test$
DECLARE
  visible_rows bigint;
  cross_rows bigint;
  blocked boolean := false;
BEGIN
  SELECT count(*) INTO visible_rows FROM orders;
  SELECT count(*) INTO cross_rows
  FROM orders
  WHERE org_id = '00000000-0000-0000-0000-000000000001';
  IF visible_rows <> 25000 OR cross_rows <> 0 THEN
    RAISE EXCEPTION 'pool reuse isolation failed: visible %, cross %', visible_rows, cross_rows;
  END IF;
  BEGIN
    INSERT INTO orders VALUES (
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      900004, 1, 'open', 1000, now()
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    blocked := true;
    RAISE NOTICE 'pool tenant B forged write SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'pool reuse cross-tenant write was not blocked';
  END IF;
  RAISE NOTICE 'pool tenant B read=% tenant-A-read=%', visible_rows, cross_rows;
END
$test$;
COMMIT;

DO $test$
DECLARE
  visible_rows bigint;
BEGIN
  SELECT count(*) INTO visible_rows FROM orders;
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'pool reuse post-commit leaked % rows', visible_rows;
  END IF;
  RAISE NOTICE 'PASS pool reuse: switched tenant, no prior context leaked';
END
$test$;

BEGIN;
SET LOCAL app.org_id = '00000000-0000-0000-0000-000000000001';
SET LOCAL app.store_id = '10000000-0000-0000-0000-000000000001';
DO $test$
DECLARE
  blocked boolean;
BEGIN
  blocked := false;
  BEGIN
    INSERT INTO orders VALUES (
      '00000000-0000-0000-0000-000000000002',
      '20000000-0000-0000-0000-000000000001',
      900005, 1, 'open', 1000, now()
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    blocked := true;
    RAISE NOTICE 'forged INSERT SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'forged tenant insert was not blocked';
  END IF;

  INSERT INTO orders VALUES (
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    900006, 1, 'open', 1000, now()
  );
  blocked := false;
  BEGIN
    UPDATE orders
    SET store_id = '10000000-0000-0000-0000-000000000002'
    WHERE id = 900006;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    blocked := true;
    RAISE NOTICE 'forged UPDATE SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'forged tenant update was not blocked';
  END IF;
  RAISE NOTICE 'PASS WITH CHECK: forged INSERT and UPDATE blocked';
END
$test$;
ROLLBACK;

BEGIN;
SET LOCAL app.org_id = '00000000-0000-0000-0000-000000000001';
SET LOCAL app.store_id = '10000000-0000-0000-0000-000000000001';
DO $test$
DECLARE
  blocked boolean;
BEGIN
  blocked := false;
  BEGIN
    INSERT INTO garments VALUES (
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      1, 2, 900010, 'INVALID-CROSS-STORE'
    );
  EXCEPTION WHEN foreign_key_violation THEN
    blocked := true;
    RAISE NOTICE 'cross-store FK SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'same-org cross-store line attachment was not blocked';
  END IF;

  blocked := false;
  BEGIN
    INSERT INTO garments VALUES (
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      1, 5, 900011, 'INVALID-CROSS-ORDER'
    );
  EXCEPTION WHEN foreign_key_violation THEN
    blocked := true;
    RAISE NOTICE 'cross-order FK SQLSTATE=% error=%', SQLSTATE, SQLERRM;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'same-store cross-order line attachment was not blocked';
  END IF;
  RAISE NOTICE 'PASS composite FKs: cross-store and cross-order attachments blocked';
END
$test$;
ROLLBACK;

SELECT current_user AS query_role, rolbypassrls
FROM pg_roles
WHERE rolname = current_user;

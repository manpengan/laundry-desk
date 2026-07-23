-- Local compose bootstrap only. Formal schema comes exclusively from
-- packages/db/src/migrations via migrate-v2.sh; do not add application tables here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laundry_owner') THEN
    CREATE ROLE laundry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laundry_app') THEN
    CREATE ROLE laundry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- Weak local-only credentials. Production supplies managed identities instead.
ALTER ROLE laundry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE laundry_app LOGIN PASSWORD 'app_secure_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER DATABASE laundry_v2 OWNER TO laundry_owner;
GRANT CONNECT ON DATABASE laundry_v2 TO laundry_app;

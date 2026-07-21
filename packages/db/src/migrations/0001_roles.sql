-- Expand-only: create formal v2 roles (ADR-02).
-- laundry_owner: DDL / maintenance (FORCE RLS still applies when owner is table owner? FORCE blocks even owner)
-- laundry_app: application runtime, NOBYPASSRLS, non-owner.

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

ALTER ROLE laundry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE laundry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO laundry_app;
GRANT USAGE ON SCHEMA public TO laundry_owner;

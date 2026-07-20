\set ON_ERROR_STOP on

SELECT 'CREATE ROLE laundry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'laundry_owner')
\gexec

SELECT 'CREATE ROLE laundry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'laundry_app')
\gexec

ALTER ROLE laundry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS;
SELECT format(
  'ALTER ROLE laundry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'app_password'
)
\gexec

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public AUTHORIZATION laundry_owner;
GRANT USAGE ON SCHEMA public TO laundry_app;

SET ROLE laundry_owner;

CREATE TABLE orders (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  id bigint NOT NULL,
  customer_id bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'ready', 'closed')),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  created_at timestamptz NOT NULL,
  UNIQUE (org_id, store_id, id)
);

CREATE TABLE order_lines (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id bigint NOT NULL,
  id bigint NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  UNIQUE (org_id, store_id, order_id, id),
  CONSTRAINT order_lines_order_fk
    FOREIGN KEY (org_id, store_id, order_id)
    REFERENCES orders (org_id, store_id, id)
);

CREATE TABLE garments (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id bigint NOT NULL,
  order_line_id bigint NOT NULL,
  id bigint NOT NULL,
  barcode text NOT NULL,
  UNIQUE (org_id, store_id, id),
  UNIQUE (org_id, store_id, barcode),
  CONSTRAINT garments_order_fk
    FOREIGN KEY (org_id, store_id, order_id)
    REFERENCES orders (org_id, store_id, id),
  CONSTRAINT garments_order_line_fk
    FOREIGN KEY (org_id, store_id, order_id, order_line_id)
    REFERENCES order_lines (org_id, store_id, order_id, id)
);

CREATE INDEX orders_store_created_idx
  ON orders (org_id, store_id, created_at DESC);
CREATE INDEX orders_store_status_created_idx
  ON orders (org_id, store_id, status, created_at DESC);
CREATE INDEX orders_store_customer_created_idx
  ON orders (org_id, store_id, customer_id, created_at DESC);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON orders, order_lines, garments TO laundry_app;

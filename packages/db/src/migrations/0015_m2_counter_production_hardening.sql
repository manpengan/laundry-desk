-- M2 counter production hardening. Expand-only and safe after 0014.
--
-- 1) Make the grants for append-only ledgers explicit even if a role was
--    previously granted broader privileges outside the formal migrations.
-- 2) Bind photo metadata to the exact garment and order tenant tuple; this
--    prevents cross-order/cross-tenant attachment through opaque UUIDs.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE payments FROM laundry_app;
GRANT SELECT, INSERT ON TABLE audit_log TO laundry_app;
GRANT SELECT, INSERT ON TABLE payments TO laundry_app;

CREATE UNIQUE INDEX IF NOT EXISTS garments_order_garment_uidx
  ON garments (org_id, store_id, order_id, id);

ALTER TABLE garment_photos
  ADD CONSTRAINT garment_photos_garment_order_fk
  FOREIGN KEY (org_id, store_id, order_id, garment_id)
  REFERENCES garments (org_id, store_id, order_id, id)
  NOT VALID;

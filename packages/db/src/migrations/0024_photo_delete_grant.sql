-- The dedicated authenticated photo route deletes metadata and writes its
-- audit row in one tenant-scoped command transaction. Keep UPDATE/TRUNCATE
-- denied and grant only the DELETE capability required by that command.

GRANT DELETE ON TABLE garment_photos TO laundry_app;

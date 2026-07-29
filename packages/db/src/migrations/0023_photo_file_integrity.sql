-- Durable local photo files: bind each metadata row to one content digest.
--
-- Existing metadata-only rows remain readable as history but cannot be served
-- as files until they have a digest. New upload routes always write a digest.

ALTER TABLE garment_photos
  ADD COLUMN IF NOT EXISTS content_sha256 text;

ALTER TABLE garment_photos
  ADD CONSTRAINT garment_photos_content_sha256_chk
  CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')
  NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS garment_photos_storage_key_uidx
  ON garment_photos (org_id, store_id, storage_key)
  WHERE content_sha256 IS NOT NULL;

-- api/src/db/migrations/012_multipart_cut_source.sql
-- Provenance of an upload session that carries a segment cut from an OBS recording on
-- the recordings PC. Audit and retry only: video state still lives in staged_uploads.
ALTER TABLE multipart_uploads ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE multipart_uploads ADD COLUMN IF NOT EXISTS cut_id TEXT;
ALTER TABLE multipart_uploads ADD COLUMN IF NOT EXISTS cut_start_s DOUBLE PRECISION;
ALTER TABLE multipart_uploads ADD COLUMN IF NOT EXISTS cut_end_s DOUBLE PRECISION;
-- One live session per cut: a retried request finds it instead of opening a second
-- S3 upload. An aborted session frees the id so the cut can be redone.
CREATE UNIQUE INDEX IF NOT EXISTS multipart_uploads_live_cut
  ON multipart_uploads (cut_id) WHERE cut_id IS NOT NULL AND status <> 'aborted';

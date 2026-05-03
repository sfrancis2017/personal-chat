-- Tier 1 schema migration: hybrid retrieval + soft-delete + query logging.
--
-- Apply on the droplet's Postgres:
--   psql "$DATABASE_URL" -f /opt/retrieve/migrations/001_tier1.sql
--
-- Idempotent — safe to re-run. Uses IF NOT EXISTS / DO blocks throughout.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Soft-delete via validity timestamp
-- NULL = currently active. When a chunk is superseded by re-ingestion, set
-- valid_until = NOW() instead of DELETE — keeps history, supports rollback.
-- ---------------------------------------------------------------------------
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

-- Active-chunks index — every retrieval query filters WHERE valid_until IS NULL
CREATE INDEX IF NOT EXISTS chunks_valid_until_active_idx
  ON chunks (valid_until)
  WHERE valid_until IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Sparse retrieval (Postgres full-text search)
-- Generated tsvector keeps in sync automatically with text. GIN index gives
-- fast keyword/phrase matching for proper nouns, IDs, exact terms.
-- ---------------------------------------------------------------------------
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS text_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX IF NOT EXISTS chunks_text_tsv_gin_idx
  ON chunks USING GIN (text_tsv);

-- ---------------------------------------------------------------------------
-- 3. Visibility lookup index
-- Public-mode retrieval filters on metadata->>'visibility' every chat turn.
-- Functional index makes that O(log n) instead of a full table scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS chunks_visibility_idx
  ON chunks ((metadata->>'visibility'));

-- Helps the library aggregation query (group by topic + source_path)
CREATE INDEX IF NOT EXISTS chunks_topic_source_idx
  ON chunks (topic, source_path)
  WHERE valid_until IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Query logging — foundation for any future eval / quality work
-- Stores: the query, optional HyDE-generated text, retrieved chunks (as JSON
-- audit trail rather than FK), latency, mode, filters in effect, and a
-- one-way client hash (no raw IPs / tokens stored).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag_query_log (
  id          BIGSERIAL PRIMARY KEY,
  query       TEXT NOT NULL,
  hyde_text   TEXT,
  retrieved   JSONB,            -- [{source_path, topic, score, score_dense, score_sparse}, ...]
  latency_ms  INTEGER,
  mode        TEXT,             -- 'owner' | 'public'
  visibility  TEXT[],           -- ['public'] for public mode, NULL for owner
  topics      TEXT[],            -- topic chip selections (NULL if none)
  client_hash TEXT,             -- sha256(token) for owner / sha256(ip) for public
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rag_query_log_ts_desc_idx
  ON rag_query_log (ts DESC);

CREATE INDEX IF NOT EXISTS rag_query_log_mode_ts_idx
  ON rag_query_log (mode, ts DESC);

-- ---------------------------------------------------------------------------
-- 5. Backfill existing chunks: visibility = 'private' (safer default).
-- Public corpus is opt-in via the upload widget or future re-ingestion.
-- Only patches rows that don't already have a visibility key.
-- ---------------------------------------------------------------------------
UPDATE chunks
SET    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('visibility', 'private')
WHERE  (metadata IS NULL) OR (metadata->>'visibility' IS NULL);

-- Sanity check counts. Output via psql is fine for one-time migration.
DO $$
DECLARE
  active_count BIGINT;
  with_vis     BIGINT;
  pub_count    BIGINT;
  priv_count   BIGINT;
BEGIN
  SELECT COUNT(*) INTO active_count FROM chunks WHERE valid_until IS NULL;
  SELECT COUNT(*) INTO with_vis     FROM chunks WHERE metadata->>'visibility' IS NOT NULL;
  SELECT COUNT(*) INTO pub_count    FROM chunks WHERE metadata->>'visibility' = 'public';
  SELECT COUNT(*) INTO priv_count   FROM chunks WHERE metadata->>'visibility' = 'private';

  RAISE NOTICE 'Migration check: active=% with_visibility=% public=% private=%',
    active_count, with_vis, pub_count, priv_count;
END $$;

COMMIT;

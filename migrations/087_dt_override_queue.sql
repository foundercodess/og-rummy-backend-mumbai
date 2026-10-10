-- migrations/XXXXXX_dt_override_queue.sql

CREATE TABLE IF NOT EXISTS dt_override_queue (
  id BIGSERIAL PRIMARY KEY,
  target_round BIGINT NOT NULL,
  result VARCHAR(8) NOT NULL CHECK (result IN ('dragon', 'tiger', 'tie')),
  created_by INT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ,
  applied_round BIGINT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by INT REFERENCES admins(id) ON DELETE SET NULL
);

-- One pending override per round. Lets you enforce "already set" cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dt_override_target_pending
  ON dt_override_queue (target_round)
  WHERE applied_at IS NULL AND cancelled_at IS NULL;

-- Fast lookup for the engine.
CREATE INDEX IF NOT EXISTS idx_dt_override_target_pending
  ON dt_override_queue (target_round)
  WHERE applied_at IS NULL AND cancelled_at IS NULL;

-- Fast list for admin.
CREATE INDEX IF NOT EXISTS idx_dt_override_recent
  ON dt_override_queue (created_at DESC);

COMMENT ON TABLE dt_override_queue IS
  'Admin-scheduled forced outcomes. One pending override per target round. '
  'Engine consumes the row whose target_round matches the current round.';
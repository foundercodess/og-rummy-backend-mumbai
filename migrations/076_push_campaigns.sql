-- Push campaigns (admin bulk FCM via BullMQ worker)

CREATE TABLE IF NOT EXISTS push_campaigns (
  id SERIAL PRIMARY KEY,
  type VARCHAR(64) NOT NULL,
  inactive_days INT NULL,
  title VARCHAR(160) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  target_users INT NOT NULL DEFAULT 0,
  tokens_total INT NOT NULL DEFAULT 0,
  tokens_sent INT NOT NULL DEFAULT 0,
  tokens_failed INT NOT NULL DEFAULT 0,
  created_by INT NULL REFERENCES admins(id) ON DELETE SET NULL,
  error_message TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_campaigns_status_created
  ON push_campaigns (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_push_campaigns_type_created
  ON push_campaigns (type, created_at DESC);

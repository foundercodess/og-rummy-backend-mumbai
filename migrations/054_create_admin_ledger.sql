-- Immutable platform ledger: commission (rake) and bot win credits (exposure tracking).
-- idempotency_key prevents double-counting if settlement logic retries.

CREATE TABLE IF NOT EXISTS admin_ledger (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL
    CHECK (event_type IN ('commission', 'bot_win_credit')),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  game_session_id INT NULL REFERENCES game_sessions(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(160) NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_ledger_event_created
  ON admin_ledger(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_ledger_session
  ON admin_ledger(game_session_id);

CREATE INDEX IF NOT EXISTS idx_admin_ledger_created_at
  ON admin_ledger(created_at DESC);

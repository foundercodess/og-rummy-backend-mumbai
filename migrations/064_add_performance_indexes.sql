-- Hot-path support indexes for gameplay/admin/payment sync load.
-- Note: the project migration runner executes SQL directly, so avoid CONCURRENTLY here.

CREATE INDEX IF NOT EXISTS idx_recharge_transactions_pg_sync_pending
  ON recharge_transactions (requested_at ASC, id ASC)
  WHERE status = 'init'
    AND type = 'conventional'
    AND order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_withdrawal_transactions_pg_sync_pending
  ON withdrawal_transactions (requested_at ASC, id ASC)
  WHERE status = 'pending'
    AND order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_telemetry_events_created_at
  ON game_telemetry_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_game_telemetry_events_session_created
  ON game_telemetry_events (game_session_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_game_telemetry_events_event_channel_created
  ON game_telemetry_events (event_name, channel, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_game_telemetry_events_failed_created
  ON game_telemetry_events (created_at DESC, id DESC)
  WHERE success = false;

CREATE INDEX IF NOT EXISTS idx_game_sessions_waiting_created
  ON game_sessions (created_at ASC, id ASC)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_game_session_players_session_status
  ON game_session_players (game_session_id, status);

-- Game telemetry: socket actions, broadcasts, client delivery acks, and errors.

CREATE TABLE IF NOT EXISTS game_telemetry_events (
  id BIGSERIAL PRIMARY KEY,
  game_session_id INT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
  socket_id VARCHAR(64) NULL,
  trace_id VARCHAR(64) NOT NULL,
  direction VARCHAR(16) NOT NULL,
  channel VARCHAR(32) NOT NULL,
  event_name VARCHAR(64) NOT NULL,
  success BOOLEAN NULL,
  error_message TEXT NULL,
  delivery_status VARCHAR(24) NULL,
  client_sent_at TIMESTAMPTZ NULL,
  server_received_at TIMESTAMPTZ NULL,
  server_completed_at TIMESTAMPTZ NULL,
  client_ack_at TIMESTAMPTZ NULL,
  handler_ms INT NULL,
  client_rtt_ms INT NULL,
  payload_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  ack_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE game_telemetry_events
  ADD CONSTRAINT chk_game_telemetry_direction
  CHECK (direction IN ('inbound', 'outbound'));

ALTER TABLE game_telemetry_events
  ADD CONSTRAINT chk_game_telemetry_channel
  CHECK (channel IN ('socket_ack', 'socket_emit', 'client_ack', 'http'));

CREATE INDEX IF NOT EXISTS idx_game_telemetry_session_created
  ON game_telemetry_events(game_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_telemetry_trace_id
  ON game_telemetry_events(trace_id);

CREATE INDEX IF NOT EXISTS idx_game_telemetry_event_created
  ON game_telemetry_events(event_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_telemetry_user_created
  ON game_telemetry_events(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_telemetry_success_created
  ON game_telemetry_events(success, created_at DESC)
  WHERE success = false;

COMMENT ON TABLE game_telemetry_events IS 'Socket/game telemetry for latency, errors, and delivery tracking';

-- Broadcast delivery latency: server emit -> client received (client:telemetry:ack).

ALTER TABLE game_telemetry_events
  ADD COLUMN IF NOT EXISTS delivery_ms INT NULL;

COMMENT ON COLUMN game_telemetry_events.delivery_ms IS
  'Ms from server broadcast (socket_emit) to client receipt ack; populated on client_ack channel';

CREATE INDEX IF NOT EXISTS idx_game_telemetry_delivery_ms
  ON game_telemetry_events(game_session_id, delivery_ms)
  WHERE delivery_ms IS NOT NULL;

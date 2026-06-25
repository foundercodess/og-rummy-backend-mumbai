-- Payload sizes (UTF-8 JSON bytes) for latency vs bandwidth analysis.

ALTER TABLE game_telemetry_events
  ADD COLUMN IF NOT EXISTS request_bytes INT NULL,
  ADD COLUMN IF NOT EXISTS response_bytes INT NULL;

COMMENT ON COLUMN game_telemetry_events.request_bytes IS
  'Inbound payload size (client emit or client:telemetry:ack body) in UTF-8 JSON bytes';

COMMENT ON COLUMN game_telemetry_events.response_bytes IS
  'Outbound payload size (socket ACK or broadcast emit) in UTF-8 JSON bytes';

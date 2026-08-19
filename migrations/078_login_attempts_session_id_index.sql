-- Speed up JWT auth token validation: findActiveBySessionId is called on every
-- authenticated HTTP request and Socket.IO connection. Without this index the
-- query does a full seq-scan, causing 120-180ms acquire+exec under load.
CREATE INDEX IF NOT EXISTS idx_login_attempts_session_id_status
  ON login_attempts (session_id, status)
  WHERE status = 'active';

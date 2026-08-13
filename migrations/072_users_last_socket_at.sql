-- Track last realtime socket connection for admin "last activity".
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_socket_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_users_last_socket_at
  ON users (last_socket_at DESC NULLS LAST)
  WHERE COALESCE(is_bot, false) = false;

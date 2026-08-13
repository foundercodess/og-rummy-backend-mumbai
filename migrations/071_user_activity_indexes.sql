-- Speed up admin user list activity timestamps (last join / last gameplay).
CREATE INDEX IF NOT EXISTS idx_game_session_players_user_joined
  ON game_session_players (user_id, joined_at DESC);

CREATE INDEX IF NOT EXISTS idx_login_attempts_user_updated
  ON login_attempts (user_id, updated_at DESC)
  WHERE status IN ('active', 'deactive');

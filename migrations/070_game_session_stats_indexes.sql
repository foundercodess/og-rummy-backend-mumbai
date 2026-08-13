-- Support reliable per-game / per-contest session stats for admin Games section.
CREATE INDEX IF NOT EXISTS idx_game_sessions_contest_status
  ON game_sessions (contest_id, status);

CREATE INDEX IF NOT EXISTS idx_game_sessions_game_status
  ON game_sessions (game_id, status);

CREATE INDEX IF NOT EXISTS idx_game_sessions_status_ended_at
  ON game_sessions (status, ended_at DESC NULLS LAST);

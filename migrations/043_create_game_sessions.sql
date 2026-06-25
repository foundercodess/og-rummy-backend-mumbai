CREATE TABLE IF NOT EXISTS game_sessions (
  id SERIAL PRIMARY KEY,
  session_code VARCHAR(16) NOT NULL UNIQUE,
  game_id INT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  contest_id INT NOT NULL REFERENCES contests(id) ON DELETE RESTRICT,
  host_user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting',
  max_players INT NOT NULL,
  current_turn_user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NULL,
  ended_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_sessions_status_check CHECK (status IN ('waiting', 'ready', 'active', 'completed', 'cancelled')),
  CONSTRAINT game_sessions_max_players_check CHECK (max_players >= 2)
);

CREATE INDEX IF NOT EXISTS idx_game_sessions_status_created_at
  ON game_sessions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_sessions_host_user_id
  ON game_sessions(host_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS game_session_players (
  id SERIAL PRIMARY KEY,
  game_session_id INT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seat_no INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'joined',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT game_session_players_status_check CHECK (status IN ('joined', 'left', 'disconnected', 'eliminated')),
  CONSTRAINT game_session_players_unique_user UNIQUE (game_session_id, user_id),
  CONSTRAINT game_session_players_unique_seat UNIQUE (game_session_id, seat_no)
);

CREATE INDEX IF NOT EXISTS idx_game_session_players_session_id
  ON game_session_players(game_session_id, seat_no);

CREATE TABLE IF NOT EXISTS game_session_events (
  id BIGSERIAL PRIMARY KEY,
  game_session_id INT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_session_events_session_id_created_at
  ON game_session_events(game_session_id, created_at DESC);
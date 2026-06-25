-- Game types (Points, 101, Pool, etc.)
CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  dashboard_banner VARCHAR(500),
  side_banner VARCHAR(500),
  badge VARCHAR(500),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_games_sort ON games(sort_order, id);

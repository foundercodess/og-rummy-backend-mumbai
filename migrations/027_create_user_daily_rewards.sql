-- Per-user daily reward progress (7-day ladder)
CREATE TABLE IF NOT EXISTS user_daily_rewards (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_claimed_day INT,
  last_claimed_date DATE,
  cycle_started_date DATE,
  cycles_completed INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE user_daily_rewards IS 'Tracks per-user progress in 7-day daily reward ladder';


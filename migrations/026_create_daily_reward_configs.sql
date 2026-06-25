-- 7-day daily reward ladder configuration
CREATE TABLE IF NOT EXISTS daily_reward_configs (
  day_number INT PRIMARY KEY,
  amount NUMERIC(12,2) NOT NULL,
  image_url VARCHAR(500),
  reward_type VARCHAR(50) NOT NULL DEFAULT 'bonus', -- 'bonus' | 'cash' etc.
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE daily_reward_configs IS 'Static config for 7-day daily login rewards';

-- Seed default 7-day reward ladder
INSERT INTO daily_reward_configs (day_number, amount, image_url, reward_type, active)
VALUES
  (1, 5,    'https://example.com/rewards/day1.png',  'bonus', true),
  (2, 10,   'https://example.com/rewards/day2.png',  'bonus', true),
  (3, 15,   'https://example.com/rewards/day3.png',  'bonus', true),
  (4, 20,   'https://example.com/rewards/day4.png',  'bonus', true),
  (5, 50,   'https://example.com/rewards/day5.png',  'bonus', true),
  (6, 100,  'https://example.com/rewards/day6.png',  'bonus', true),
  (7, 1000, 'https://example.com/rewards/day7.png',  'bonus', true)
ON CONFLICT (day_number) DO UPDATE
SET amount = EXCLUDED.amount,
    image_url = EXCLUDED.image_url,
    reward_type = EXCLUDED.reward_type,
    active = EXCLUDED.active,
    updated_at = NOW();


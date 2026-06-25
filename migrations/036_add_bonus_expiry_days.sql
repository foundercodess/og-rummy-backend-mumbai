-- Add expiry configuration for bonus grants
ALTER TABLE daily_reward_configs
  ADD COLUMN IF NOT EXISTS bonus_expiry_days INT NOT NULL DEFAULT 7;

ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS bonus_expiry_days INT NOT NULL DEFAULT 30;

COMMENT ON COLUMN daily_reward_configs.bonus_expiry_days IS 'Expiry (days) for bonus rewards (pending_bonus). Used when reward_type is bonus.';
COMMENT ON COLUMN promo_codes.bonus_expiry_days IS 'Expiry (days) for promo bonus credits (pending_bonus).';


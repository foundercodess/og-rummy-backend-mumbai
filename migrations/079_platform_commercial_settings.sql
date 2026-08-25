-- Platform commercial settings (single-row): game rake + withdrawal policy knobs.
-- game_commission_percent is capped at 12% in application code ("upto 12%").

CREATE TABLE IF NOT EXISTS platform_commercial_settings (
  id SERIAL PRIMARY KEY,
  game_commission_percent NUMERIC(5, 2) NOT NULL DEFAULT 12.00
    CHECK (game_commission_percent >= 0 AND game_commission_percent <= 12),
  withdrawal_fee_percent NUMERIC(5, 2) NOT NULL DEFAULT 0
    CHECK (withdrawal_fee_percent >= 0 AND withdrawal_fee_percent <= 100),
  withdrawal_min_amount NUMERIC(12, 2) NOT NULL DEFAULT 100,
  withdrawal_daily_max_count INT NOT NULL DEFAULT 3,
  withdrawal_daily_max_amount NUMERIC(12, 2) NOT NULL DEFAULT 50000,
  withdrawal_min_account_age_hours INT NOT NULL DEFAULT 0,
  withdrawal_new_account_max_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  withdrawal_max_processing_count INT NOT NULL DEFAULT 5,
  withdrawal_require_approved_kyc BOOLEAN NOT NULL DEFAULT true,
  updated_by INT NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_commercial_settings (
  game_commission_percent,
  withdrawal_fee_percent,
  withdrawal_min_amount,
  withdrawal_daily_max_count,
  withdrawal_daily_max_amount,
  withdrawal_min_account_age_hours,
  withdrawal_new_account_max_amount,
  withdrawal_max_processing_count,
  withdrawal_require_approved_kyc
)
SELECT 12.00, 0, 100, 3, 50000, 0, 0, 5, true
WHERE NOT EXISTS (SELECT 1 FROM platform_commercial_settings);

COMMENT ON TABLE platform_commercial_settings IS
  'Single-row platform commercial config. game_commission_percent defaults to 12 and must stay <= 12.';
COMMENT ON COLUMN platform_commercial_settings.game_commission_percent IS
  'Platform game rake percent applied to prize/loss pools. Default 12, max 12.';

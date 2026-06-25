-- Promo/coupon codes for add cash (returned in config, validated at add cash)
-- Supports: manual code entry, "More Offers" list, nudge (gap computed by frontend from add_cash_options)
CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,

  -- Minimum deposit (base amount) to apply this promo
  min_amount NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Bonus on top of tier: percent = extra % of deposit, fixed = flat rupees
  bonus_type VARCHAR(10) NOT NULL DEFAULT 'percent',
  bonus_value NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Optional instant cash from promo (e.g. +₹250)
  instant_cash NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Display (e.g. "160% Bonus", "30% Bonus")
  display_label VARCHAR(64),

  -- Validity window
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,

  -- Limits: null = unlimited
  max_uses_total INT,
  max_uses_per_user INT DEFAULT 1,

  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE promo_codes
  ADD CONSTRAINT chk_promo_bonus_type
  CHECK (bonus_type IN ('percent', 'fixed'));

CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(active);
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(UPPER(code));
CREATE INDEX IF NOT EXISTS idx_promo_codes_sort ON promo_codes(sort_order, id);

COMMENT ON TABLE promo_codes IS 'Promo codes for add cash; list in config, nudge/apply logic on frontend';
COMMENT ON COLUMN promo_codes.bonus_type IS 'percent: bonus_value is extra %, fixed: bonus_value is flat rupees';
COMMENT ON COLUMN promo_codes.instant_cash IS 'Extra instant cash from this promo (added to tier instant_cash)';

-- Usage tracking (for max_uses_per_user / max_uses_total)
CREATE TABLE IF NOT EXISTS promo_code_usage (
  id SERIAL PRIMARY KEY,
  promo_code_id INT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recharge_transaction_id INT REFERENCES recharge_transactions(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_usage_promo ON promo_code_usage(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_usage_user ON promo_code_usage(user_id);

-- Seed sample promos (only if table is empty)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM promo_codes LIMIT 1) THEN
    INSERT INTO promo_codes (code, min_amount, bonus_type, bonus_value, instant_cash, display_label, max_uses_per_user, sort_order)
    VALUES
      ('WB5000', 5000, 'percent', 60, 250, '160% Bonus', 1, 1),
      ('V814MAR26', 10000, 'percent', 30, 0, '30% Bonus', 1, 2),
      ('WELCOME100', 100, 'fixed', 50, 0, '₹50 Bonus', 1, 3);
  END IF;
END $$;

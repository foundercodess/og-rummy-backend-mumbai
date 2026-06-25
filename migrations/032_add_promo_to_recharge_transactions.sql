-- Add promo fields to recharge_transactions
ALTER TABLE recharge_transactions
  ADD COLUMN IF NOT EXISTS promo_code_id INT REFERENCES promo_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS promo_bonus_amount NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promo_instant_cash NUMERIC(12,2) DEFAULT 0;

COMMENT ON COLUMN recharge_transactions.promo_code_id IS 'Applied promo at add cash';
COMMENT ON COLUMN recharge_transactions.promo_bonus_amount IS 'Bonus rupees from promo (percent/fixed)';
COMMENT ON COLUMN recharge_transactions.promo_instant_cash IS 'Instant cash from promo';

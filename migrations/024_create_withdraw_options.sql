-- Predefined withdrawable options for cash-out
CREATE TABLE IF NOT EXISTS withdraw_options (
  id SERIAL PRIMARY KEY,
  amount NUMERIC(12,2) NOT NULL,
  min_kyc_level VARCHAR(20), -- e.g. 'none', 'basic', 'full'
  is_hot BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdraw_options_active ON withdraw_options(active);
CREATE INDEX IF NOT EXISTS idx_withdraw_options_sort ON withdraw_options(sort_order, id);

COMMENT ON TABLE withdraw_options IS 'Preset withdraw amounts shown in UI for quick selection';
COMMENT ON COLUMN withdraw_options.amount IS 'Withdraw amount in currency units';
COMMENT ON COLUMN withdraw_options.min_kyc_level IS 'Optional KYC level requirement for this withdraw option';

-- Seed default withdraw options (only if table is empty)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM withdraw_options LIMIT 1) THEN
    INSERT INTO withdraw_options (amount, min_kyc_level, is_hot, sort_order)
    VALUES
      (50,    'none',  false, 1),
      (100,   'none',  true,  2),
      (500,   'basic', false, 3),
      (1000,  'basic', false, 4),
      (5000,  'full',  false, 5),
      (10000, 'full',  false, 6),
      (15000, 'full',  false, 7);
  END IF;
END $$;


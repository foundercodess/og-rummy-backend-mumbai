-- Predefined Add Cash options for deposits
CREATE TABLE IF NOT EXISTS add_cash_options (
  id SERIAL PRIMARY KEY,
  base_amount NUMERIC(10,2) NOT NULL,
  instant_cash NUMERIC(10,2) NOT NULL,
  bonus NUMERIC(10,2) NOT NULL,
  is_hot BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_add_cash_options_active ON add_cash_options(active);
CREATE INDEX IF NOT EXISTS idx_add_cash_options_sort ON add_cash_options(sort_order, id);

COMMENT ON COLUMN add_cash_options.active IS 'When false, option is hidden from public config (admin deactivated)';
COMMENT ON COLUMN add_cash_options.is_hot IS 'When true, option should be highlighted in UI';

-- Seed default Add Cash options (only if table is empty)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM add_cash_options LIMIT 1) THEN
    INSERT INTO add_cash_options (base_amount, instant_cash, bonus, is_hot, sort_order)
    VALUES
      (100, 100,   0,    true,  1),  -- hot option on top
      (200, 220,  20,    false, 2),
      (500, 575,  75,    false, 3),
      (1000, 1200, 200,  false, 4),
      (2000, 2500, 500,  false, 5);
  END IF;
END $$;


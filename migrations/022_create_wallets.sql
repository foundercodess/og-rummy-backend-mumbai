-- Wallets per user to track balances
CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- Aggregated balances (all amounts in currency smallest unit, e.g. rupees with 2 decimals)
  total_balance NUMERIC(12,2) NOT NULL DEFAULT 0,      -- withdrawable + deposit + bonuses
  pending_bonus NUMERIC(12,2) NOT NULL DEFAULT 0,      -- bonus not yet released
  released_bonus NUMERIC(12,2) NOT NULL DEFAULT 0,     -- bonus converted to usable balance
  withdrawable NUMERIC(12,2) NOT NULL DEFAULT 0,       -- amount user can withdraw
  deposit NUMERIC(12,2) NOT NULL DEFAULT 0,            -- amount user deposited (cash)

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);

COMMENT ON TABLE wallets IS 'Per-user wallet balances (deposit, bonus, withdrawable, totals)';
COMMENT ON COLUMN wallets.total_balance IS 'Sum of withdrawable + deposit + bonuses; must stay consistent with component fields';
COMMENT ON COLUMN wallets.pending_bonus IS 'Bonus credited but not yet released to usable balance';
COMMENT ON COLUMN wallets.released_bonus IS 'Bonus that has been released and can be used like cash in games';
COMMENT ON COLUMN wallets.withdrawable IS 'Amount user can withdraw to bank/UPI (subject to KYC etc.)';
COMMENT ON COLUMN wallets.deposit IS 'Net deposited amount (cash in) after adjustments';


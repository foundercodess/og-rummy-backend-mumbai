-- Add a high-level type classification for wallet transaction history
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS type VARCHAR(40) NOT NULL DEFAULT 'other';

CREATE INDEX IF NOT EXISTS idx_wallet_tx_type ON wallet_transactions(type, created_at DESC);

COMMENT ON COLUMN wallet_transactions.type IS 'High-level classification (e.g. weekly_reward, admin, contest_reward, etc.)';


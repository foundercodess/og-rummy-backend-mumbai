-- Wallet transaction history / ledger (credits/debits with references)
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id INT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,

  -- deposit_credit: goes to deposit wallet
  -- pending_bonus_credit: goes to pending_bonus wallet (expires_at required)
  transaction_type VARCHAR(40) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,

  -- Source system and optional reference
  source VARCHAR(40) NOT NULL, -- daily_reward | recharge | promo | admin | other
  reference_type VARCHAR(40),
  reference_id INT,

  expires_at TIMESTAMPTZ,
  metadata JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wallet_transactions
  ADD CONSTRAINT chk_wallet_transactions_type
  CHECK (transaction_type IN ('deposit_credit', 'pending_bonus_credit'));

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_source ON wallet_transactions(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_reference ON wallet_transactions(reference_type, reference_id);

COMMENT ON TABLE wallet_transactions IS 'Wallet ledger entries (deposit credits, pending bonus credits with expiry, etc.)';

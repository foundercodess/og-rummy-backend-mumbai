-- User saved bank accounts for withdrawals
CREATE TABLE IF NOT EXISTS user_bank_accounts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_holder_name VARCHAR(100) NOT NULL,
  bank_name VARCHAR(120) NOT NULL,
  account_number VARCHAR(30) NOT NULL,
  ifsc_code VARCHAR(20) NOT NULL,
  branch VARCHAR(120),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_bank_accounts_user ON user_bank_accounts(user_id, active, created_at DESC);

-- Withdrawal / payout transaction history
CREATE TABLE IF NOT EXISTS withdrawal_transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id INT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  bank_account_id INT REFERENCES user_bank_accounts(id) ON DELETE SET NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'conventional',
  amount NUMERIC(12,2) NOT NULL,
  handling_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(12,2) NOT NULL,
  withdraw_no VARCHAR(64) NOT NULL UNIQUE,
  order_id VARCHAR(32) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  pg_reference VARCHAR(64),
  payout_response TEXT,
  bank_snapshot JSONB,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE withdrawal_transactions
  ADD CONSTRAINT chk_withdrawal_type
  CHECK (type IN ('conventional', 'p2p'));

ALTER TABLE withdrawal_transactions
  ADD CONSTRAINT chk_withdrawal_status
  CHECK (status IN ('init', 'pending', 'processing', 'successful', 'failed', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawal_transactions(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_order_id ON withdrawal_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawal_transactions(status);

COMMENT ON TABLE user_bank_accounts IS 'Saved bank accounts for user withdrawals';
COMMENT ON TABLE withdrawal_transactions IS 'Withdrawal/payout requests and their PG status';

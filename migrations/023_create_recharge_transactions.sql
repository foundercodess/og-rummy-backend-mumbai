-- Recharge (Add Cash) transaction history
CREATE TABLE IF NOT EXISTS recharge_transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id INT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,

  -- conventional: payment gateway based, p2p: manual/P2P credit
  type VARCHAR(20) NOT NULL,

  amount NUMERIC(12,2) NOT NULL,

  -- External order / transaction identifier (e.g. from payment gateway)
  order_id VARCHAR(32) NOT NULL UNIQUE,
  payment_ref VARCHAR(64),

  status VARCHAR(20) NOT NULL DEFAULT 'init',

  -- Raw payment gateway response / metadata as JSON string
  payment_response TEXT,

  -- Optional metadata
  add_cash_option_id INT REFERENCES add_cash_options(id) ON DELETE SET NULL,
  currency VARCHAR(10) DEFAULT 'INR',

  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Constrain enums via CHECKs
ALTER TABLE recharge_transactions
  ADD CONSTRAINT chk_recharge_type
  CHECK (type IN ('conventional', 'p2p'));

ALTER TABLE recharge_transactions
  ADD CONSTRAINT chk_recharge_status
  CHECK (status IN ('init', 'payment_success', 'failed', 'not_paid'));

CREATE INDEX IF NOT EXISTS idx_recharge_user ON recharge_transactions(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_order_id ON recharge_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_recharge_status ON recharge_transactions(status);

COMMENT ON TABLE recharge_transactions IS 'Recharge/Add Cash transaction history per user';
COMMENT ON COLUMN recharge_transactions.type IS 'conventional: payment gateway based, p2p: manual/P2P credit';
COMMENT ON COLUMN recharge_transactions.status IS 'init, payment_success, failed, not_paid';


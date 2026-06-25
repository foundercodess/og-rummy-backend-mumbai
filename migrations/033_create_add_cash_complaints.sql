-- Add Cash complaint/support tickets (user-reported issues for recharge/add-cash)
CREATE TABLE IF NOT EXISTS add_cash_complaints (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The client-provided transaction reference (e.g. order_id / gateway transaction id)
  cash_transaction_id VARCHAR(64) NOT NULL,

  -- If we can map the reference to our recharge transaction, store it too (optional)
  recharge_transaction_id INT REFERENCES recharge_transactions(id) ON DELETE SET NULL,

  payment_proof_image_url TEXT NOT NULL,
  utr_no VARCHAR(64),
  payment_time TIMESTAMPTZ,
  phone VARCHAR(20),

  -- Simple ticket lifecycle
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  admin_notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE add_cash_complaints
  ADD CONSTRAINT chk_add_cash_complaint_status
  CHECK (status IN ('open', 'in_review', 'resolved', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_add_cash_complaints_user ON add_cash_complaints(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_add_cash_complaints_tx_ref ON add_cash_complaints(cash_transaction_id);
CREATE INDEX IF NOT EXISTS idx_add_cash_complaints_recharge_tx ON add_cash_complaints(recharge_transaction_id);

COMMENT ON TABLE add_cash_complaints IS 'User complaints for add-cash/recharge transactions';
COMMENT ON COLUMN add_cash_complaints.cash_transaction_id IS 'Client-provided transaction reference (order_id or external tx id)';
COMMENT ON COLUMN add_cash_complaints.payment_proof_image_url IS 'URL of payment proof image uploaded by user';

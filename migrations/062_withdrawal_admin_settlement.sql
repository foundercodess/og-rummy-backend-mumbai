-- Admin-mediated withdrawal settlement support

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS withdrawals_frozen BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_withdrawals_frozen
  ON users(withdrawals_frozen)
  WHERE withdrawals_frozen = true;

ALTER TABLE withdrawal_transactions
  ADD COLUMN IF NOT EXISTS admin_notes TEXT,
  ADD COLUMN IF NOT EXISTS pg_remark TEXT,
  ADD COLUMN IF NOT EXISTS settled_by INT REFERENCES admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_withdrawals_status_requested
  ON withdrawal_transactions(status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_withdrawals_withdraw_no
  ON withdrawal_transactions(withdraw_no);

CREATE INDEX IF NOT EXISTS idx_withdrawals_pg_reference
  ON withdrawal_transactions(pg_reference)
  WHERE pg_reference IS NOT NULL;

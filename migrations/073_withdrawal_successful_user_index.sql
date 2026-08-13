-- Speed up last successful withdrawal lookups for admin users list/details.
CREATE INDEX IF NOT EXISTS idx_withdrawal_tx_user_successful_completed
  ON withdrawal_transactions (user_id, completed_at DESC)
  WHERE status = 'successful';

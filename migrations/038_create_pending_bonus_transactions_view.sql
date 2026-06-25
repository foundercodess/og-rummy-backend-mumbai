-- Convenience view for "pending bonus transactions" (history for user)
-- This is a view over wallet_transactions to keep naming intuitive.
CREATE OR REPLACE VIEW pending_bonus_transactions AS
SELECT
  id,
  user_id,
  wallet_id,
  type,
  source,
  amount,
  reference_type,
  reference_id,
  expires_at,
  metadata,
  created_at
FROM wallet_transactions
WHERE transaction_type = 'pending_bonus_credit';

COMMENT ON VIEW pending_bonus_transactions IS 'View of wallet_transactions filtered to pending bonus credits (any source)';


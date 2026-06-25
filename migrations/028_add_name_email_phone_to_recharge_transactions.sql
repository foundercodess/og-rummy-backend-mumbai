-- Add name, email, phone to recharge_transactions for add cash flow
ALTER TABLE recharge_transactions
  ADD COLUMN IF NOT EXISTS name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS phone VARCHAR(32);

COMMENT ON COLUMN recharge_transactions.name IS 'User name at time of add cash';
COMMENT ON COLUMN recharge_transactions.email IS 'User email at time of add cash';
COMMENT ON COLUMN recharge_transactions.phone IS 'User phone at time of add cash';

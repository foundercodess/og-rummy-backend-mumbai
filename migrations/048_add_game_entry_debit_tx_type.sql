-- Add game entry debit transaction type for deals join-time wallet deductions.

ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS chk_wallet_transactions_type;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT chk_wallet_transactions_type
  CHECK (transaction_type IN (
    'deposit_credit',
    'pending_bonus_credit',
    'game_win_credit',
    'game_loss_debit',
    'game_entry_debit'
  ));

COMMENT ON CONSTRAINT chk_wallet_transactions_type ON wallet_transactions
  IS 'Allowed wallet ledger entry types including game settlement and entry debits';

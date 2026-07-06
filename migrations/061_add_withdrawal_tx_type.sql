-- Allow withdrawal debit ledger entries (used by withdrawal.service.js).

ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS chk_wallet_transactions_type;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT chk_wallet_transactions_type
  CHECK (transaction_type IN (
    'deposit_credit',
    'pending_bonus_credit',
    'game_win_credit',
    'game_loss_debit',
    'game_entry_debit',
    'bonus_release_credit',
    'released_bonus_credit',
    'release_bonus_credit',
    'withdraw_debit'
  ));

COMMENT ON CONSTRAINT chk_wallet_transactions_type ON wallet_transactions
  IS 'Allowed wallet ledger types including game settlement, entry debits, bonus release, and withdrawals';

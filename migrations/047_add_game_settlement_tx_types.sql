-- Add game settlement transaction types to the wallet_transactions CHECK constraint.
--
-- game_win_credit  : deposit credited to the winner (sum of opponents' point losses × point_value).
-- game_loss_debit  : deposit debited from each loser (their points × point_value).
--
-- Both reference game_session rows via (reference_type='game_session', reference_id=session_id).

ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS chk_wallet_transactions_type;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT chk_wallet_transactions_type
  CHECK (transaction_type IN (
    'deposit_credit',
    'pending_bonus_credit',
    'game_win_credit',
    'game_loss_debit'
  ));

COMMENT ON CONSTRAINT chk_wallet_transactions_type ON wallet_transactions
  IS 'Allowed wallet ledger entry types: recharge credits, bonus credits, game win credits, game loss debits';

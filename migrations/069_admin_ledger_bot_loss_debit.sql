-- Allow bot loss debits on admin_ledger so dashboard P&L can go negative on bot losses.
-- Commission remains non-negative; only bot_loss_debit represents admin downside.

ALTER TABLE admin_ledger
  DROP CONSTRAINT IF EXISTS admin_ledger_event_type_check;

ALTER TABLE admin_ledger
  ADD CONSTRAINT admin_ledger_event_type_check
  CHECK (event_type IN ('commission', 'bot_win_credit', 'bot_loss_debit'));

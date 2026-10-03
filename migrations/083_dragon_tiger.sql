-- Dragon Tiger: one shared, house-banked table with a fixed round clock.
-- Isolated from rummy / Teen Patti: no games row, no game_sessions, no contests.
-- Joins also require DRAGONTIGER_ENGINE_ENABLED=true.

CREATE TABLE IF NOT EXISTS dt_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  betting_seconds INT NOT NULL DEFAULT 15 CHECK (betting_seconds BETWEEN 5 AND 60),
  reveal_seconds INT NOT NULL DEFAULT 5 CHECK (reveal_seconds BETWEEN 3 AND 20),
  result_seconds INT NOT NULL DEFAULT 3 CHECK (result_seconds BETWEEN 2 AND 20),
  chip_values INT[] NOT NULL DEFAULT ARRAY[10, 50, 100, 500, 1000],
  min_bet NUMERIC(12, 2) NOT NULL DEFAULT 10 CHECK (min_bet > 0),
  max_bet_per_area NUMERIC(12, 2) NOT NULL DEFAULT 10000 CHECK (max_bet_per_area > 0),
  max_round_payout NUMERIC(14, 2) NOT NULL DEFAULT 500000 CHECK (max_round_payout > 0),
  commission_percent NUMERIC(5, 2) NOT NULL DEFAULT 5
    CHECK (commission_percent >= 0 AND commission_percent <= 12),
  updated_by INT NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dt_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE dt_settings IS
  'Single-row Dragon Tiger config. enabled=false pauses new rounds; the running round still settles.';
COMMENT ON COLUMN dt_settings.max_bet_per_area IS 'Per user, per betting area, per round.';
COMMENT ON COLUMN dt_settings.max_round_payout IS
  'Cap on the gross payout of the worst outcome for a round; bets that would exceed it are refused.';

CREATE TABLE IF NOT EXISTS dt_rounds (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'betting'
    CHECK (status IN ('betting', 'locked', 'settling', 'settled', 'cancelled')),
  betting_ends_at TIMESTAMPTZ NOT NULL,
  dragon_card VARCHAR(4),
  tiger_card VARCHAR(4),
  result VARCHAR(8) CHECK (result IN ('dragon', 'tiger', 'tie')),
  shoe_id VARCHAR(32),
  shoe_position INT,
  dragon_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tiger_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tie_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_staked NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_returned NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_commission NUMERIC(14, 2) NOT NULL DEFAULT 0,
  commission_percent NUMERIC(5, 2) NOT NULL,
  totals_version INT NOT NULL DEFAULT 0,
  reveal_seconds INT NOT NULL DEFAULT 5,
  result_seconds INT NOT NULL DEFAULT 3,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ
);

-- At most one unsettled round at a time (guards against two engine leaders during failover).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dt_rounds_single_open
  ON dt_rounds ((true))
  WHERE status IN ('betting', 'locked', 'settling');

CREATE INDEX IF NOT EXISTS idx_dt_rounds_created ON dt_rounds (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dt_rounds_settled ON dt_rounds (id DESC) WHERE status = 'settled';

CREATE TABLE IF NOT EXISTS dt_bets (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES dt_rounds(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area VARCHAR(8) NOT NULL CHECK (area IN ('dragon', 'tiger', 'tie')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  from_deposit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  from_released_bonus NUMERIC(12, 2) NOT NULL DEFAULT 0,
  from_withdrawable NUMERIC(12, 2) NOT NULL DEFAULT 0,
  client_bet_id VARCHAR(64),
  status VARCHAR(12) NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed', 'won', 'lost', 'half_back', 'refunded')),
  payout NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dt_bets_client_bet
  ON dt_bets (user_id, client_bet_id)
  WHERE client_bet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dt_bets_round_user ON dt_bets (round_id, user_id);
CREATE INDEX IF NOT EXISTS idx_dt_bets_user_created ON dt_bets (user_id, created_at DESC);

-- One row per user per round. Inserting it is the idempotency gate for the settlement credit.
CREATE TABLE IF NOT EXISTS dt_round_settlements (
  round_id BIGINT NOT NULL REFERENCES dt_rounds(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staked NUMERIC(12, 2) NOT NULL,
  returned NUMERIC(12, 2) NOT NULL,
  commission NUMERIC(12, 2) NOT NULL DEFAULT 0,
  credited NUMERIC(12, 2) NOT NULL,
  net NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (round_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dt_settlements_user ON dt_round_settlements (user_id, created_at DESC);

-- Refunds (Clear bets, cancelled rounds) go back to the original wallet buckets.
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
    'withdraw_debit',
    'game_refund_credit'
  ));

COMMENT ON CONSTRAINT chk_wallet_transactions_type ON wallet_transactions
  IS 'Allowed wallet ledger types including game settlement, entry debits, refunds, bonus release, and withdrawals';

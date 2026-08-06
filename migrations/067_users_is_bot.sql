-- Bot engine provisions real user rows for gameplay; mark them so admin stats/lists stay human-only.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_is_bot ON users (is_bot) WHERE is_bot = true;

COMMENT ON COLUMN users.is_bot IS 'True for bot-engine accounts (synthetic phone pool); excluded from admin user counts/lists';

-- Default bot phone prefix matches BOT_PHONE_PREFIX (98999) + 6-digit suffix.
UPDATE users
SET is_bot = true,
    updated_at = NOW()
WHERE is_bot = false
  AND phone ~ '^98999[0-9]{6}$';

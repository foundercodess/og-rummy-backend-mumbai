-- Add user active flag and admin rejection note for KYC
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

UPDATE users
SET active = true
WHERE active IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);

COMMENT ON COLUMN users.active IS 'When false, user account is blocked from authenticated API usage';

ALTER TABLE kyc
  ADD COLUMN IF NOT EXISTS rejection_note TEXT;

COMMENT ON COLUMN kyc.rejection_note IS 'Admin note when KYC is rejected';

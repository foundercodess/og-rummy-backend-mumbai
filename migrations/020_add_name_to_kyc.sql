-- Add card holder name to KYC and keep status/active managed internally.
ALTER TABLE kyc ADD COLUMN IF NOT EXISTS name VARCHAR(150);


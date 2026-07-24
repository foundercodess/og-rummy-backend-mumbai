-- Track when KYC was approved (admin review timestamp).
ALTER TABLE kyc
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Backfill previously approved rows using updated_at as best-effort approval time.
UPDATE kyc
SET approved_at = COALESCE(approved_at, updated_at)
WHERE status = 'approved'
  AND approved_at IS NULL;

COMMENT ON COLUMN kyc.approved_at IS 'Timestamp when admin approved this KYC (null if never approved)';

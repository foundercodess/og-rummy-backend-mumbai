-- KYC verification: one record per user, upsert by user_id. status: submitted, approved, rejected.
CREATE TYPE kyc_status AS ENUM ('submitted', 'approved', 'rejected');

CREATE TABLE IF NOT EXISTS kyc (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  image_url VARCHAR(500),
  card_no VARCHAR(50),
  dob DATE,
  state VARCHAR(100),
  status kyc_status NOT NULL DEFAULT 'submitted',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc(status);

COMMENT ON TABLE kyc IS 'User KYC verification; upsert by user_id. id returned as kyc_id in API.';

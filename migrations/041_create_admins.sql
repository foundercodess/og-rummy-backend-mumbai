-- Admin users for panel/backoffice authentication
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'admin',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admins
  ADD CONSTRAINT chk_admin_role
  CHECK (role IN ('admin', 'super_admin'));

CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_admins_active ON admins(active);

-- Seed initial admin credentials
-- email: rummy@admin
-- password: rummy@2026
INSERT INTO admins (email, password_hash, password_salt, role, active)
VALUES (
  'rummy@admin',
  '61b0e3ca6e1d197f15a9c62a8d33c7da548898bf2f8886d5aadb5972d12ea21f6eac45ef8662f5a05f108c8ce11b8d6292deb1732121c90aa53432eef8490db8',
  '9766e7c735e27694d4eb5c839564bd19',
  'super_admin',
  true
)
ON CONFLICT (email) DO NOTHING;

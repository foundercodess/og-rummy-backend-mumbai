-- Indian states and union territories for config (e.g. user profile / KYC)
-- CREATE TABLE IF NOT EXISTS states (
--   id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
--   name VARCHAR(100) NOT NULL UNIQUE,
--   sort_order INT DEFAULT 0,
--   active BOOLEAN NOT NULL DEFAULT true,
--   created_at TIMESTAMPTZ DEFAULT NOW(),
--   updated_at TIMESTAMPTZ DEFAULT NOW()
-- );
-- -- Add active flag to states so admin can enable/disable; config API returns only active states.

-- CREATE INDEX IF NOT EXISTS idx_states_active ON states(active);

-- COMMENT ON COLUMN states.active IS 'When false, state is excluded from config API (admin disabled)';
-- CREATE INDEX IF NOT EXISTS idx_states_sort ON states(sort_order, id);

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS states (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name CITEXT NOT NULL UNIQUE,
  sort_order INT DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_states_active ON states(active);
CREATE INDEX IF NOT EXISTS idx_states_sort ON states(sort_order, id);

COMMENT ON COLUMN states.active IS 'When false, state is excluded from config API (admin disabled)';

INSERT INTO states (name, sort_order) VALUES
  ('Andaman and Nicobar Islands', 1),
  ('Andhra Pradesh', 2),
  ('Arunachal Pradesh', 3),
  ('Assam', 4),
  ('Bihar', 5),
  ('Chandigarh', 6),
  ('Chhattisgarh', 7),
  ('Dadra and Nagar Haveli and Daman and Diu', 8),
  ('Delhi', 9),
  ('Goa', 10),
  ('Gujarat', 11),
  ('Haryana', 12),
  ('Himachal Pradesh', 13),
  ('Jammu and Kashmir', 14),
  ('Jharkhand', 15),
  ('Karnataka', 16),
  ('Kerala', 17),
  ('Ladakh', 18),
  ('Lakshadweep', 19),
  ('Madhya Pradesh', 20),
  ('Maharashtra', 21),
  ('Manipur', 22),
  ('Meghalaya', 23),
  ('Mizoram', 24),
  ('Nagaland', 25),
  ('Odisha', 26),
  ('Puducherry', 27),
  ('Punjab', 28),
  ('Rajasthan', 29),
  ('Sikkim', 30),
  ('Tamil Nadu', 31),
  ('Telangana', 32),
  ('Tripura', 33),
  ('Uttar Pradesh', 34),
  ('Uttarakhand', 35),
  ('West Bengal', 36)
ON CONFLICT (name) DO NOTHING;

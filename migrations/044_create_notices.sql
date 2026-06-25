CREATE TABLE IF NOT EXISTS notices (
  id SERIAL PRIMARY KEY,
  message TEXT NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'info',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_admin_id INT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notices_active_window
  ON notices(is_active, starts_at, ends_at, sort_order, id);

ALTER TABLE notices
  ADD CONSTRAINT chk_notices_type
  CHECK (type IN ('info', 'warning', 'success', 'error'));

ALTER TABLE notices
  ADD CONSTRAINT chk_notices_time_window
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at);

-- INSERT INTO notices (message, type, is_active, sort_order, metadata)
-- SELECT 'Welcome to OG Rummy. Enjoy the tables and play responsibly.', 'info', true, 1, '{"source":"migration"}'::jsonb
-- WHERE NOT EXISTS (
--   SELECT 1 FROM notices WHERE message = 'Welcome to OG Rummy. Enjoy the tables and play responsibly.'
-- );

-- INSERT INTO notices (message, type, is_active, sort_order, metadata)
-- SELECT 'Support is available from the Help section for wallet or gameplay issues.', 'warning', true, 2, '{"source":"migration"}'::jsonb
-- WHERE NOT EXISTS (
--   SELECT 1 FROM notices WHERE message = 'Support is available from the Help section for wallet or gameplay issues.'
-- );
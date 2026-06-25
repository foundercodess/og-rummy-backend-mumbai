CREATE TABLE IF NOT EXISTS maintenance_modes (
  id SERIAL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  title VARCHAR(120) DEFAULT 'Scheduled Maintenance',
  message TEXT DEFAULT 'We are currently under maintenance. Please try again shortly.',
  start_at TIMESTAMPTZ NULL,
  end_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by INT NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO maintenance_modes (enabled)
SELECT FALSE
WHERE NOT EXISTS (SELECT 1 FROM maintenance_modes);

-- Admin-controlled toggle for bot seat injection (lobby fill, rematch fill, carry-forward).
CREATE TABLE IF NOT EXISTS bot_injection_settings (
  id SERIAL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by INT NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO bot_injection_settings (enabled)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM bot_injection_settings);

COMMENT ON TABLE bot_injection_settings IS 'Single-row config: when enabled=false, no new bot players are injected into tables';

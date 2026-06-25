-- Support links shown in config (WhatsApp, Telegram, etc.)
CREATE TABLE IF NOT EXISTS support_links (
  id SERIAL PRIMARY KEY,
  key VARCHAR(40) NOT NULL UNIQUE, -- whatsapp, telegram, etc.
  title VARCHAR(80) NOT NULL,
  image_url VARCHAR(500),
  redirect_url TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_links_active ON support_links(active, sort_order, id);

COMMENT ON TABLE support_links IS 'Support contact/action links returned by config API';

-- Seed defaults (safe upsert)
INSERT INTO support_links (key, title, image_url, redirect_url, active, sort_order)
VALUES
  ('whatsapp', 'WhatsApp', NULL, 'https://wa.me/', true, 1),
  ('telegram', 'Telegram', NULL, 'https://t.me/', true, 2)
ON CONFLICT (key) DO UPDATE
SET title = EXCLUDED.title,
    image_url = EXCLUDED.image_url,
    redirect_url = EXCLUDED.redirect_url,
    active = EXCLUDED.active,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();


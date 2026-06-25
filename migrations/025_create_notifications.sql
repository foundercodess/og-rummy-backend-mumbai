-- User notifications (system, wallet, promo, etc.)
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'system',

  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,

  metadata TEXT, -- JSON string for extra data (e.g. deep-link, context)

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = false;

ALTER TABLE notifications
  ADD CONSTRAINT chk_notifications_type
  CHECK (type IN ('system', 'welcome', 'wallet', 'promo'));

COMMENT ON TABLE notifications IS 'Per-user notifications (system, wallet, promo, etc.)';
COMMENT ON COLUMN notifications.metadata IS 'Optional JSON-encoded metadata for notification';


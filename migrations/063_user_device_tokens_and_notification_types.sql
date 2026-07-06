-- FCM device tokens for push notifications
CREATE TABLE IF NOT EXISTS user_device_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  platform VARCHAR(20),
  device_id VARCHAR(128),
  app_version VARCHAR(32),
  active BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fcm_token)
);

CREATE INDEX IF NOT EXISTS idx_user_device_tokens_user_active
  ON user_device_tokens(user_id, active)
  WHERE active = true;

-- Extend notification types for wallet/support events
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notifications_type;
ALTER TABLE notifications ADD CONSTRAINT chk_notifications_type
  CHECK (type IN ('system', 'welcome', 'wallet', 'promo', 'support', 'withdrawal', 'recharge'));

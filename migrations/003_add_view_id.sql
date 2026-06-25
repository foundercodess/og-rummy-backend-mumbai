-- Add unique 6-digit view_id for each user
ALTER TABLE users ADD COLUMN IF NOT EXISTS view_id VARCHAR(6) UNIQUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_view_id ON users(view_id) WHERE view_id IS NOT NULL;

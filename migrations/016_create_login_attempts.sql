-- Login attempts / sessions: track device and status for dispute and one-session-per-user.
-- status: req = OTP requested (not verified), active = current session, deactive = logged out or replaced
CREATE TYPE login_attempt_status AS ENUM ('req', 'active', 'deactive');

CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  phone VARCHAR(15) NOT NULL,
  status login_attempt_status NOT NULL DEFAULT 'req',
  device_info TEXT,
  ip VARCHAR(45),
  user_agent TEXT,
  session_id VARCHAR(36) UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_phone ON login_attempts(phone);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user_status ON login_attempts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_login_attempts_session ON login_attempts(session_id) WHERE session_id IS NOT NULL;

COMMENT ON TABLE login_attempts IS 'OTP requests and active sessions; device_info is JSON string from frontend for dispute reference';
COMMENT ON COLUMN login_attempts.status IS 'req=requested OTP, active=logged in (one per user), deactive=logged out or replaced';

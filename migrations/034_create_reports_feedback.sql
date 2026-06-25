-- Generic user reports/feedback (withdrawal issues, bug reports, etc.)
CREATE TABLE IF NOT EXISTS reports_feedback (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  type VARCHAR(30) NOT NULL,
  feedback_content TEXT NOT NULL,
  picture_urls TEXT[] DEFAULT ARRAY[]::TEXT[],
  phone VARCHAR(20),

  status VARCHAR(20) NOT NULL DEFAULT 'open',
  admin_notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE reports_feedback
  ADD CONSTRAINT chk_reports_feedback_type
  CHECK (type IN ('withdrawal', 'bug_report'));

ALTER TABLE reports_feedback
  ADD CONSTRAINT chk_reports_feedback_status
  CHECK (status IN ('open', 'in_review', 'resolved', 'rejected'));

ALTER TABLE reports_feedback
  ADD CONSTRAINT chk_reports_feedback_picture_urls_len
  CHECK (array_length(picture_urls, 1) IS NULL OR array_length(picture_urls, 1) <= 3);

CREATE INDEX IF NOT EXISTS idx_reports_feedback_user ON reports_feedback(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_feedback_type ON reports_feedback(type);

COMMENT ON TABLE reports_feedback IS 'User report/feedback tickets (withdrawal issues, bug reports, etc.)';
COMMENT ON COLUMN reports_feedback.picture_urls IS 'Up to 3 image URLs supporting the report/feedback';

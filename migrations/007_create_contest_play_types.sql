-- Play types (best-of-X) supported per contest
CREATE TABLE IF NOT EXISTS contest_play_types (
  contest_id INT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  play_type INT NOT NULL,
  PRIMARY KEY (contest_id, play_type),
  CONSTRAINT chk_play_type CHECK (play_type IN (2, 4, 6))
);

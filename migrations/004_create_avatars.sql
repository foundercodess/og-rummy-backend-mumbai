-- Avatar options for user profile selection
CREATE TABLE IF NOT EXISTS avatars (
  id SERIAL PRIMARY KEY,
  url VARCHAR(500) NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_avatars_sort ON avatars(sort_order);

-- Seed default avatars (placeholder URLs - replace with your CDN/storage URLs)
INSERT INTO avatars (url, sort_order) VALUES
  ('https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/avatar/avtar_1_without_border.png', 1),
  ('https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/avatar/avtar_2_without_border.png', 2),
  ('https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/avatar/avtar_3_without_border.png', 3),
  ('https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/avatar/avtar_4_without_border.png', 4),
  ('https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/avatar/avtar_5_without_border.png', 5),
  ('https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/avatar/avtar_6_without_border.png', 6),
  ('https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/avatar/avtar_7_without_border.png', 7)
;

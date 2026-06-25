-- Replace games with updated list and S3 images
-- Delete existing games (CASCADE removes contests and contest_play_types)
TRUNCATE games CASCADE;

-- Dashboard: dashboard_images/, Side: sidebar_game_images/, Badge: null
INSERT INTO games (name, dashboard_banner, side_banner, badge, sort_order) VALUES
  ('Points', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/dashboard_images/point.png', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/points_logo.png', NULL, 1),
  ('101 Pool', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/dashboard_images/pool_101.png', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/one_zero_one_logo.png', NULL, 2),
  ('201 Pool', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/dashboard_images/pool_201.png', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/two_zero_one_pool.png', NULL, 3),
  ('Deals', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/dashboard_images/deal.png', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/deals_logo.png', NULL, 4),
  ('Spin & Go', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/dashboard_images/spin_go.png', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/spin_go_logo.png', NULL, 5),
  ('Practice', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/dashboard_images/practice.png', 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/practice_logo.png', NULL, 6);

-- Seed sample contests for Points (player counts 2, 3, 4, 6)
DO $$
DECLARE
  points_id INT;
  pool_101_id INT;
  c_id INT;
BEGIN
  SELECT id INTO points_id FROM games WHERE name = 'Points' LIMIT 1;
  SELECT id INTO pool_101_id FROM games WHERE name = '101 Pool' LIMIT 1;

  -- Points game contests
  IF points_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '234', '20', '300', 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '123', '40', '500', 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 4);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 3, '234', '20', '300', 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 3);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 4, '123', '40', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 4);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 6, '234', '20', '300', 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  -- 101 Pool game contests
  IF pool_101_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 2, NULL, '20', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 3, NULL, '20', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 3);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 6, NULL, '20', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;
END $$;

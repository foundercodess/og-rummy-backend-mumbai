-- Seed sample games (only if empty)
INSERT INTO games (name, dashboard_banner, side_banner, badge, sort_order)
SELECT * FROM (VALUES
  ('Points', 'https://example.com/points-banner.png', 'https://example.com/points-side.png', 'https://example.com/points-badge.png', 1),
  ('101', 'https://example.com/101-banner.png', 'https://example.com/101-side.png', 'https://example.com/101-badge.png', 2)
) AS v(name, dashboard_banner, side_banner, badge, sort_order)
WHERE (SELECT COUNT(*) FROM games) = 0;

-- Get game IDs and insert contests (PostgreSQL doesn't support ON CONFLICT for multi-table, so we use a safe pattern)
DO $$
DECLARE
  points_id INT;
  game_101_id INT;
  c_id INT;
BEGIN
  SELECT id INTO points_id FROM games WHERE name = 'Points' LIMIT 1;
  SELECT id INTO game_101_id FROM games WHERE name = '101' LIMIT 1;

  IF points_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contests WHERE game_id = points_id LIMIT 1) THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '234', '20', '300', 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '123', '40', '500', 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 4);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '567', '60', '300', 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 4, '123', '40', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 4);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 6, '234', '20', '300', 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  IF game_101_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contests WHERE game_id = game_101_id LIMIT 1) THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (game_101_id, 2, NULL, '20', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (game_101_id, 2, NULL, '40', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (game_101_id, 2, NULL, '60', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (game_101_id, 6, NULL, '20', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;
END $$;

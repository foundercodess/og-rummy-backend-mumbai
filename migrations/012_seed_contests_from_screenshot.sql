-- Replace contests with data matching app screenshots
TRUNCATE contests CASCADE;

-- Points: Point Value + Min Entry (2 & 6 players)
-- 101 Pool: Entry Fee only (2 & 6 players)
-- 201 Pool, Deals, Spin & Go, Practice: similar structure
DO $$
DECLARE
  points_id INT;
  pool_101_id INT;
  pool_201_id INT;
  deals_id INT;
  spin_go_id INT;
  practice_id INT;
  c_id INT;
BEGIN
  SELECT id INTO points_id FROM games WHERE name = 'Points' LIMIT 1;
  SELECT id INTO pool_101_id FROM games WHERE name = '101 Pool' LIMIT 1;
  SELECT id INTO pool_201_id FROM games WHERE name = '201 Pool' LIMIT 1;
  SELECT id INTO deals_id FROM games WHERE name = 'Deals' LIMIT 1;
  SELECT id INTO spin_go_id FROM games WHERE name = 'Spin & Go' LIMIT 1;
  SELECT id INTO practice_id FROM games WHERE name = 'Practice' LIMIT 1;

  -- ========== POINTS (screenshot: ₹0.05/4, ₹0.2/16, ₹1/80, ₹2/160, ₹5/400) ==========
  IF points_id IS NOT NULL THEN
    -- 2 players
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '0.05', '4', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '0.2', '16', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '1', '80', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '2', '160', NULL, 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 2, '5', '400', NULL, 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    -- 6 players (same point/entry tiers)
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 6, '0.05', '4', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 6, '0.2', '16', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 6, '1', '80', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 6, '2', '160', NULL, 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (points_id, 6, '5', '400', NULL, 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  -- ========== 101 POOL (screenshot: Entry ₹1, ₹5, ₹10, ₹25, ₹50) ==========
  IF pool_101_id IS NOT NULL THEN
    -- 2 players
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 2, NULL, '1', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 2, NULL, '5', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 2, NULL, '10', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 2, NULL, '25', NULL, 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 2, NULL, '50', NULL, 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    -- 6 players
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 6, NULL, '1', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 6, NULL, '5', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 6, NULL, '10', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 6, NULL, '25', NULL, 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_101_id, 6, NULL, '50', NULL, 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  -- ========== 201 POOL (screenshot: Entry ₹1, ₹5, ₹10, ₹25, ₹50) ==========
  IF pool_201_id IS NOT NULL THEN
    -- 2 players
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 2, NULL, '1', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 2, NULL, '5', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 2, NULL, '10', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 2, NULL, '25', NULL, 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 2, NULL, '50', NULL, 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    -- 6 players
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 6, NULL, '1', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 6, NULL, '5', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 6, NULL, '10', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 6, NULL, '25', NULL, 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (pool_201_id, 6, NULL, '50', NULL, 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  -- ========== DEALS (screenshot: Entry ₹1, ₹5, ₹10, ₹25, ₹50) ==========
  IF deals_id IS NOT NULL THEN
    -- 2 players
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 2, NULL, '1', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 2, NULL, '5', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 2, NULL, '10', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 2, NULL, '25', NULL, 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 2, NULL, '50', NULL, 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    -- 6 players
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 6, NULL, '1', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 6, NULL, '5', NULL, 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 6, NULL, '10', NULL, 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 6, NULL, '25', NULL, 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (deals_id, 6, NULL, '50', NULL, 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  -- ========== SPIN & GO (screenshot: 3 players, Entry/Win ₹10/100, ₹50/500, ₹100/1000, ₹500/5000, ₹1000/10000) ==========
  IF spin_go_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (spin_go_id, 3, NULL, '10', '100', 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (spin_go_id, 3, NULL, '50', '500', 2)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (spin_go_id, 3, NULL, '100', '1000', 3)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (spin_go_id, 3, NULL, '500', '5000', 4)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (spin_go_id, 3, NULL, '1000', '10000', 5)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 3);
  END IF;

  -- ========== PRACTICE (free entry) ==========
  IF practice_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (practice_id, 2, NULL, '0', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES
      (practice_id, 6, NULL, '0', NULL, 1)
    RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;
END $$;

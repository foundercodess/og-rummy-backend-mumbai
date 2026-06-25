-- Replace all contests with client-provided requirements per game.
-- Points: 14 tiers (2 and 6 players each). 201/101 Pool: same 19 entry fees, 2 and 6 players.
-- Deals: 2 players only. Spin & Go: 3 players only. 101 Pool = same data as 201 Pool.
TRUNCATE contests CASCADE;

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

  -- POINT RUMMY (Points): 14 tiers; each for 2 and 6 players (client: 0.05->4 through 1250->100000)
  IF points_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '0.05', '4', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '0.05', '4', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '0.2', '16', NULL, 2) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '0.2', '16', NULL, 2) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '1', '80', NULL, 3) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '1', '80', NULL, 3) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '2', '160', NULL, 4) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '2', '160', NULL, 4) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '5', '400', NULL, 5) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '5', '400', NULL, 5) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '10', '800', NULL, 6) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '10', '800', NULL, 6) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '20', '1600', NULL, 7) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '20', '1600', NULL, 7) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '40', '3200', NULL, 8) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '40', '3200', NULL, 8) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '80', '6400', NULL, 9) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '80', '6400', NULL, 9) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '125', '10000', NULL, 10) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '125', '10000', NULL, 10) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '250', '20000', NULL, 11) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '250', '20000', NULL, 11) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '500', '40000', NULL, 12) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '500', '40000', NULL, 12) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '625', '50000', NULL, 13) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '625', '50000', NULL, 13) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 2, '1250', '100000', NULL, 14) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (points_id, 6, '1250', '100000', NULL, 14) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  -- 201 POOL: 19 entry fees; 2 and 6 players each (client: 1,5,10,25,...,100000)
  IF pool_201_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '1', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '1', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '5', NULL, 2) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '5', NULL, 2) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '10', NULL, 3) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '10', NULL, 3) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '25', NULL, 4) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '25', NULL, 4) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '50', NULL, 5) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '50', NULL, 5) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '100', NULL, 6) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '100', NULL, 6) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '200', NULL, 7) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '200', NULL, 7) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '250', NULL, 8) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '250', NULL, 8) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '500', NULL, 9) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '500', NULL, 9) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '1000', NULL, 10) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '1000', NULL, 10) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '2000', NULL, 11) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '2000', NULL, 11) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '3000', NULL, 12) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '3000', NULL, 12) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '5000', NULL, 13) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '5000', NULL, 13) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '10000', NULL, 14) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '10000', NULL, 14) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '15000', NULL, 15) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '15000', NULL, 15) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '20000', NULL, 16) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '20000', NULL, 16) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '25000', NULL, 17) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '25000', NULL, 17) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '50000', NULL, 18) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '50000', NULL, 18) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);

    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 2, NULL, '100000', NULL, 19) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_201_id, 6, NULL, '100000', NULL, 19) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  -- 101 POOL: same data as 201 Pool (19 entry fees; 2 and 6 players each)
  IF pool_101_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '1', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '1', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '5', NULL, 2) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '5', NULL, 2) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '10', NULL, 3) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '10', NULL, 3) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '25', NULL, 4) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '25', NULL, 4) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '50', NULL, 5) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '50', NULL, 5) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '100', NULL, 6) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '100', NULL, 6) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '200', NULL, 7) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '200', NULL, 7) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '250', NULL, 8) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '250', NULL, 8) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '500', NULL, 9) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '500', NULL, 9) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '1000', NULL, 10) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '1000', NULL, 10) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '2000', NULL, 11) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '2000', NULL, 11) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '3000', NULL, 12) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '3000', NULL, 12) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '5000', NULL, 13) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '5000', NULL, 13) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '10000', NULL, 14) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '10000', NULL, 14) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '15000', NULL, 15) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '15000', NULL, 15) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '20000', NULL, 16) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '20000', NULL, 16) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '25000', NULL, 17) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '25000', NULL, 17) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '50000', NULL, 18) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '50000', NULL, 18) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 2, NULL, '100000', NULL, 19) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (pool_101_id, 6, NULL, '100000', NULL, 19) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;

  -- DEAL RUMMY (Deals): 2 players only. 19 entry fees (5 through 100000)
  IF deals_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '5', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '10', NULL, 2) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '25', NULL, 3) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '50', NULL, 4) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '100', NULL, 5) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '200', NULL, 6) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '250', NULL, 7) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '500', NULL, 8) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '1000', NULL, 9) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '2000', NULL, 10) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '3000', NULL, 11) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '4000', NULL, 12) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '5000', NULL, 13) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '10000', NULL, 14) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '15000', NULL, 15) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '20000', NULL, 16) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '25000', NULL, 17) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '50000', NULL, 18) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (deals_id, 2, NULL, '100000', NULL, 19) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2);
  END IF;

  -- SPIN & GO: 3 players only. 8 tiers (entry/win_upto): 10/100, 50/500, ..., 10000/100000
  IF spin_go_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (spin_go_id, 3, NULL, '10', '100', 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (spin_go_id, 3, NULL, '50', '500', 2) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (spin_go_id, 3, NULL, '100', '1000', 3) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (spin_go_id, 3, NULL, '500', '5000', 4) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (spin_go_id, 3, NULL, '1000', '10000', 5) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (spin_go_id, 3, NULL, '2000', '20000', 6) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (spin_go_id, 3, NULL, '5000', '50000', 7) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 3);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (spin_go_id, 3, NULL, '10000', '100000', 8) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 3);
  END IF;

  -- PRACTICE: free entry for 2 and 6 players
  IF practice_id IS NOT NULL THEN
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (practice_id, 2, NULL, '0', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
    INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order) VALUES (practice_id, 6, NULL, '0', NULL, 1) RETURNING id INTO c_id;
    INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, 2), (c_id, 6);
  END IF;
END $$;

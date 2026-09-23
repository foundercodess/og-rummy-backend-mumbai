-- Teen Patti Phase 0: isolate catalog from rummy via game_family, seed lobby tile + boot contests.
-- Joins require TEENPATTI_ENGINE_ENABLED=true (docker-compose defaults this on).

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS game_family VARCHAR(32) NOT NULL DEFAULT 'rummy';

UPDATE games
SET game_family = 'rummy'
WHERE game_family IS NULL OR btrim(game_family) = '';

UPDATE games
SET game_family = 'teenpatti'
WHERE lower(name) IN ('teen patti', 'teenpatti');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_games_game_family'
  ) THEN
    ALTER TABLE games
      ADD CONSTRAINT chk_games_game_family
      CHECK (game_family IN ('rummy', 'teenpatti'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_games_family ON games(game_family);

COMMENT ON COLUMN games.game_family IS
  'Engine family: rummy | teenpatti. Toggle games.active to hide one family without stopping the other.';

-- Allow 5-max Teen Patti tables. Existing rummy rows stay on 2/3/4/6.
ALTER TABLE contests DROP CONSTRAINT IF EXISTS chk_player_count;
ALTER TABLE contests ADD CONSTRAINT chk_player_count CHECK (player_count IN (2, 3, 4, 5, 6));

ALTER TABLE contest_play_types DROP CONSTRAINT IF EXISTS chk_play_type;
ALTER TABLE contest_play_types ADD CONSTRAINT chk_play_type CHECK (play_type IN (2, 3, 4, 5, 6));

INSERT INTO games (
  name,
  dashboard_banner,
  side_banner,
  badge,
  sort_order,
  game_family,
  active
)
SELECT
  'Teen Patti',
  'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQPL_GOc9wAR9BqRL2LXtC50DzI3ECcYxViF29MgClAzA&s=10',
  'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQgt_uGr05XGNz8zokicWI2BgXMUZSThYQ6DkDyHpKiYw&s=10',
  NULL,
  7,
  'teenpatti',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM games WHERE lower(name) IN ('teen patti', 'teenpatti')
);

DO $$
DECLARE
  teen_patti_id INT;
  c_id INT;
  boot TEXT;
  pot TEXT;
  sort_i INT;
  boots TEXT[] := ARRAY['10', '20', '50', '100', '200', '500'];
  pots TEXT[] := ARRAY['1280', '2560', '6400', '12800', '25600', '64000'];
  player_counts INT[] := ARRAY[2, 5];
  pc INT;
BEGIN
  SELECT id INTO teen_patti_id FROM games WHERE lower(name) IN ('teen patti', 'teenpatti') LIMIT 1;
  IF teen_patti_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM contests WHERE game_id = teen_patti_id LIMIT 1) THEN
    RETURN;
  END IF;

  FOREACH pc IN ARRAY player_counts LOOP
    FOR sort_i IN 1..array_length(boots, 1) LOOP
      boot := boots[sort_i];
      pot := pots[sort_i];
      INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order, active)
      VALUES (teen_patti_id, pc, NULL, boot, pot, sort_i, true)
      RETURNING id INTO c_id;
      INSERT INTO contest_play_types (contest_id, play_type) VALUES (c_id, pc);
    END LOOP;
  END LOOP;
END $$;

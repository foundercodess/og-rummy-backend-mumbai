-- Dragon Tiger: add 2000 / 5000 / 10000 chips (table chip strip scrolls past 5).
-- Only tables still on the original default are changed; admin-edited chip lists stay as they are.

ALTER TABLE dt_settings
  ALTER COLUMN chip_values SET DEFAULT ARRAY[10, 50, 100, 500, 1000, 2000, 5000, 10000];

UPDATE dt_settings
SET chip_values = ARRAY[10, 50, 100, 500, 1000, 2000, 5000, 10000]
WHERE chip_values = ARRAY[10, 50, 100, 500, 1000];

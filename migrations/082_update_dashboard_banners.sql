-- Practice home-tile banner, then put Teen Patti first on the dashboard.
-- Remaining games keep their previous relative order.

UPDATE games
SET dashboard_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rum/practice.png'
WHERE id = 8
   OR lower(btrim(name)) = 'practice';

UPDATE games
SET sort_order = 1
WHERE id = 9
   OR lower(btrim(name)) IN ('teen patti', 'teenpatti');

UPDATE games
SET sort_order = 2
WHERE id = 3
   OR lower(btrim(name)) = 'points';

UPDATE games
SET sort_order = 3
WHERE id = 4
   OR lower(btrim(name)) IN ('101 pool', 'pool 101', 'pool101');

UPDATE games
SET sort_order = 4
WHERE id = 5
   OR lower(btrim(name)) IN ('201 pool', 'pool 201', 'pool201');

UPDATE games
SET sort_order = 5
WHERE id = 6
   OR lower(btrim(name)) = 'deals';

UPDATE games
SET sort_order = 6
WHERE id = 7
   OR lower(btrim(name)) IN ('spin & go', 'spin and go', 'spin &go');

UPDATE games
SET sort_order = 7
WHERE id = 8
   OR lower(btrim(name)) = 'practice';

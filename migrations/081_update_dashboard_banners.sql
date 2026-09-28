-- Refresh home-tile dashboard_banner URLs (S3 /rum/*).
-- Match by id (live catalog) and name so local DBs with different serials still update.
-- Spin & Go (id 7) is skipped: no banner URL was provided (api/games is not an image).

UPDATE games
SET dashboard_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rum/points.png'
WHERE id = 3
   OR lower(btrim(name)) = 'points';

UPDATE games
SET dashboard_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rum/pool101.png'
WHERE id = 4
   OR lower(btrim(name)) IN ('101 pool', 'pool 101', 'pool101');

UPDATE games
SET dashboard_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rum/pool_201.png'
WHERE id = 5
   OR lower(btrim(name)) IN ('201 pool', 'pool 201', 'pool201');

UPDATE games
SET dashboard_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rum/deals.png'
WHERE id = 6
   OR lower(btrim(name)) = 'deals';

UPDATE games
SET dashboard_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rum/spin_go.png'
WHERE id = 7;

UPDATE games
SET dashboard_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rum/teen_patti.png'
WHERE id = 9
   OR lower(btrim(name)) IN ('teen patti', 'teenpatti');

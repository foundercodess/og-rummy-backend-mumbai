-- Update side_banner URLs and set badge to null
-- Side images: sidebar_game_images/points_logo.png, one_zero_one_logo.png, two_zero_one_pool.png, deals_logo.png, spin_go_logo.png, practice_logo.png

UPDATE games SET
  side_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/points_logo.png',
  badge = NULL
WHERE name = 'Points';

UPDATE games SET
  side_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/one_zero_one_logo.png',
  badge = NULL
WHERE name = '101 Pool';

UPDATE games SET
  side_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/two_zero_one_pool.png',
  badge = NULL
WHERE name = '201 Pool';

UPDATE games SET
  side_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/deals_logo.png',
  badge = NULL
WHERE name = 'Deals';

UPDATE games SET
  side_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/spin_go_logo.png',
  badge = NULL
WHERE name = 'Spin & Go';

UPDATE games SET
  side_banner = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.amazonaws.com/sidebar_game_images/practice_logo.png',
  badge = NULL
WHERE name = 'Practice';

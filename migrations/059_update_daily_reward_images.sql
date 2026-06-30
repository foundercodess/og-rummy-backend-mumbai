-- Update daily login reward images to S3 assets (day_1 through day_7)
UPDATE daily_reward_configs
SET image_url = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rewards/day_1.png',
    updated_at = NOW()
WHERE day_number = 1;

UPDATE daily_reward_configs
SET image_url = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rewards/day_2.png',
    updated_at = NOW()
WHERE day_number = 2;

UPDATE daily_reward_configs
SET image_url = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rewards/day_3.png',
    updated_at = NOW()
WHERE day_number = 3;

UPDATE daily_reward_configs
SET image_url = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rewards/day_4.png',
    updated_at = NOW()
WHERE day_number = 4;

UPDATE daily_reward_configs
SET image_url = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rewards/day_5.png',
    updated_at = NOW()
WHERE day_number = 5;

UPDATE daily_reward_configs
SET image_url = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rewards/day_6.png',
    updated_at = NOW()
WHERE day_number = 6;

UPDATE daily_reward_configs
SET image_url = 'https://og-rummy-assets-515105386762-us-east-1-an.s3.us-east-1.amazonaws.com/rewards/day_7.png',
    updated_at = NOW()
WHERE day_number = 7;

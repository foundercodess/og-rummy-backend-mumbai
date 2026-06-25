ALTER TABLE games
ADD COLUMN IF NOT EXISTS turn_timer_seconds INT NOT NULL DEFAULT 30,
ADD COLUMN IF NOT EXISTS bonus_timer_seconds INT NOT NULL DEFAULT 60;

UPDATE games
SET turn_timer_seconds = 30,
    bonus_timer_seconds = 60,
    updated_at = NOW()
WHERE turn_timer_seconds IS DISTINCT FROM 30
   OR bonus_timer_seconds IS DISTINCT FROM 60;

ALTER TABLE avatars
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_avatars_active_sort
  ON avatars(active, sort_order, id);

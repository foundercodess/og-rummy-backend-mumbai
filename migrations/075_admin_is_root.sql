-- Root admin protection: only the root owner may manage roles;
-- root account cannot be deactivated by anyone.

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS is_root BOOLEAN NOT NULL DEFAULT false;

-- Seed / promote known owner email first
UPDATE admins
SET is_root = true
WHERE LOWER(TRIM(email)) = 'rummy@admin'
  AND is_root = false;

-- Fallback: earliest L3 admin becomes root if none marked yet
UPDATE admins
SET is_root = true
WHERE id = (
  SELECT a.id
  FROM admins a
  INNER JOIN admin_roles r ON r.id = a.role_id
  WHERE r.code = 'L3'
  ORDER BY a.id ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM admins WHERE is_root = true);

-- Exactly one root account
CREATE UNIQUE INDEX IF NOT EXISTS uq_admins_single_root
  ON admins (is_root)
  WHERE is_root = true;

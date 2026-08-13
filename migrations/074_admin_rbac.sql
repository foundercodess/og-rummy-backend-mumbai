-- Admin RBAC: permissions, roles, role_permissions; link admins to roles.
-- Approach: L1/L2/L3 are system presets; L3 creates custom "sub-roles" with selected
-- feature permissions; many admins can share one role.

CREATE TABLE IF NOT EXISTS admin_permissions (
  id SERIAL PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  module VARCHAR(40) NOT NULL,
  action VARCHAR(20) NOT NULL,
  label VARCHAR(120) NOT NULL,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_roles (
  id SERIAL PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 3),
  is_system BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by INT NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_role_permissions (
  role_id INT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  permission_id INT NOT NULL REFERENCES admin_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_roles_level ON admin_roles (level);
CREATE INDEX IF NOT EXISTS idx_admin_roles_active ON admin_roles (active);
CREATE INDEX IF NOT EXISTS idx_admin_permissions_module ON admin_permissions (module);

-- Seed permission catalog
INSERT INTO admin_permissions (code, module, action, label, description, sort_order) VALUES
  ('dashboard.read', 'dashboard', 'read', 'Dashboard', 'Open dashboard', 10),
  ('dashboard.metrics.basic', 'dashboard', 'read', 'Basic metrics', 'Users, tables, onboarded, humans playing', 20),
  ('dashboard.metrics.bots', 'dashboard', 'read', 'Bot metrics', 'Bots playing / bot P&L tiles', 30),
  ('dashboard.metrics.earnings', 'dashboard', 'read', 'Earnings metrics', 'Combined / all-time profit tiles', 40),
  ('users.read', 'users', 'read', 'View users', 'Users list and details', 100),
  ('users.write', 'users', 'write', 'Manage users', 'Activate / deactivate users', 110),
  ('kyc.read', 'kyc', 'read', 'View KYC', 'KYC list and documents', 200),
  ('kyc.write', 'kyc', 'write', 'Manage KYC', 'Approve / reject KYC', 210),
  ('games.read', 'games', 'read', 'View games', 'Games list and session overview', 300),
  ('games.write', 'games', 'write', 'Manage games', 'Enable games, contests, bot settings', 310),
  ('games.history.read', 'games', 'read', 'Game history', 'View game history', 320),
  ('withdrawals.read', 'withdrawals', 'read', 'View withdrawals', 'Withdrawal queue and details', 400),
  ('withdrawals.write', 'withdrawals', 'write', 'Manage withdrawals', 'Settle / reject withdrawals', 410),
  ('recharges.read', 'recharges', 'read', 'View recharges', 'Wallet recharge history', 500),
  ('cashflow.read', 'cashflow', 'read', 'Cash flow', 'Cash flow page', 510),
  ('ledger.read', 'ledger', 'read', 'Admin ledger', 'Revenue ledger history', 520),
  ('support.read', 'support', 'read', 'View support', 'Support queues', 600),
  ('support.write', 'support', 'write', 'Manage support', 'Update complaint / feedback status', 610),
  ('app_settings.read', 'app_settings', 'read', 'View app settings', 'Read app / developer settings', 700),
  ('app_settings.write', 'app_settings', 'write', 'Manage app settings', 'Update settings, PG, maintenance', 710),
  ('telemetry.read', 'telemetry', 'read', 'Telemetry', 'View telemetry', 800),
  ('admins.read', 'admins', 'read', 'View admins', 'List admin accounts', 900),
  ('admins.write', 'admins', 'write', 'Manage admins', 'Create / update admin accounts', 910),
  ('roles.read', 'roles', 'read', 'View roles', 'List roles and permissions', 920),
  ('roles.write', 'roles', 'write', 'Manage roles', 'Create custom roles and assign permissions', 930)
ON CONFLICT (code) DO NOTHING;

-- System roles L1 / L2 / L3
INSERT INTO admin_roles (code, name, description, level, is_system, active)
VALUES
  ('L1', 'L1 · Analysis & Support', 'Analyse games and support complaints; KYC; no withdrawals or earnings.', 1, true, true),
  ('L2', 'L2 · Operations', 'Ops access: games control, withdrawals, app settings; limited metrics.', 2, true, true),
  ('L3', 'L3 · Owner', 'Full access including admin/role management and all financial metrics.', 3, true, true)
ON CONFLICT (code) DO NOTHING;

-- L1 permissions
INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE r.code = 'L1'
  AND p.code IN (
    'dashboard.read', 'dashboard.metrics.basic',
    'users.read',
    'kyc.read', 'kyc.write',
    'games.read', 'games.history.read',
    'support.read', 'support.write'
  )
ON CONFLICT DO NOTHING;

-- L2 permissions
INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE r.code = 'L2'
  AND p.code IN (
    'dashboard.read', 'dashboard.metrics.basic', 'dashboard.metrics.bots',
    'users.read', 'users.write',
    'kyc.read', 'kyc.write',
    'games.read', 'games.write', 'games.history.read',
    'withdrawals.read', 'withdrawals.write',
    'recharges.read', 'cashflow.read',
    'support.read', 'support.write',
    'app_settings.read', 'app_settings.write',
    'telemetry.read'
  )
ON CONFLICT DO NOTHING;

-- L3 = all permissions
INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE r.code = 'L3'
ON CONFLICT DO NOTHING;

-- Link admins to roles (keep legacy role column in sync for JWT)
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS role_id INT NULL REFERENCES admin_roles(id) ON DELETE RESTRICT;

ALTER TABLE admins DROP CONSTRAINT IF EXISTS chk_admin_role;

UPDATE admins a
SET role_id = r.id,
    role = r.code
FROM admin_roles r
WHERE a.role_id IS NULL
  AND (
    (LOWER(a.role) IN ('super_admin', 'l3') AND r.code = 'L3')
    OR (LOWER(a.role) IN ('admin', 'l2') AND r.code = 'L2')
    OR (LOWER(a.role) = 'l1' AND r.code = 'L1')
  );

-- Default remaining unmapped admins to L3 (existing backoffice operators)
UPDATE admins a
SET role_id = r.id,
    role = r.code
FROM admin_roles r
WHERE a.role_id IS NULL
  AND r.code = 'L3';

ALTER TABLE admins
  ALTER COLUMN role_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admins_role_id ON admins (role_id);

ALTER TABLE admins
  ADD CONSTRAINT chk_admin_role_code
  CHECK (char_length(TRIM(role)) > 0);

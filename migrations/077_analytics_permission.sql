-- Analytics page access. Chart sections still respect dashboard.metrics.* / cashflow.read.
INSERT INTO admin_permissions (code, module, action, label, description, sort_order) VALUES
  ('analytics.read', 'analytics', 'read', 'Analytics', 'Open charts & analytics with date ranges', 50)
ON CONFLICT (code) DO NOTHING;

-- Any role that can open Dashboard also gets Analytics (charts still gated by metrics perms).
INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE p.code = 'analytics.read'
  AND EXISTS (
    SELECT 1
    FROM admin_role_permissions rp
    INNER JOIN admin_permissions dp ON dp.id = rp.permission_id
    WHERE rp.role_id = r.id
      AND dp.code = 'dashboard.read'
  )
ON CONFLICT DO NOTHING;

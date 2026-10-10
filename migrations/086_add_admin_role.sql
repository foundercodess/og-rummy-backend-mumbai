INSERT INTO admins (email, password_hash, password_salt, role, role_id, active)
SELECT
  'allplaycards@admin',
  'ed93ee9dcbd9f5c1656f6d7ca31e18716a22d9280b489d4e6fd5ae29695e52c1e2def1d78de39221b3fdc9e24643db2bf54905f059716922753b4f8b92536fd3',
  '9766e7c735e27694d4eb5c839564bd19',
  r.code,
  r.id,
  true
FROM admin_roles r
WHERE r.code = 'L3'
ON CONFLICT (email) DO NOTHING;

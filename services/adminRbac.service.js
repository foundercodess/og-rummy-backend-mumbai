'use strict';

/**
 * Admin RBAC helpers.
 * Roles (L1/L2/L3 + custom) map to permission codes. Many admins share one role.
 */

const crypto = require('crypto');
const { query } = require('../db');

function hashPassword(plainPassword, salt) {
  // Must match auth.service.js (scrypt) so created admins can log in.
  return crypto.scryptSync(String(plainPassword || ''), String(salt || ''), 64).toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/** Permissions that only the root owner may use / grant. */
const ROOT_ONLY_PERMISSIONS = new Set(['roles.write']);

function assertActorIsRoot(actorIsRoot) {
  if (!actorIsRoot) {
    const err = new Error('ROOT_ONLY');
    err.code = 'ROOT_ONLY';
    throw err;
  }
}

function sanitizePermissionCodes(permissionCodes, { allowRootOnly = false } = {}) {
  const requested = Array.isArray(permissionCodes)
    ? [...new Set(permissionCodes.map((c) => String(c || '').trim()).filter(Boolean))]
    : [];
  if (!allowRootOnly) {
    return requested.filter((code) => !ROOT_ONLY_PERMISSIONS.has(code));
  }
  return requested;
}

async function getPermissionsForRoleId(roleId) {
  const rid = Number(roleId);
  if (!Number.isInteger(rid) || rid <= 0) return [];
  const result = await query(
    `SELECT p.code
     FROM admin_role_permissions rp
     INNER JOIN admin_permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1
     ORDER BY p.sort_order ASC, p.code ASC`,
    [rid]
  );
  return (result.rows || []).map((row) => row.code);
}

async function getAdminAuthContext(adminId) {
  const uid = Number(adminId);
  if (!Number.isInteger(uid) || uid <= 0) return null;

  const result = await query(
    `SELECT
       a.id,
       a.email,
       a.active,
       a.role AS role_code,
       a.role_id,
       COALESCE(a.is_root, false) AS is_root,
       r.code AS role_code_resolved,
       r.name AS role_name,
       r.level AS role_level,
       r.is_system AS role_is_system,
       r.active AS role_active
     FROM admins a
     INNER JOIN admin_roles r ON r.id = a.role_id
     WHERE a.id = $1`,
    [uid]
  );

  const row = result.rows[0];
  if (!row) return null;

  const permissions = await getPermissionsForRoleId(row.role_id);
  return {
    id: row.id,
    email: row.email,
    active: row.active !== false,
    is_root: row.is_root === true,
    role: {
      id: row.role_id,
      code: row.role_code_resolved || row.role_code,
      name: row.role_name,
      level: Number(row.role_level) || 1,
      is_system: row.role_is_system === true,
      active: row.role_active !== false,
    },
    permissions,
  };
}

function hasPermission(permissionSet, code) {
  if (!code) return true;
  const set = permissionSet instanceof Set ? permissionSet : new Set(permissionSet || []);
  return set.has(String(code));
}

function hasAnyPermission(permissionSet, codes = []) {
  const list = Array.isArray(codes) ? codes : [codes];
  if (!list.length) return true;
  return list.some((code) => hasPermission(permissionSet, code));
}

async function listPermissionsCatalog() {
  const result = await query(
    `SELECT id, code, module, action, label, description, sort_order
     FROM admin_permissions
     ORDER BY sort_order ASC, code ASC`
  );
  return result.rows || [];
}

async function listRoles({ includeInactive = false } = {}) {
  const result = await query(
    `SELECT
       r.id,
       r.code,
       r.name,
       r.description,
       r.level,
       r.is_system,
       r.active,
       r.created_at,
       r.updated_at,
       COUNT(DISTINCT a.id)::int AS admin_count,
       COALESCE(
         ARRAY_AGG(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL),
         '{}'
       ) AS permissions
     FROM admin_roles r
     LEFT JOIN admins a ON a.role_id = r.id
     LEFT JOIN admin_role_permissions rp ON rp.role_id = r.id
     LEFT JOIN admin_permissions p ON p.id = rp.permission_id
     WHERE ($1::boolean = true OR r.active = true)
     GROUP BY r.id
     ORDER BY r.level DESC, r.is_system DESC, r.name ASC`,
    [includeInactive === true]
  );
  return (result.rows || []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    level: Number(row.level) || 1,
    is_system: row.is_system === true,
    active: row.active !== false,
    admin_count: Number(row.admin_count) || 0,
    permissions: Array.isArray(row.permissions) ? row.permissions.filter(Boolean).sort() : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

async function getRoleById(roleId) {
  const rid = Number(roleId);
  if (!Number.isInteger(rid) || rid <= 0) return null;
  const roles = await listRoles({ includeInactive: true });
  return roles.find((role) => role.id === rid) || null;
}

function normalizeRoleCode(raw, fallbackName) {
  const base = String(raw || fallbackName || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) return null;
  if (['L1', 'L2', 'L3'].includes(base)) return null;
  return base.slice(0, 64);
}

async function createCustomRole({
  name,
  description,
  level,
  permissionCodes,
  createdByAdminId,
  actorLevel,
  actorPermissions,
  actorIsRoot,
}) {
  assertActorIsRoot(actorIsRoot);

  const roleName = String(name || '').trim();
  if (!roleName) {
    const err = new Error('ROLE_NAME_REQUIRED');
    err.code = 'ROLE_NAME_REQUIRED';
    throw err;
  }

  const roleLevel = Number(level);
  if (![1, 2, 3].includes(roleLevel)) {
    const err = new Error('INVALID_ROLE_LEVEL');
    err.code = 'INVALID_ROLE_LEVEL';
    throw err;
  }
  if (roleLevel > Number(actorLevel || 0)) {
    const err = new Error('ROLE_LEVEL_FORBIDDEN');
    err.code = 'ROLE_LEVEL_FORBIDDEN';
    throw err;
  }

  const requested = sanitizePermissionCodes(permissionCodes, { allowRootOnly: false });
  if (!requested.length) {
    const err = new Error('PERMISSIONS_REQUIRED');
    err.code = 'PERMISSIONS_REQUIRED';
    throw err;
  }

  const actorSet = new Set(actorPermissions || []);
  for (const code of requested) {
    if (!actorSet.has(code)) {
      const err = new Error('PERMISSION_GRANT_FORBIDDEN');
      err.code = 'PERMISSION_GRANT_FORBIDDEN';
      err.permission = code;
      throw err;
    }
  }

  const code = normalizeRoleCode(roleName);
  if (!code) {
    const err = new Error('INVALID_ROLE_CODE');
    err.code = 'INVALID_ROLE_CODE';
    throw err;
  }

  const permRes = await query(
    `SELECT id, code FROM admin_permissions WHERE code = ANY($1::text[])`,
    [requested]
  );
  if (permRes.rows.length !== requested.length) {
    const err = new Error('UNKNOWN_PERMISSION');
    err.code = 'UNKNOWN_PERMISSION';
    throw err;
  }

  let role;
  try {
    const insert = await query(
      `INSERT INTO admin_roles (code, name, description, level, is_system, active, created_by)
       VALUES ($1, $2, $3, $4, false, true, $5)
       RETURNING id`,
      [code, roleName, description || null, roleLevel, createdByAdminId || null]
    );
    role = insert.rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      const conflict = new Error('ROLE_CODE_EXISTS');
      conflict.code = 'ROLE_CODE_EXISTS';
      throw conflict;
    }
    throw err;
  }

  const values = [];
  const params = [role.id];
  permRes.rows.forEach((row, idx) => {
    params.push(row.id);
    values.push(`($1, $${idx + 2})`);
  });
  await query(
    `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ${values.join(', ')}
     ON CONFLICT DO NOTHING`,
    params
  );

  return getRoleById(role.id);
}

async function updateCustomRole({
  roleId,
  name,
  description,
  active,
  permissionCodes,
  actorLevel,
  actorPermissions,
  actorIsRoot,
}) {
  assertActorIsRoot(actorIsRoot);

  const existing = await getRoleById(roleId);
  if (!existing) {
    const err = new Error('ROLE_NOT_FOUND');
    err.code = 'ROLE_NOT_FOUND';
    throw err;
  }
  if (existing.is_system) {
    const err = new Error('SYSTEM_ROLE_LOCKED');
    err.code = 'SYSTEM_ROLE_LOCKED';
    throw err;
  }
  if (existing.level > Number(actorLevel || 0)) {
    const err = new Error('ROLE_LEVEL_FORBIDDEN');
    err.code = 'ROLE_LEVEL_FORBIDDEN';
    throw err;
  }

  const updates = ['updated_at = NOW()'];
  const params = [];
  let i = 1;

  if (name != null) {
    const roleName = String(name).trim();
    if (!roleName) {
      const err = new Error('ROLE_NAME_REQUIRED');
      err.code = 'ROLE_NAME_REQUIRED';
      throw err;
    }
    updates.push(`name = $${i++}`);
    params.push(roleName);
  }
  if (description !== undefined) {
    updates.push(`description = $${i++}`);
    params.push(description ? String(description) : null);
  }
  if (active !== undefined && active !== null) {
    updates.push(`active = $${i++}`);
    params.push(Boolean(active));
  }

  params.push(existing.id);
  await query(`UPDATE admin_roles SET ${updates.join(', ')} WHERE id = $${i}`, params);

  if (Array.isArray(permissionCodes)) {
    const requested = sanitizePermissionCodes(permissionCodes, { allowRootOnly: false });
    if (!requested.length) {
      const err = new Error('PERMISSIONS_REQUIRED');
      err.code = 'PERMISSIONS_REQUIRED';
      throw err;
    }
    const actorSet = new Set(actorPermissions || []);
    for (const code of requested) {
      if (!actorSet.has(code)) {
        const err = new Error('PERMISSION_GRANT_FORBIDDEN');
        err.code = 'PERMISSION_GRANT_FORBIDDEN';
        err.permission = code;
        throw err;
      }
    }
    const permRes = await query(
      `SELECT id, code FROM admin_permissions WHERE code = ANY($1::text[])`,
      [requested]
    );
    if (permRes.rows.length !== requested.length) {
      const err = new Error('UNKNOWN_PERMISSION');
      err.code = 'UNKNOWN_PERMISSION';
      throw err;
    }
    await query(`DELETE FROM admin_role_permissions WHERE role_id = $1`, [existing.id]);
    const values = [];
    const insertParams = [existing.id];
    permRes.rows.forEach((row, idx) => {
      insertParams.push(row.id);
      values.push(`($1, $${idx + 2})`);
    });
    await query(
      `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ${values.join(', ')}`,
      insertParams
    );
  }

  return getRoleById(existing.id);
}

async function listAdmins() {
  const result = await query(
    `SELECT
       a.id,
       a.email,
       a.active,
       COALESCE(a.is_root, false) AS is_root,
       a.created_at,
       a.updated_at,
       r.id AS role_id,
       r.code AS role_code,
       r.name AS role_name,
       r.level AS role_level,
       r.is_system AS role_is_system
     FROM admins a
     INNER JOIN admin_roles r ON r.id = a.role_id
     ORDER BY a.is_root DESC, r.level DESC, a.email ASC`
  );
  return (result.rows || []).map((row) => ({
    id: row.id,
    email: row.email,
    active: row.active !== false,
    is_root: row.is_root === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
    role: {
      id: row.role_id,
      code: row.role_code,
      name: row.role_name,
      level: Number(row.role_level) || 1,
      is_system: row.role_is_system === true,
    },
  }));
}

async function createAdmin({ email, password, roleId, actorLevel, actorAdminId }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    const err = new Error('INVALID_EMAIL');
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  const plain = String(password || '');
  if (plain.length < 8) {
    const err = new Error('WEAK_PASSWORD');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }

  const role = await getRoleById(roleId);
  if (!role || !role.active) {
    const err = new Error('ROLE_NOT_FOUND');
    err.code = 'ROLE_NOT_FOUND';
    throw err;
  }
  if (role.level > Number(actorLevel || 0)) {
    const err = new Error('ROLE_LEVEL_FORBIDDEN');
    err.code = 'ROLE_LEVEL_FORBIDDEN';
    throw err;
  }

  const salt = makeSalt();
  const passwordHash = hashPassword(plain, salt);

  try {
    const result = await query(
      `INSERT INTO admins (email, password_hash, password_salt, role, role_id, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, email, active, created_at, updated_at, role_id`,
      [normalizedEmail, passwordHash, salt, role.code, role.id]
    );
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      active: true,
      created_at: row.created_at,
      updated_at: row.updated_at,
      role: {
        id: role.id,
        code: role.code,
        name: role.name,
        level: role.level,
        is_system: role.is_system,
      },
      created_by: actorAdminId || null,
    };
  } catch (err) {
    if (err && err.code === '23505') {
      const conflict = new Error('EMAIL_EXISTS');
      conflict.code = 'EMAIL_EXISTS';
      throw conflict;
    }
    throw err;
  }
}

async function updateAdmin({
  adminId,
  roleId,
  active,
  password,
  actorLevel,
  actorAdminId,
  actorIsRoot,
}) {
  const targetId = Number(adminId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    const err = new Error('ADMIN_NOT_FOUND');
    err.code = 'ADMIN_NOT_FOUND';
    throw err;
  }

  const existingRes = await query(
    `SELECT
       a.id,
       a.email,
       a.active,
       a.role_id,
       COALESCE(a.is_root, false) AS is_root,
       r.level AS role_level,
       r.code AS role_code
     FROM admins a
     INNER JOIN admin_roles r ON r.id = a.role_id
     WHERE a.id = $1`,
    [targetId]
  );
  const existing = existingRes.rows[0];
  if (!existing) {
    const err = new Error('ADMIN_NOT_FOUND');
    err.code = 'ADMIN_NOT_FOUND';
    throw err;
  }

  if (existing.is_root === true) {
    // Only the root owner may touch the root account (typically themselves).
    if (!actorIsRoot) {
      const err = new Error('ROOT_ADMIN_LOCKED');
      err.code = 'ROOT_ADMIN_LOCKED';
      throw err;
    }
    if (active === false) {
      const err = new Error('CANNOT_DISABLE_ROOT');
      err.code = 'CANNOT_DISABLE_ROOT';
      throw err;
    }
  }

  if (Number(existing.role_level) > Number(actorLevel || 0)) {
    const err = new Error('ROLE_LEVEL_FORBIDDEN');
    err.code = 'ROLE_LEVEL_FORBIDDEN';
    throw err;
  }

  const updates = ['updated_at = NOW()'];
  const params = [];
  let i = 1;

  if (roleId != null) {
    if (existing.is_root === true) {
      const role = await getRoleById(roleId);
      if (!role || role.code !== 'L3') {
        const err = new Error('CANNOT_CHANGE_ROOT_ROLE');
        err.code = 'CANNOT_CHANGE_ROOT_ROLE';
        throw err;
      }
    }
    const role = await getRoleById(roleId);
    if (!role || !role.active) {
      const err = new Error('ROLE_NOT_FOUND');
      err.code = 'ROLE_NOT_FOUND';
      throw err;
    }
    if (role.level > Number(actorLevel || 0)) {
      const err = new Error('ROLE_LEVEL_FORBIDDEN');
      err.code = 'ROLE_LEVEL_FORBIDDEN';
      throw err;
    }
    updates.push(`role_id = $${i++}`);
    params.push(role.id);
    updates.push(`role = $${i++}`);
    params.push(role.code);
  }

  if (active !== undefined && active !== null) {
    if (Number(actorAdminId) === targetId && active === false) {
      const err = new Error('CANNOT_DISABLE_SELF');
      err.code = 'CANNOT_DISABLE_SELF';
      throw err;
    }
    if (existing.is_root === true && active === false) {
      const err = new Error('CANNOT_DISABLE_ROOT');
      err.code = 'CANNOT_DISABLE_ROOT';
      throw err;
    }
    updates.push(`active = $${i++}`);
    params.push(Boolean(active));
  }

  if (password != null && String(password).length > 0) {
    if (String(password).length < 8) {
      const err = new Error('WEAK_PASSWORD');
      err.code = 'WEAK_PASSWORD';
      throw err;
    }
    const salt = makeSalt();
    const passwordHash = hashPassword(String(password), salt);
    updates.push(`password_salt = $${i++}`);
    params.push(salt);
    updates.push(`password_hash = $${i++}`);
    params.push(passwordHash);
  }

  params.push(targetId);
  await query(`UPDATE admins SET ${updates.join(', ')} WHERE id = $${i}`, params);

  const list = await listAdmins();
  return list.find((row) => row.id === targetId) || null;
}

module.exports = {
  getPermissionsForRoleId,
  getAdminAuthContext,
  hasPermission,
  hasAnyPermission,
  listPermissionsCatalog,
  listRoles,
  getRoleById,
  createCustomRole,
  updateCustomRole,
  listAdmins,
  createAdmin,
  updateAdmin,
  ROOT_ONLY_PERMISSIONS,
};

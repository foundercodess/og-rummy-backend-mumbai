'use strict';

const adminRbacService = require('../services/adminRbac.service');

function actorFromReq(req) {
  const admin = req.admin || {};
  return {
    adminId: admin.id,
    level: admin.role?.level || 0,
    permissions: admin.permissions || [],
    isRoot: admin.is_root === true,
  };
}

function mapRoleError(err, res) {
  const code = err?.code || err?.message;
  const map = {
    ROLE_NAME_REQUIRED: [400, 'Role name is required'],
    INVALID_ROLE_LEVEL: [400, 'Role level must be 1, 2, or 3'],
    ROLE_LEVEL_FORBIDDEN: [403, 'Cannot manage a role at or above your level'],
    PERMISSIONS_REQUIRED: [400, 'Select at least one permission'],
    PERMISSION_GRANT_FORBIDDEN: [403, `Cannot grant permission: ${err.permission || ''}`],
    INVALID_ROLE_CODE: [400, 'Invalid role name/code'],
    UNKNOWN_PERMISSION: [400, 'One or more permissions are unknown'],
    ROLE_CODE_EXISTS: [409, 'A role with this name already exists'],
    ROLE_NOT_FOUND: [404, 'Role not found'],
    SYSTEM_ROLE_LOCKED: [403, 'System roles (L1/L2/L3) cannot be edited'],
    INVALID_EMAIL: [400, 'Valid email is required'],
    WEAK_PASSWORD: [400, 'Password must be at least 8 characters'],
    EMAIL_EXISTS: [409, 'An admin with this email already exists'],
    ADMIN_NOT_FOUND: [404, 'Admin not found'],
    CANNOT_DISABLE_SELF: [400, 'You cannot disable your own account'],
    CANNOT_DISABLE_ROOT: [403, 'Root owner account cannot be deactivated'],
    CANNOT_CHANGE_ROOT_ROLE: [403, 'Root owner must remain on L3'],
    ROOT_ADMIN_LOCKED: [403, 'Only the root owner can manage the root account'],
    ROOT_ONLY: [403, 'Only the root owner can create or edit roles'],
  };
  const entry = map[code];
  if (entry) {
    return res.status(entry[0]).json({ success: false, message: entry[1], code });
  }
  console.error('adminRbac error:', err);
  return res.status(500).json({ success: false, message: 'Internal server error' });
}

async function listPermissions(req, res) {
  try {
    const permissions = await adminRbacService.listPermissionsCatalog();
    const actor = actorFromReq(req);
    const filtered = actor.isRoot
      ? permissions
      : permissions.filter((p) => !adminRbacService.ROOT_ONLY_PERMISSIONS.has(p.code));
    return res.json({ success: true, permissions: filtered });
  } catch (err) {
    return mapRoleError(err, res);
  }
}

async function listRoles(req, res) {
  try {
    const includeInactive = String(req.query.include_inactive || '') === '1';
    const roles = await adminRbacService.listRoles({ includeInactive });
    return res.json({ success: true, roles });
  } catch (err) {
    return mapRoleError(err, res);
  }
}

async function createRole(req, res) {
  try {
    const actor = actorFromReq(req);
    const body = req.body || {};
    const role = await adminRbacService.createCustomRole({
      name: body.name,
      description: body.description,
      level: body.level,
      permissionCodes: body.permissions,
      createdByAdminId: actor.adminId,
      actorLevel: actor.level,
      actorPermissions: actor.permissions,
      actorIsRoot: actor.isRoot,
    });
    return res.status(201).json({ success: true, role });
  } catch (err) {
    return mapRoleError(err, res);
  }
}

async function updateRole(req, res) {
  try {
    const actor = actorFromReq(req);
    const body = req.body || {};
    const role = await adminRbacService.updateCustomRole({
      roleId: req.params.roleId,
      name: body.name,
      description: body.description,
      active: body.active,
      permissionCodes: body.permissions,
      actorLevel: actor.level,
      actorPermissions: actor.permissions,
      actorIsRoot: actor.isRoot,
    });
    return res.json({ success: true, role });
  } catch (err) {
    return mapRoleError(err, res);
  }
}

async function listAdmins(req, res) {
  try {
    const admins = await adminRbacService.listAdmins();
    return res.json({ success: true, admins });
  } catch (err) {
    return mapRoleError(err, res);
  }
}

async function createAdmin(req, res) {
  try {
    const actor = actorFromReq(req);
    const body = req.body || {};
    const admin = await adminRbacService.createAdmin({
      email: body.email,
      password: body.password,
      roleId: body.role_id ?? body.roleId,
      actorLevel: actor.level,
      actorAdminId: actor.adminId,
    });
    return res.status(201).json({ success: true, admin });
  } catch (err) {
    return mapRoleError(err, res);
  }
}

async function updateAdmin(req, res) {
  try {
    const actor = actorFromReq(req);
    const body = req.body || {};
    const admin = await adminRbacService.updateAdmin({
      adminId: req.params.adminId,
      roleId: body.role_id ?? body.roleId,
      active: body.active,
      password: body.password,
      actorLevel: actor.level,
      actorAdminId: actor.adminId,
      actorIsRoot: actor.isRoot,
    });
    return res.json({ success: true, admin });
  } catch (err) {
    return mapRoleError(err, res);
  }
}

module.exports = {
  listPermissions,
  listRoles,
  createRole,
  updateRole,
  listAdmins,
  createAdmin,
  updateAdmin,
};

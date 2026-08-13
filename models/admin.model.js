const { query } = require('../db');

async function findByEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return null;

  const result = await query(
    `SELECT id, email, password_hash, password_salt, role, role_id, active, created_at, updated_at
     FROM admins
     WHERE LOWER(TRIM(email)) = $1`,
    [normalized]
  );

  return result.rows[0] || null;
}

async function findById(id) {
  const result = await query(
    `SELECT id, email, role, role_id, active, created_at, updated_at
     FROM admins
     WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

module.exports = {
  findByEmail,
  findById,
};

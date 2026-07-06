const { query } = require('../db');

function normalizeAccountHolderName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function formatForResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    account_holder_name: normalizeAccountHolderName(row.account_holder_name),
    bank_name: String(row.bank_name || '').toUpperCase(),
    account_number: row.account_number,
    ifsc_code: row.ifsc_code,
    branch: row.branch,
    is_primary: row.is_primary === true,
    active: row.active === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
    masked_account_number: maskAccountNumber(row.account_number),
  };
}

function maskAccountNumber(accountNumber) {
  const value = String(accountNumber || '');
  if (value.length <= 4) return value;
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

async function listByUserId(userId) {
  const result = await query(
    `SELECT * FROM user_bank_accounts
     WHERE user_id = $1 AND active = true
     ORDER BY is_primary DESC, created_at DESC, id DESC`,
    [userId]
  );
  return result.rows.map(formatForResponse);
}

async function findByIdForUser({ id, userId }) {
  const result = await query(
    `SELECT * FROM user_bank_accounts
     WHERE id = $1 AND user_id = $2 AND active = true`,
    [id, userId]
  );
  return formatForResponse(result.rows[0]);
}

async function countActiveByUserId(userId) {
  const result = await query(
    'SELECT COUNT(*)::int AS count FROM user_bank_accounts WHERE user_id = $1 AND active = true',
    [userId]
  );
  return result.rows[0]?.count || 0;
}

async function createAccount({
  userId,
  accountHolderName,
  bankName,
  accountNumber,
  ifscCode,
  branch,
  isPrimary = false,
}) {
  if (isPrimary) {
    await query(
      'UPDATE user_bank_accounts SET is_primary = false, updated_at = NOW() WHERE user_id = $1 AND active = true',
      [userId]
    );
  }

  const result = await query(
    `INSERT INTO user_bank_accounts (
       user_id, account_holder_name, bank_name, account_number, ifsc_code, branch, is_primary
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, normalizeAccountHolderName(accountHolderName), String(bankName || '').trim().toUpperCase(), accountNumber, ifscCode, branch || null, isPrimary]
  );
  return formatForResponse(result.rows[0]);
}

async function softDeleteForUser({ id, userId }) {
  const result = await query(
    `UPDATE user_bank_accounts
     SET active = false, is_primary = false, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND active = true
     RETURNING *`,
    [id, userId]
  );
  return formatForResponse(result.rows[0]);
}

module.exports = {
  formatForResponse,
  listByUserId,
  findByIdForUser,
  countActiveByUserId,
  createAccount,
  softDeleteForUser,
  maskAccountNumber,
};

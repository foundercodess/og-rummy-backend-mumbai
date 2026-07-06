const { query } = require('../db');

function toNumber(value) {
  return value == null ? 0 : Number(value);
}

function normalizeAccountHolderName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function formatStatusForUi(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'successful') return 'Successful';
  if (normalized === 'pending') return 'Submitted';
  if (normalized === 'processing') return 'Processing';
  if (normalized === 'failed' || normalized === 'rejected') return 'Failed';
  return 'Pending';
}

function formatDisplayDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hh = String(hours).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${minutes}:${seconds}${ampm}`;
}

function formatListItem(row) {
  if (!row) return null;
  const bankRaw = row.bank_snapshot;
  const bank = typeof bankRaw === 'string'
    ? (() => { try { return JSON.parse(bankRaw); } catch { return {}; } })()
    : (bankRaw || {});
  return {
    id: row.id,
    transaction_no: row.withdraw_no,
    withdraw_no: row.withdraw_no,
    amount: toNumber(row.amount),
    handling_fee: toNumber(row.handling_fee),
    net_amount: toNumber(row.net_amount),
    status: formatStatusForUi(row.status),
    status_code: row.status,
    type: row.type,
    request_date: formatDisplayDate(row.requested_at),
    complete_date: formatDisplayDate(row.completed_at),
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    bank_name: String(bank.bank_name || '').toUpperCase() || null,
    bank_account_number: bank.account_number || null,
    bank_ifsc_code: bank.ifsc_code || null,
    branch: bank.branch || null,
    bank_account_holder_name: normalizeAccountHolderName(bank.account_holder_name) || null,
  };
}

function formatDetail(row) {
  const list = formatListItem(row);
  if (!list) return null;
  return {
    ...list,
    order_id: row.order_id,
    pg_reference: row.pg_reference,
    review_date: formatDisplayDate(row.reviewed_at || row.completed_at),
    reviewed_at: row.reviewed_at,
  };
}

async function findByIdForUser({ id, userId }) {
  const result = await query(
    'SELECT * FROM withdrawal_transactions WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rows[0] || null;
}

async function findByOrderId(orderId) {
  const result = await query(
    'SELECT * FROM withdrawal_transactions WHERE order_id = $1',
    [orderId]
  );
  return result.rows[0] || null;
}

async function listByUserId({ userId, type = null, limit = 50, offset = 0 }) {
  const params = [userId];
  let idx = 2;
  const where = ['user_id = $1'];
  if (type) {
    where.push(`type = $${idx++}`);
    params.push(type);
  }
  params.push(limit, offset);
  const result = await query(
    `SELECT * FROM withdrawal_transactions
     WHERE ${where.join(' AND ')}
     ORDER BY requested_at DESC, id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return result.rows.map(formatListItem);
}

async function getDailyStats(userId) {
  const result = await query(
    `SELECT
       COUNT(*)::int AS count,
       COALESCE(SUM(amount), 0) AS total_amount
     FROM withdrawal_transactions
     WHERE user_id = $1
       AND requested_at >= date_trunc('day', NOW())
       AND status NOT IN ('failed', 'rejected')`,
    [userId]
  );
  return {
    count: result.rows[0]?.count || 0,
    total_amount: toNumber(result.rows[0]?.total_amount),
  };
}

module.exports = {
  formatListItem,
  formatDetail,
  findByIdForUser,
  findByOrderId,
  listByUserId,
  getDailyStats,
  formatStatusForUi,
  formatDisplayDate,
};

const { query } = require('../db');

async function findByUserId(userId) {
  const result = await query(
    'SELECT * FROM kyc WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

async function findByIdAndUserId(id, userId) {
  const result = await query(
    'SELECT * FROM kyc WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rows[0] || null;
}

async function listForAdmin({
  page = 1,
  limit = 20,
  status = null,
  search = null,
  state = null,
  active = null,
  dateFrom = null,
  dateTo = null,
} = {}) {
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  let idx = 1;

  if (status) {
    conditions.push(`k.status = $${idx++}`);
    params.push(status);
  }

  if (state) {
    conditions.push(`LOWER(COALESCE(k.state, '')) = LOWER($${idx++})`);
    params.push(state);
  }

  if (active !== null) {
    conditions.push(`k.active = $${idx++}`);
    params.push(active);
  }

  if (dateFrom) {
    conditions.push(`k.created_at >= $${idx++}`);
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push(`k.created_at <= $${idx++}`);
    params.push(dateTo);
  }

  if (search) {
    conditions.push(`(
      COALESCE(u.name, '') ILIKE $${idx}
      OR COALESCE(k.name, '') ILIKE $${idx}
      OR COALESCE(u.phone, '') ILIKE $${idx}
      OR COALESCE(u.view_id, '') ILIKE $${idx}
      OR COALESCE(k.card_no, '') ILIKE $${idx}
    )`);
    params.push(`%${search}%`);
    idx += 1;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(
    `SELECT COUNT(*)
     FROM kyc k
     INNER JOIN users u ON u.id = k.user_id
     ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query(
    `SELECT
        k.id AS kyc_id,
        k.user_id,
        u.name AS user_name,
        u.phone,
        u.avatar,
        u.view_id,
        u.active AS user_active,
        k.image_url,
        k.card_no,
        k.dob,
        k.state,
        k.name AS kyc_name,
        k.status,
        k.active,
        k.rejection_note,
        k.created_at,
        k.updated_at
     FROM kyc k
     INNER JOIN users u ON u.id = k.user_id
     ${whereClause}
     ORDER BY k.updated_at DESC, k.id DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  return { items: result.rows, total };
}

/**
 * Upsert KYC for user (user-facing).
 * - status is always set to 'submitted' from this API.
 * - active is always true from this API.
 * Admin APIs can later change status/active.
 */
async function upsert(userId, data) {
  const { image_url, card_no, dob, state, name } = data;
  const statusVal = 'submitted';
  const activeVal = true;

  // Check if KYC already exists for this user
  const existing = await findByUserId(userId);
  if (!existing) {
    // First-time insert: it's okay if some fields are null
    const result = await query(
      `INSERT INTO kyc (user_id, image_url, card_no, dob, state, name, status, active, rejection_note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NOW())
       RETURNING *`,
      [userId, image_url ?? null, card_no ?? null, dob ?? null, state ?? null, name ?? null, statusVal, activeVal]
    );
    return result.rows[0];
  }

  // Partial update: only overwrite fields that are provided (not undefined)
  const sets = ['status = $1', 'active = $2', 'rejection_note = NULL', 'updated_at = NOW()'];
  const params = [statusVal, activeVal];
  let idx = params.length + 1;

  // For existing KYC, user is not allowed to null-out data; only non-null values update.
  if (image_url !== undefined && image_url !== null) {
    sets.push(`image_url = $${idx++}`);
    params.push(image_url);
  }
  if (card_no !== undefined && card_no !== null) {
    sets.push(`card_no = $${idx++}`);
    params.push(card_no);
  }
  if (dob !== undefined && dob !== null) {
    sets.push(`dob = $${idx++}`);
    params.push(dob);
  }
  if (state !== undefined && state !== null) {
    sets.push(`state = $${idx++}`);
    params.push(state);
  }
  if (name !== undefined && name !== null) {
    sets.push(`name = $${idx++}`);
    params.push(name);
  }

  // If nothing except status/active changed, still touch updated_at and submitted
  params.push(userId);
  const result = await query(
    `UPDATE kyc SET ${sets.join(', ')} WHERE user_id = $${idx} RETURNING *`,
    params
  );
  return result.rows[0];
}

/** Format KYC row for API (snake_case and include kyc_id). */
function formatForResponse(row) {
  if (!row) return null;
  return {
    kyc_id: row.id,
    image_url: row.image_url,
    card_no: row.card_no,
    dob: row.dob,
    state: row.state,
    name: row.name,
    status: row.status,
    active: row.active,
    rejection_note: row.rejection_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function adminUpdateStatusByUserId({ userId, status, rejectionNote = null }) {
  const result = await query(
    `UPDATE kyc
     SET status = $2,
         rejection_note = $3,
         updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId, status, rejectionNote]
  );

  return result.rows[0] || null;
}

function formatAdminListItem(row) {
  if (!row) return null;
  return {
    kyc_id: row.kyc_id,
    user_id: row.user_id,
    user_name: row.user_name,
    phone: row.phone,
    avatar: row.avatar,
    view_id: row.view_id,
    user_active: row.user_active,
    image_url: row.image_url,
    card_no: row.card_no,
    dob: row.dob,
    state: row.state,
    kyc_name: row.kyc_name,
    status: row.status,
    status_display: row.status === 'submitted' ? 'pending' : row.status,
    active: row.active,
    rejection_note: row.rejection_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  findByUserId,
  findByIdAndUserId,
  listForAdmin,
  upsert,
  adminUpdateStatusByUserId,
  formatForResponse,
  formatAdminListItem,
};

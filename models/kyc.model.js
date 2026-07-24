const { query } = require('../db');

const DOC_MODES = new Set(['pan', 'aadhaar', 'both']);

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
  docMode = null,
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

  if (docMode && DOC_MODES.has(String(docMode).toLowerCase())) {
    conditions.push(`k.doc_mode = $${idx++}`);
    params.push(String(docMode).toLowerCase());
  }

  if (search) {
    conditions.push(`(
      COALESCE(u.name, '') ILIKE $${idx}
      OR COALESCE(k.name, '') ILIKE $${idx}
      OR COALESCE(u.phone, '') ILIKE $${idx}
      OR COALESCE(u.view_id, '') ILIKE $${idx}
      OR COALESCE(k.card_no, '') ILIKE $${idx}
      OR COALESCE(k.pan_card_no, '') ILIKE $${idx}
      OR COALESCE(k.aadhaar_card_no, '') ILIKE $${idx}
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
        k.doc_mode,
        k.image_url,
        k.card_no,
        k.pan_image_url,
        k.pan_card_no,
        k.aadhaar_front_image_url,
        k.aadhaar_back_image_url,
        k.aadhaar_card_no,
        k.dob,
        k.state,
        k.name AS kyc_name,
        k.status,
        k.active,
        k.rejection_note,
        k.approved_at,
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

function normalizeUpsertPayload(data = {}) {
  const docModeRaw = String(data.doc_mode || data.docMode || 'pan').toLowerCase();
  const docMode = DOC_MODES.has(docModeRaw) ? docModeRaw : 'pan';

  const panImageUrl = data.pan_image_url ?? data.panImageUrl
    ?? ((docMode === 'pan' || docMode === 'both') ? (data.image_url ?? null) : null);
  const panCardNo = data.pan_card_no ?? data.panCardNo
    ?? ((docMode === 'pan' || docMode === 'both') ? (data.card_no ?? null) : null);

  const aadhaarFront = data.aadhaar_front_image_url ?? data.aadhaarFrontImageUrl ?? null;
  const aadhaarBack = data.aadhaar_back_image_url ?? data.aadhaarBackImageUrl ?? null;
  const aadhaarNo = data.aadhaar_card_no ?? data.aadhaarCardNo ?? null;

  // Legacy single fields: prefer PAN when mode includes pan; else keep aadhaar front as image_url.
  let legacyImage = data.image_url ?? null;
  let legacyCard = data.card_no ?? null;
  if (docMode === 'pan' || docMode === 'both') {
    legacyImage = panImageUrl ?? legacyImage;
    legacyCard = panCardNo ?? legacyCard;
  } else if (docMode === 'aadhaar') {
    legacyImage = aadhaarFront ?? legacyImage;
    legacyCard = aadhaarNo ?? legacyCard;
  }

  return {
    doc_mode: docMode,
    pan_image_url: panImageUrl ?? null,
    pan_card_no: panCardNo != null ? String(panCardNo).trim().toUpperCase() : null,
    aadhaar_front_image_url: aadhaarFront ?? null,
    aadhaar_back_image_url: aadhaarBack ?? null,
    aadhaar_card_no: aadhaarNo != null ? String(aadhaarNo).replace(/\s+/g, '') : null,
    image_url: legacyImage ?? null,
    card_no: legacyCard != null ? String(legacyCard).trim() : null,
    dob: data.dob ?? null,
    state: data.state ?? null,
    name: data.name ?? null,
  };
}

/**
 * Upsert KYC for user (user-facing).
 * - status is always set to 'submitted' from this API.
 * - active is always true from this API.
 */
async function upsert(userId, data) {
  const payload = normalizeUpsertPayload(data);
  const statusVal = 'submitted';
  const activeVal = true;

  const existing = await findByUserId(userId);
  if (!existing) {
    const result = await query(
      `INSERT INTO kyc (
         user_id, doc_mode,
         image_url, card_no,
         pan_image_url, pan_card_no,
         aadhaar_front_image_url, aadhaar_back_image_url, aadhaar_card_no,
         dob, state, name, status, active, rejection_note, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,NOW())
       RETURNING *`,
      [
        userId,
        payload.doc_mode,
        payload.image_url,
        payload.card_no,
        payload.pan_image_url,
        payload.pan_card_no,
        payload.aadhaar_front_image_url,
        payload.aadhaar_back_image_url,
        payload.aadhaar_card_no,
        payload.dob,
        payload.state,
        payload.name,
        statusVal,
        activeVal,
      ]
    );
    return result.rows[0];
  }

  // Resubmit clears prior approval timestamp.
  const sets = [
    'status = $1',
    'active = $2',
    'rejection_note = NULL',
    'approved_at = NULL',
    'updated_at = NOW()',
  ];
  const params = [statusVal, activeVal];
  let idx = params.length + 1;

  const maybeSet = (column, value) => {
    if (value !== undefined && value !== null && value !== '') {
      sets.push(`${column} = $${idx++}`);
      params.push(value);
    }
  };

  maybeSet('doc_mode', payload.doc_mode);
  maybeSet('image_url', payload.image_url);
  maybeSet('card_no', payload.card_no);
  maybeSet('pan_image_url', payload.pan_image_url);
  maybeSet('pan_card_no', payload.pan_card_no);
  maybeSet('aadhaar_front_image_url', payload.aadhaar_front_image_url);
  maybeSet('aadhaar_back_image_url', payload.aadhaar_back_image_url);
  maybeSet('aadhaar_card_no', payload.aadhaar_card_no);
  maybeSet('dob', payload.dob);
  maybeSet('state', payload.state);
  maybeSet('name', payload.name);

  params.push(userId);
  const result = await query(
    `UPDATE kyc SET ${sets.join(', ')} WHERE user_id = $${idx} RETURNING *`,
    params
  );
  return result.rows[0];
}

function formatForResponse(row) {
  if (!row) return null;
  const docMode = row.doc_mode || 'pan';
  const panImage = row.pan_image_url || (docMode !== 'aadhaar' ? row.image_url : null);
  const panNo = row.pan_card_no || (docMode !== 'aadhaar' ? row.card_no : null);
  const aadhaarFront = row.aadhaar_front_image_url
    || (docMode === 'aadhaar' ? row.image_url : null)
    || null;
  return {
    kyc_id: row.id ?? row.kyc_id ?? null,
    doc_mode: docMode,
    image_url: row.image_url || panImage || aadhaarFront || null,
    card_no: row.card_no || panNo || row.aadhaar_card_no || null,
    pan_image_url: panImage || null,
    pan_card_no: panNo || null,
    aadhaar_front_image_url: aadhaarFront,
    aadhaar_back_image_url: row.aadhaar_back_image_url || null,
    aadhaar_card_no: row.aadhaar_card_no || null,
    dob: row.dob,
    state: row.state,
    name: row.name,
    status: row.status,
    active: row.active,
    rejection_note: row.rejection_note,
    approved_at: row.approved_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function adminUpdateStatusByUserId({ userId, status, rejectionNote = null }) {
  const result = await query(
    `UPDATE kyc
     SET status = $2,
         rejection_note = $3,
         approved_at = CASE
           WHEN $2 = 'approved' THEN COALESCE(approved_at, NOW())
           ELSE NULL
         END,
         updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId, status, rejectionNote]
  );

  return result.rows[0] || null;
}

function formatAdminListItem(row) {
  if (!row) return null;
  const formatted = formatForResponse({
    id: row.kyc_id,
    doc_mode: row.doc_mode,
    image_url: row.image_url,
    card_no: row.card_no,
    pan_image_url: row.pan_image_url,
    pan_card_no: row.pan_card_no,
    aadhaar_front_image_url: row.aadhaar_front_image_url,
    aadhaar_back_image_url: row.aadhaar_back_image_url,
    aadhaar_card_no: row.aadhaar_card_no,
    dob: row.dob,
    state: row.state,
    name: row.kyc_name,
    status: row.status,
    active: row.active,
    rejection_note: row.rejection_note,
    approved_at: row.approved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
  return {
    ...formatted,
    kyc_id: row.kyc_id,
    user_id: row.user_id,
    user_name: row.user_name,
    phone: row.phone,
    avatar: row.avatar,
    view_id: row.view_id,
    user_active: row.user_active,
    kyc_name: row.kyc_name,
    status_display: row.status === 'submitted' ? 'pending' : row.status,
  };
}

module.exports = {
  DOC_MODES,
  findByUserId,
  findByIdAndUserId,
  listForAdmin,
  upsert,
  adminUpdateStatusByUserId,
  formatForResponse,
  formatAdminListItem,
  normalizeUpsertPayload,
};

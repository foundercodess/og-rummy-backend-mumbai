const { query } = require('../db');

async function getActiveForConfig() {
  const result = await query(
    `SELECT id, key, title, image_url, redirect_url, sort_order
     FROM support_links
     WHERE active = true
     ORDER BY sort_order ASC, id ASC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title,
    image_url: row.image_url,
    metadata: {
      redirect_url: row.redirect_url,
    },
  }));
}

async function getAllForAdmin() {
  const result = await query(
    `SELECT id, key, title, image_url, redirect_url, active, sort_order
     FROM support_links
     ORDER BY sort_order ASC, id ASC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title,
    image_url: row.image_url,
    active: row.active === true,
    sort_order: row.sort_order,
    metadata: {
      redirect_url: row.redirect_url,
    },
  }));
}

async function updateById(id, fields = {}) {
  const updates = [];
  const values = [id];
  let idx = 2;

  if (Object.prototype.hasOwnProperty.call(fields, 'active')) {
    updates.push(`active = $${idx++}`);
    values.push(fields.active);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'redirectUrl')) {
    updates.push(`redirect_url = $${idx++}`);
    values.push(fields.redirectUrl);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'title')) {
    updates.push(`title = $${idx++}`);
    values.push(fields.title);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'imageUrl')) {
    updates.push(`image_url = $${idx++}`);
    values.push(fields.imageUrl);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'sortOrder')) {
    updates.push(`sort_order = $${idx++}`);
    values.push(fields.sortOrder);
  }

  if (updates.length === 0) {
    const current = await query(
      'SELECT id, key, title, image_url, redirect_url, active, sort_order FROM support_links WHERE id = $1',
      [id]
    );
    const row = current.rows[0] || null;
    if (!row) return null;
    return {
      id: row.id,
      key: row.key,
      title: row.title,
      image_url: row.image_url,
      active: row.active === true,
      sort_order: row.sort_order,
      metadata: { redirect_url: row.redirect_url },
    };
  }

  updates.push('updated_at = NOW()');

  const result = await query(
    `UPDATE support_links
     SET ${updates.join(', ')}
     WHERE id = $1
     RETURNING id, key, title, image_url, redirect_url, active, sort_order`,
    values
  );

  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    image_url: row.image_url,
    active: row.active === true,
    sort_order: row.sort_order,
    metadata: { redirect_url: row.redirect_url },
  };
}

async function createSupport({
  key,
  title,
  imageUrl = null,
  redirectUrl,
  active = true,
  sortOrder = 0,
}) {
  const result = await query(
    `INSERT INTO support_links (
       key,
       title,
       image_url,
       redirect_url,
       active,
       sort_order,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, key, title, image_url, redirect_url, active, sort_order`,
    [key, title, imageUrl, redirectUrl, active, sortOrder]
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    image_url: row.image_url,
    active: row.active === true,
    sort_order: row.sort_order,
    metadata: { redirect_url: row.redirect_url },
  };
}

module.exports = {
  createSupport,
  getAllForAdmin,
  getActiveForConfig,
  updateById,
};


const { query } = require('../db');

async function getAll() {
  const result = await query(
    'SELECT id, url, sort_order, active FROM avatars ORDER BY sort_order ASC, id ASC'
  );
  return result.rows;
}

async function getActiveForConfig() {
  const result = await query(
    `SELECT id, url, sort_order
     FROM avatars
     WHERE active = true
     ORDER BY sort_order ASC, id ASC`
  );
  return result.rows;
}

/** Return one random avatar URL for assigning to new users. Returns null if no avatars exist. */
async function getRandomAvatarUrl() {
  const result = await query(
    'SELECT url FROM avatars WHERE active = true ORDER BY RANDOM() LIMIT 1'
  );
  return result.rows[0] ? result.rows[0].url : null;
}

async function updateActive(id, active) {
  const result = await query(
    `UPDATE avatars
     SET active = $2
     WHERE id = $1
     RETURNING id, url, sort_order, active`,
    [id, active]
  );
  return result.rows[0] || null;
}

async function createAvatar({ url, sortOrder = 0, active = true }) {
  const result = await query(
    `INSERT INTO avatars (url, sort_order, active)
     VALUES ($1, $2, $3)
     RETURNING id, url, sort_order, active`,
    [url, sortOrder, active]
  );
  return result.rows[0] || null;
}

module.exports = {
  createAvatar,
  getAll,
  getActiveForConfig,
  getRandomAvatarUrl,
  updateActive,
};

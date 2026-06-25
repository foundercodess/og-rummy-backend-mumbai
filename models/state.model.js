const { query } = require('../db');

/** Get all states, optionally only active. For config use activeOnly true. */
async function getAll(activeOnly = true) {
  const clause = activeOnly ? ' WHERE active = true' : '';
  const result = await query(
    `SELECT id, name, sort_order, active FROM states${clause} ORDER BY sort_order ASC, id ASC`
  );
  return result.rows;
}

/** Return state names as a simple array (for config API). Only active states. */
async function getAllNames() {
  const rows = await getAll(true);
  return rows.map((r) => r.name);
}

/** Return active states as array of { id, name, active } for config API. */
async function getActiveForConfig() {
  const rows = await getAll(true);
  return rows.map((r) => ({ id: r.id, name: r.name, active: r.active }));
}

module.exports = {
  getAll,
  getAllNames,
  getActiveForConfig,
};

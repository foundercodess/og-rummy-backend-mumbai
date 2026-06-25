const { query } = require('../db');

/** Get active FAQs for config API. */
async function getActiveForConfig() {
  const result = await query(
    `SELECT id, question, answer, sort_order
     FROM faqs
     WHERE active = true
     ORDER BY sort_order ASC, id ASC`
  );
  return result.rows;
}

async function getAllForAdmin() {
  const result = await query(
    `SELECT id, question, answer, active, sort_order
     FROM faqs
     ORDER BY sort_order ASC, id ASC`
  );
  return result.rows;
}

async function updateActive(id, active) {
  const result = await query(
    `UPDATE faqs
     SET active = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, question, answer, active, sort_order`,
    [id, active]
  );
  return result.rows[0] || null;
}

async function createFaq({
  question,
  answer,
  active = true,
  sortOrder = 0,
}) {
  const result = await query(
    `INSERT INTO faqs (question, answer, active, sort_order, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id, question, answer, active, sort_order`,
    [question, answer, active, sortOrder]
  );
  return result.rows[0] || null;
}

module.exports = {
  createFaq,
  getAllForAdmin,
  getActiveForConfig,
  updateActive,
};

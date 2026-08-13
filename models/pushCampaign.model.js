'use strict';

const { query } = require('../db');

async function createCampaign({
  type,
  inactiveDays = null,
  title,
  body,
  createdBy = null,
}) {
  const result = await query(
    `INSERT INTO push_campaigns (
       type, inactive_days, title, body, status, created_by
     ) VALUES ($1, $2, $3, $4, 'queued', $5)
     RETURNING *`,
    [type, inactiveDays, title, body, createdBy]
  );
  return result.rows[0] || null;
}

async function getCampaignById(id) {
  const result = await query(`SELECT * FROM push_campaigns WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function markRunning(id) {
  const result = await query(
    `UPDATE push_campaigns
     SET status = 'running',
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'running')
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function bumpProgress(id, { tokensTotal = 0, tokensSent = 0, tokensFailed = 0, targetUsers = 0 } = {}) {
  const result = await query(
    `UPDATE push_campaigns
     SET tokens_total = tokens_total + $2,
         tokens_sent = tokens_sent + $3,
         tokens_failed = tokens_failed + $4,
         target_users = GREATEST(target_users, $5),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, tokensTotal, tokensSent, tokensFailed, targetUsers]
  );
  return result.rows[0] || null;
}

async function markCompleted(id) {
  const result = await query(
    `UPDATE push_campaigns
     SET status = 'completed',
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function markFailed(id, errorMessage) {
  const result = await query(
    `UPDATE push_campaigns
     SET status = 'failed',
         error_message = LEFT($2, 1000),
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, String(errorMessage || 'failed')]
  );
  return result.rows[0] || null;
}

async function findRecentActiveCampaign({ type, inactiveDays, withinMinutes = 30 }) {
  const result = await query(
    `SELECT *
     FROM push_campaigns
     WHERE type = $1
       AND inactive_days IS NOT DISTINCT FROM $2
       AND status IN ('queued', 'running')
       AND created_at >= NOW() - ($3::int * INTERVAL '1 minute')
     ORDER BY id DESC
     LIMIT 1`,
    [type, inactiveDays, withinMinutes]
  );
  return result.rows[0] || null;
}

module.exports = {
  createCampaign,
  getCampaignById,
  markRunning,
  bumpProgress,
  markCompleted,
  markFailed,
  findRecentActiveCampaign,
};

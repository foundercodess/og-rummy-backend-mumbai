const { query } = require('../db');

function formatRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    latest: row.latest_version,
    minimum: row.minimum_version,
    url: row.download_url,
    release_notes: row.release_notes || '',
    enabled: row.enabled === true,
    metadata: row.metadata || {},
    updated_by: row.updated_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listAll() {
  const result = await query(
    `SELECT *
     FROM app_update_configs
     ORDER BY platform ASC`
  );
  return result.rows.map(formatRow);
}

async function getByPlatform(platform) {
  const result = await query(
    `SELECT *
     FROM app_update_configs
     WHERE platform = $1
     LIMIT 1`,
    [platform]
  );
  return formatRow(result.rows[0] || null);
}

async function upsertByPlatform({
  platform,
  latest,
  minimum,
  url,
  releaseNotes,
  enabled,
  metadata = {},
  updatedBy = null,
}) {
  const result = await query(
    `INSERT INTO app_update_configs (
       platform,
       latest_version,
       minimum_version,
       download_url,
       release_notes,
       enabled,
       metadata,
       updated_by,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
     ON CONFLICT (platform)
     DO UPDATE SET
       latest_version = EXCLUDED.latest_version,
       minimum_version = EXCLUDED.minimum_version,
       download_url = EXCLUDED.download_url,
       release_notes = EXCLUDED.release_notes,
       enabled = EXCLUDED.enabled,
       metadata = EXCLUDED.metadata,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      platform,
      latest,
      minimum,
      url,
      releaseNotes || '',
      enabled,
      JSON.stringify(metadata || {}),
      updatedBy,
    ]
  );

  return formatRow(result.rows[0] || null);
}

module.exports = {
  getByPlatform,
  listAll,
  upsertByPlatform,
};

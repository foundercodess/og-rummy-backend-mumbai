const { query } = require('../db');

function formatRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    platform: row.platform,
    version: row.version,
    download_url: row.download_url,
    s3_key: row.s3_key,
    release_notes: row.release_notes || '',
    file_name: row.file_name || null,
    mime_type: row.mime_type || null,
    size_bytes: Number(row.size_bytes || 0),
    uploaded_by: row.uploaded_by || null,
    metadata: row.metadata || {},
    is_deleted: row.is_deleted === true,
    deleted_at: row.deleted_at || null,
    deleted_by: row.deleted_by || null,
    delete_reason: row.delete_reason || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function createBuild({
  platform,
  version,
  downloadUrl,
  s3Key,
  releaseNotes = '',
  fileName = null,
  mimeType = null,
  sizeBytes = 0,
  uploadedBy = null,
  metadata = {},
}) {
  const result = await query(
    `INSERT INTO app_update_builds (
       platform,
       version,
       download_url,
       s3_key,
       release_notes,
       file_name,
       mime_type,
       size_bytes,
       uploaded_by,
       metadata,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
     RETURNING *`,
    [
      platform,
      version,
      downloadUrl,
      s3Key,
      releaseNotes || '',
      fileName,
      mimeType,
      Number(sizeBytes || 0),
      uploadedBy,
      JSON.stringify(metadata || {}),
    ]
  );
  return formatRow(result.rows[0] || null);
}

async function listBuildsByPlatform(platform, { includeDeleted = true } = {}) {
  const result = await query(
    `SELECT *
     FROM app_update_builds
     WHERE platform = $1
       AND ($2::boolean = true OR is_deleted = false)
     ORDER BY created_at DESC, id DESC`,
    [platform, includeDeleted]
  );
  return result.rows.map(formatRow);
}

async function markBuildDeleted({ id, deletedBy = null, reason = 'manual_cleanup', metadataPatch = {} }) {
  const result = await query(
    `UPDATE app_update_builds
     SET
       is_deleted = true,
       deleted_at = NOW(),
       deleted_by = $2,
       delete_reason = $3,
       metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
       updated_at = NOW()
     WHERE id = $1
       AND is_deleted = false
     RETURNING *`,
    [id, deletedBy, reason, JSON.stringify(metadataPatch || {})]
  );
  return formatRow(result.rows[0] || null);
}

module.exports = {
  createBuild,
  listBuildsByPlatform,
  markBuildDeleted,
};

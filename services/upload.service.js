const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.AWS_S3_BUCKET;

let s3 = null;
function getS3Client() {
  if (!s3) {
    s3 = new S3Client({ region: REGION });
  }
  return s3;
}

function randomKey(prefix, extension) {
  const id = crypto.randomBytes(16).toString('hex');
  const ts = Date.now();
  const safeExt = extension ? extension.toLowerCase() : 'bin';
  return `${prefix}/${ts}-${id}.${safeExt}`;
}

function sanitizeFolder(folder) {
  if (!folder || typeof folder !== 'string') return 'misc';
  // allow only a-z, 0-9, -, _, and /
  const cleaned = folder.replace(/[^a-zA-Z0-9/_-]/g, '');
  if (!cleaned) return 'misc';
  return cleaned.replace(/^\/+/, '').replace(/\/+$/, '') || 'misc';
}

async function uploadBuffer({ buffer, mimeType, folder = 'misc', userId }) {
  if (!BUCKET || !REGION) {
    throw new Error('S3_NOT_CONFIGURED');
  }
  const prefix = sanitizeFolder(folder) + (userId ? `/${userId}` : '');
  const extension = mimeType && mimeType.includes('/') ? mimeType.split('/')[1] : 'bin';
  const key = randomKey(prefix, extension);

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
    // ACL: 'public-read',
  });

  const client = getS3Client();
  await client.send(command);

  const baseUrl = process.env.AWS_S3_BASE_URL || `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
  const imageUrl = `${baseUrl}/${key}`;
  return { key, imageUrl };
}

async function uploadBufferWithKey({ buffer, mimeType, key, cacheControl }) {
  if (!BUCKET || !REGION) {
    throw new Error('S3_NOT_CONFIGURED');
  }
  const normalizedKey = String(key || '').replace(/^\/+/, '').trim();
  if (!normalizedKey) {
    throw new Error('INVALID_S3_KEY');
  }

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: normalizedKey,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
    ...(cacheControl ? { CacheControl: cacheControl } : {}),
  });

  const client = getS3Client();
  await client.send(command);

  const baseUrl = process.env.AWS_S3_BASE_URL || `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
  const publicUrl = `${baseUrl}/${normalizedKey}`;
  return { key: normalizedKey, publicUrl };
}

async function deleteObjectByKey(key) {
  if (!BUCKET || !REGION) {
    throw new Error('S3_NOT_CONFIGURED');
  }
  const normalizedKey = String(key || '').replace(/^\/+/, '').trim();
  if (!normalizedKey) {
    throw new Error('INVALID_S3_KEY');
  }
  const command = new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: normalizedKey,
  });
  const client = getS3Client();
  await client.send(command);
  return { key: normalizedKey, deleted: true };
}

module.exports = {
  uploadBuffer,
  uploadBufferWithKey,
  deleteObjectByKey,
};


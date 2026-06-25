const noticeModel = require('../models/notice.model');

const ALLOWED_TYPES = new Set(['info', 'warning', 'success', 'error']);

function normalizeMessage(message) {
  return typeof message === 'string' ? message.trim() : '';
}

function normalizeType(type) {
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : 'info';
  return ALLOWED_TYPES.has(normalized) ? normalized : null;
}

function normalizeSortOrder(sortOrder) {
  const parsed = Number(sortOrder);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeDate(value, fieldName) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid datetime`);
    error.code = 'INVALID_NOTICE_DATETIME';
    throw error;
  }
  return date;
}

function normalizeMetadata(metadata) {
  if (metadata == null) return {};
  if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;

  const error = new Error('metadata must be an object');
  error.code = 'INVALID_NOTICE_METADATA';
  throw error;
}

function validateWindow(startsAt, endsAt) {
  if (startsAt && endsAt && endsAt < startsAt) {
    const error = new Error('ends_at must be greater than or equal to starts_at');
    error.code = 'INVALID_NOTICE_WINDOW';
    throw error;
  }
}

async function createNotice({ message, type, isActive = true, sortOrder = 0, startsAt, endsAt, metadata, createdByAdminId }) {
  const normalizedMessage = normalizeMessage(message);
  if (!normalizedMessage) {
    const error = new Error('message is required');
    error.code = 'NOTICE_MESSAGE_REQUIRED';
    throw error;
  }

  const normalizedType = normalizeType(type || 'info');
  if (!normalizedType) {
    const error = new Error('type must be one of: info, warning, success, error');
    error.code = 'INVALID_NOTICE_TYPE';
    throw error;
  }

  const normalizedStartsAt = normalizeDate(startsAt, 'starts_at');
  const normalizedEndsAt = normalizeDate(endsAt, 'ends_at');
  validateWindow(normalizedStartsAt, normalizedEndsAt);

  return noticeModel.create({
    message: normalizedMessage,
    type: normalizedType,
    isActive: typeof isActive === 'boolean' ? isActive : true,
    sortOrder: normalizeSortOrder(sortOrder),
    startsAt: normalizedStartsAt,
    endsAt: normalizedEndsAt,
    metadata: normalizeMetadata(metadata),
    createdByAdminId: createdByAdminId || null,
  });
}

async function listActiveNotices() {
  return noticeModel.listActive();
}

async function listAllNotices() {
  return noticeModel.listAll();
}

async function updateNotice(id, updates = {}) {
  const existing = await noticeModel.findById(id);
  if (!existing) {
    const error = new Error('Notice not found');
    error.code = 'NOTICE_NOT_FOUND';
    throw error;
  }

  const message = Object.prototype.hasOwnProperty.call(updates, 'message')
    ? normalizeMessage(updates.message)
    : existing.message;
  if (!message) {
    const error = new Error('message is required');
    error.code = 'NOTICE_MESSAGE_REQUIRED';
    throw error;
  }

  const type = Object.prototype.hasOwnProperty.call(updates, 'type')
    ? normalizeType(updates.type)
    : existing.type;
  if (!type) {
    const error = new Error('type must be one of: info, warning, success, error');
    error.code = 'INVALID_NOTICE_TYPE';
    throw error;
  }

  const startsAt = Object.prototype.hasOwnProperty.call(updates, 'starts_at')
    ? normalizeDate(updates.starts_at, 'starts_at')
    : existing.starts_at;
  const endsAt = Object.prototype.hasOwnProperty.call(updates, 'ends_at')
    ? normalizeDate(updates.ends_at, 'ends_at')
    : existing.ends_at;
  validateWindow(startsAt, endsAt);

  return noticeModel.updateById(id, {
    message,
    type,
    isActive: Object.prototype.hasOwnProperty.call(updates, 'is_active') ? updates.is_active : existing.is_active,
    sortOrder: Object.prototype.hasOwnProperty.call(updates, 'sort_order') ? normalizeSortOrder(updates.sort_order) : existing.sort_order,
    startsAt,
    endsAt,
    metadata: Object.prototype.hasOwnProperty.call(updates, 'metadata') ? normalizeMetadata(updates.metadata) : (existing.metadata || {}),
  });
}

async function deleteNotice(id) {
  const deleted = await noticeModel.deleteById(id);
  if (!deleted) {
    const error = new Error('Notice not found');
    error.code = 'NOTICE_NOT_FOUND';
    throw error;
  }
  return { id };
}

module.exports = {
  createNotice,
  listActiveNotices,
  listAllNotices,
  updateNotice,
  deleteNotice,
};
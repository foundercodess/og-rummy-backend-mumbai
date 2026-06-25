const kycModel = require('../models/kyc.model');

async function upsertKyc(userId, data) {
  const row = await kycModel.upsert(userId, data);
  return kycModel.formatForResponse(row);
}

async function getKycByUserId(userId) {
  const row = await kycModel.findByUserId(userId);
  return kycModel.formatForResponse(row);
}

module.exports = {
  upsertKyc,
  getKycByUserId,
};

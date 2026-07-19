const kycService = require('../services/kyc.service');
const { DOC_MODES } = require('../models/kyc.model');

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;
const AADHAAR_REGEX = /^[0-9]{12}$/;

function validateKycPayload(body = {}) {
  const docMode = String(body.doc_mode || body.docMode || 'pan').toLowerCase();
  if (!DOC_MODES.has(docMode)) {
    return 'doc_mode must be pan, aadhaar, or both';
  }

  const name = String(body.name || '').trim();
  if (!name) return 'Name is required';

  const needsPan = docMode === 'pan' || docMode === 'both';
  const needsAadhaar = docMode === 'aadhaar' || docMode === 'both';

  if (needsPan) {
    const panImage = body.pan_image_url || body.panImageUrl || body.image_url;
    const panNo = String(body.pan_card_no || body.panCardNo || body.card_no || '')
      .trim()
      .toUpperCase();
    if (!panImage) return 'PAN card image is required';
    if (!PAN_REGEX.test(panNo)) return 'Valid PAN card number is required';
  }

  if (needsAadhaar) {
    const front = body.aadhaar_front_image_url || body.aadhaarFrontImageUrl;
    const back = body.aadhaar_back_image_url || body.aadhaarBackImageUrl;
    const aadhaarNo = String(body.aadhaar_card_no || body.aadhaarCardNo || '')
      .replace(/\s+/g, '');
    if (!front) return 'Aadhaar front image is required';
    if (!back) return 'Aadhaar back image is required';
    if (!AADHAAR_REGEX.test(aadhaarNo)) return 'Valid 12-digit Aadhaar number is required';
  }

  return null;
}

async function upsertKyc(req, res) {
  try {
    const userId = req.user.id;
    const validationError = validateKycPayload(req.body || {});
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const kyc = await kycService.upsertKyc(userId, {
      ...req.body,
      doc_mode: String(req.body.doc_mode || req.body.docMode || 'pan').toLowerCase(),
    });
    res.json({
      success: true,
      message: 'KYC saved successfully',
      kyc,
    });
  } catch (err) {
    console.error('upsertKyc error:', err);
    res.status(500).json({ success: false, message: 'Failed to save KYC' });
  }
}

module.exports = {
  upsertKyc,
};

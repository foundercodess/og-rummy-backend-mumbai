const kycService = require('../services/kyc.service');

async function upsertKyc(req, res) {
  try {
    const userId = req.user.id;
    const { image_url, card_no, dob, state, name } = req.body;
    const kyc = await kycService.upsertKyc(userId, {
      image_url,
      card_no,
      dob,
      state,
      name,
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

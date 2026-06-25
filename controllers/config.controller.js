const configService = require('../services/config.service');

async function getConfig(req, res) {
  try {
    const authHeader = req.get('Authorization') || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const fallbackToken = String(req.query.token || '').trim();
    const token = bearerToken || fallbackToken || null;

    const config = await configService.getConfig({
      platform: req.headers['x-platform'] || req.query.platform || null,
      appVersion: req.headers['x-app-version'] || req.query.app_version || null,
      token,
    });

    res.json({
      success: true,
      message: 'Config retrieved successfully',
      config,
    });
  } catch (err) {
    console.error('getConfig error:', err);
    res.status(500).json({ success: false, message: 'Failed to get config' });
  }
}

module.exports = {
  getConfig,
};

const settingsService = require('../services/dragontiger/dtSettings.service');
const repo = require('../services/dragontiger/dtRound.repository');

async function getSettings(req, res) {
  try {
    const settings = await settingsService.getSettings({ fresh: true });
    return res.json({
      status: true,
      settings,
      engine_enabled: settingsService.isEngineEnabled(),
    });
  } catch (err) {
    console.error('dragonTiger.getSettings error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load Dragon Tiger settings' });
  }
}

async function updateSettings(req, res) {
  try {
    const adminId = Number(req.admin?.id) || null;
    const settings = await settingsService.updateSettings(req.body || {}, adminId);
    return res.json({
      status: true,
      message: 'Dragon Tiger settings updated',
      settings,
      engine_enabled: settingsService.isEngineEnabled(),
    });
  } catch (err) {
    if (String(err.code || '').startsWith('INVALID_')) {
      return res.status(400).json({ status: false, code: err.code, message: err.message });
    }
    console.error('dragonTiger.updateSettings error:', err);
    return res.status(500).json({ status: false, message: 'Failed to update Dragon Tiger settings' });
  }
}

async function listRounds(req, res) {
  try {
    const data = await repo.listRoundsForAdmin({ page: req.query.page, limit: req.query.limit });
    return res.json({ status: true, ...data });
  } catch (err) {
    console.error('dragonTiger.listRounds error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load Dragon Tiger rounds' });
  }
}

async function getRound(req, res) {
  try {
    const roundId = Number(req.params.roundId);
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ status: false, message: 'Invalid round id' });
    }
    const detail = await repo.getRoundDetailForAdmin(roundId);
    if (!detail) return res.status(404).json({ status: false, message: 'Round not found' });
    return res.json({ status: true, ...detail });
  } catch (err) {
    console.error('dragonTiger.getRound error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load Dragon Tiger round' });
  }
}

module.exports = {
  getSettings,
  updateSettings,
  listRounds,
  getRound,
};

const repo = require('../services/teenpatti/tpAdmin.repository');
const { isTeenPattiEngineEnabled } = require('../services/gameFamily');

async function getOverview(req, res) {
  try {
    const overview = await repo.getOverview();
    return res.json({
      status: true,
      ...overview,
      engine_enabled: isTeenPattiEngineEnabled(),
    });
  } catch (err) {
    console.error('teenPatti.getOverview error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load Teen Patti overview' });
  }
}

async function listSessions(req, res) {
  try {
    const { page, limit, status, contest_id: contestId, user, from, to } = req.query;
    const data = await repo.listSessions({ page, limit, status, contestId, user, from, to });
    return res.json({ status: true, ...data });
  } catch (err) {
    console.error('teenPatti.listSessions error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load Teen Patti tables' });
  }
}

async function getSession(req, res) {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ status: false, message: 'Invalid session id' });
    }
    const detail = await repo.getSessionDetail(sessionId);
    if (!detail) return res.status(404).json({ status: false, message: 'Teen Patti table not found' });
    return res.json({ status: true, ...detail });
  } catch (err) {
    console.error('teenPatti.getSession error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load Teen Patti table' });
  }
}

module.exports = {
  getOverview,
  listSessions,
  getSession,
};

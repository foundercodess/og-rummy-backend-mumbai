const settingsService = require('../services/dragontiger/dtSettings.service');
const repo = require('../services/dragontiger/dtRound.repository');

const overrideRepo = require('../services/dragontiger/dtOverride.repository');
const { DIFFICULTIES } = require('../services/dragontiger/dtBias.service');
const { periodNo } = require('../services/dragontiger/dtRules.service');
/**
 * GET /admin/dragon-tiger/overrides
 *  query: page, limit, status (pending | applied | cancelled | omitted)
 */
async function listOverrides(req, res) {
  try {
    const { page, limit, status } = req.query;
    const data = await overrideRepo.listAll({ page, limit, status });
    return res.json({ status: true, ...data });
  } catch (err) {
    console.error('dragonTiger.listOverrides error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load overrides' });
  }
}

/**
 * GET /admin/dragon-tiger/overrides/upcoming
 *  Returns the next N upcoming round ids and any pending override for each.
 *  Used to show the "next 10 rounds" preview with existing overrides marked.
 */
async function getUpcomingOverrides(req, res) {
  try {
    const count = Math.min(50, Math.max(1, Number(req.query.count) || 10));
    const [nextIds, pending] = await Promise.all([
      repo.getUpcomingRoundIds(count),
      overrideRepo.listPending({ fromRound: 0, limit: count * 2 }),
    ]);

    const byTarget = new Map(pending.map((p) => [p.target_round, p]));
    const upcoming = nextIds.map((roundId) => ({
      target_round: roundId,
      period_no: periodNo(roundId),
      override: byTarget.get(roundId) || null,
    }));

    return res.json({ status: true, upcoming });
  } catch (err) {
    console.error('dragonTiger.getUpcomingOverrides error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load upcoming overrides' });
  }
}

/**
 * POST /admin/dragon-tiger/overrides
 *  body: { target_round: number, result: 'dragon'|'tiger'|'tie' }
 *  If target_round is omitted, defaults to next round.
 */
async function createOverride(req, res) {
  try {
    const adminId = Number(req.admin?.id) || null;
    const { result } = req.body || {};
    let { target_round: targetRound } = req.body || {};

    if (!['dragon', 'tiger', 'tie'].includes(String(result || '').toLowerCase())) {
      return res.status(400).json({
        status: false,
        code: 'INVALID_OVERRIDE_RESULT',
        message: 'result must be dragon|tiger|tie',
      });
    }

    // Default to next round if not specified
    if (targetRound == null) {
      const [nextId] = await repo.getUpcomingRoundIds(1);
      targetRound = nextId;
    }
    targetRound = Number(targetRound);
    if (!Number.isInteger(targetRound) || targetRound <= 0) {
      return res.status(400).json({ status: false, message: 'target_round must be a positive integer' });
    }

    // Refuse if round already exists and is beyond betting
    const existing = await repo.findRoundById(targetRound);
    if (existing && existing.status !== 'betting') {
      return res.status(400).json({
        status: false,
        code: 'DT_ROUND_ALREADY_LOCKED',
        message: `Round ${targetRound} is already ${existing.status}`,
      });
    }

    const row = await overrideRepo.schedule({
      targetRound,
      result: String(result).toLowerCase(),
      adminId,
    });

    return res.json({
      status: true,
      message: `Override scheduled: ${row.result} will win round ${row.target_round}`,
      override: {
        id: Number(row.id),
        target_round: Number(row.target_round),
        result: row.result,
        created_at: row.created_at,
        created_by: row.created_by ? Number(row.created_by) : null,
      },
    });
  } catch (err) {
    if (err.code === 'DT_OVERRIDE_EXISTS') {
      return res.status(409).json({ status: false, code: err.code, message: err.message });
    }
    console.error('dragonTiger.createOverride error:', err);
    return res.status(500).json({ status: false, message: 'Failed to create override' });
  }
}

/**
 * DELETE /admin/dragon-tiger/overrides/:id
 *  Cancels a pending override.
 */
async function cancelOverride(req, res) {
  try {
    const adminId = Number(req.admin?.id) || null;
    const overrideId = Number(req.params.id);
    if (!Number.isInteger(overrideId) || overrideId <= 0) {
      return res.status(400).json({ status: false, message: 'Invalid override id' });
    }
    const row = await overrideRepo.cancel({ overrideId, adminId });
    if (!row) {
      return res.status(404).json({ status: false, message: 'Override not found or already resolved' });
    }
    return res.json({ status: true, message: `Override for round ${row.target_round} cancelled` });
  } catch (err) {
    console.error('dragonTiger.cancelOverride error:', err);
    return res.status(500).json({ status: false, message: 'Failed to cancel override' });
  }
}

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

async function getSummary(req, res) {
  try {
    const [summary, settings] = await Promise.all([
      repo.getAdminSummary(),
      settingsService.getSettings({ fresh: true }),
    ]);
    return res.json({
      status: true,
      ...summary,
      table_enabled: settings.enabled === true,
      engine_enabled: settingsService.isEngineEnabled(),
    });
  } catch (err) {
    console.error('dragonTiger.getSummary error:', err);
    return res.status(500).json({ status: false, message: 'Failed to load Dragon Tiger summary' });
  }
}

async function listRounds(req, res) {
  try {
    const { page, limit, result, status, user, from, to } = req.query;
    const data = await repo.listRoundsForAdmin({ page, limit, result, status, user, from, to });
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
  getSummary,
  listRounds,
  getRound,
  listOverrides,
  getUpcomingOverrides,
  createOverride,
  cancelOverride,
};

const gameService = require('../services/game.service');

async function createContest(req, res) {
  try {
    const gameId = parseInt(req.params.gameId, 10);
    if (Number.isNaN(gameId) || gameId <= 0) {
      return res.status(400).json({
        status: false,
        message: 'Invalid game id',
      });
    }

    const result = await gameService.createContest(gameId, req.body || {});

    return res.status(201).json({
      status: true,
      message: 'Contest configuration created successfully',
      ...result,
    });
  } catch (err) {
    console.error('createContest error:', err);
    if (err.code === 'GAME_NOT_FOUND') {
      return res.status(404).json({ status: false, message: 'Game not found' });
    }
    if (err.code === 'INVALID_ENTRY_FEE') {
      return res.status(400).json({ status: false, message: 'entry_fee must be a valid positive number' });
    }
    if (err.code === 'INVALID_PLAY_TYPES_FOR_GAME') {
      const expected = err.details?.expected_play_types?.join(', ');
      return res.status(400).json({ status: false, message: `play_types are invalid for this game${expected ? `. Expected: ${expected}` : ''}` });
    }
    if (err.code === 'INVALID_PLAYER_COUNTS_FOR_GAME') {
      const expected = err.details?.expected_player_counts?.join(', ');
      return res.status(400).json({ status: false, message: `player_counts are invalid for this game${expected ? `. Allowed: ${expected}` : ''}` });
    }
    if (err.code === 'DUPLICATE_CONTEST_CONFIG') {
      return res.status(409).json({
        status: false,
        message: 'A contest with the same configuration already exists for this game',
        duplicates: err.details?.duplicates || [],
      });
    }
    if (err.code === 'INVALID_MULTIPLIER_X') {
      return res.status(400).json({ status: false, message: 'multiplier_x must be a valid positive integer' });
    }
    if (err.code === 'INVALID_ACTIVE_FLAG') {
      return res.status(400).json({ status: false, message: 'active must be true or false' });
    }
    if (err.code === 'INVALID_SORT_ORDER') {
      return res.status(400).json({ status: false, message: 'sort_order must be a valid integer' });
    }
    if (err.code === 'INVALID_GAME_ID') {
      return res.status(400).json({ status: false, message: 'Invalid game id' });
    }
    if (err.code === 'UNSUPPORTED_GAME_FOR_CONTEST_CREATION') {
      return res.status(400).json({ status: false, message: 'Contest creation is not supported for this game' });
    }
    return res.status(500).json({ status: false, message: 'Failed to create contest' });
  }
}

async function getGames(req, res) {
  try {
    const games = await gameService.getGames();

    res.json({
      status: true,
      message: "Game and it's type fetched successfully",
      games,
    });
  } catch (err) {
    console.error('getGames error:', err);
    res.status(500).json({
      status: false,
      message: 'Failed to fetch games',
      games: [],
    });
  }
}

/** Admin: list all games and contests including inactive (with active flag). */
async function getGamesForAdmin(req, res) {
  try {
    const games = await gameService.getGamesForAdmin();
    res.json({
      status: true,
      message: 'Games (including inactive) fetched successfully',
      games,
    });
  } catch (err) {
    console.error('getGamesForAdmin error:', err);
    res.status(500).json({
      status: false,
      message: 'Failed to fetch games for admin',
      games: [],
    });
  }
}

/** Admin: set game active (true/false). */
async function setGameActive(req, res) {
  try {
    const gameId = parseInt(req.params.gameId, 10);
    const active = req.body.active;
    if (Number.isNaN(gameId) || typeof active !== 'boolean') {
      return res.status(400).json({
        status: false,
        message: 'Invalid game id or body.active (boolean required)',
      });
    }
    const updated = await gameService.setGameActive(gameId, active);
    if (!updated) {
      return res.status(404).json({ status: false, message: 'Game not found' });
    }
    res.json({
      status: true,
      message: `Game ${updated.name} ${active ? 'activated' : 'deactivated'}`,
      game: updated,
    });
  } catch (err) {
    console.error('setGameActive error:', err);
    res.status(500).json({ status: false, message: 'Failed to update game active' });
  }
}

/** Admin: set contest active (true/false). */
async function setContestActive(req, res) {
  try {
    const contestId = parseInt(req.params.contestId, 10);
    const active = req.body.active;
    if (Number.isNaN(contestId) || typeof active !== 'boolean') {
      return res.status(400).json({
        status: false,
        message: 'Invalid contest id or body.active (boolean required)',
      });
    }
    const updated = await gameService.setContestActive(contestId, active);
    if (!updated) {
      return res.status(404).json({ status: false, message: 'Contest not found' });
    }
    res.json({
      status: true,
      message: `Contest ${updated.id} ${active ? 'activated' : 'deactivated'}`,
      contest: updated,
    });
  } catch (err) {
    console.error('setContestActive error:', err);
    res.status(500).json({ status: false, message: 'Failed to update contest active' });
  }
}

module.exports = {
  createContest,
  getGames,
  getGamesForAdmin,
  setGameActive,
  setContestActive,
};

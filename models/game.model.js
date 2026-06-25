const { query, pool } = require('../db');

async function getAllWithContests(options = {}) {
  const { includeInactive = false } = options;
  const activeFilter = includeInactive
    ? ''
    : 'WHERE g.active = true AND (c.id IS NULL OR c.active = true)';
  const result = await query(`
    SELECT 
      g.id AS game_id,
      g.name,
      g.dashboard_banner,
      g.side_banner,
      g.badge,
      g.turn_timer_seconds,
      g.bonus_timer_seconds,
      g.sort_order AS game_sort,
      g.active AS game_active,
      c.id AS contest_id,
      c.player_count,
      c.point_value,
      c.entry,
      c.win_upto,
      c.sort_order AS contest_sort,
      c.active AS contest_active,
      cpt.play_type
    FROM games g
    LEFT JOIN contests c ON c.game_id = g.id
    LEFT JOIN contest_play_types cpt ON cpt.contest_id = c.id
    ${activeFilter}
    ORDER BY g.sort_order, g.id, c.player_count, c.sort_order, cpt.play_type
  `);
  return result.rows;
}

async function updateGameActive(gameId, active) {
  const result = await query(
    'UPDATE games SET active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, active',
    [active, gameId]
  );
  return result.rows[0] || null;
}

async function updateContestActive(contestId, active) {
  const result = await query(
    'UPDATE contests SET active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, game_id, player_count, entry, active',
    [active, contestId]
  );
  return result.rows[0] || null;
}

async function findGameById(gameId) {
  const result = await query(
    'SELECT id, name, active FROM games WHERE id = $1',
    [gameId]
  );
  return result.rows[0] || null;
}

async function getNextContestSortOrder(gameId) {
  const result = await query(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order FROM contests WHERE game_id = $1',
    [gameId]
  );
  return Number(result.rows[0]?.max_sort_order || 0) + 1;
}

async function findDuplicateContests({ gameId, contests }) {
  if (!Array.isArray(contests) || contests.length === 0) {
    return [];
  }

  const conditions = [];
  const params = [gameId];
  let idx = 2;

  for (const contest of contests) {
    conditions.push(`(
      player_count = $${idx}
      AND COALESCE(point_value, '') = COALESCE($${idx + 1}, '')
      AND entry = $${idx + 2}
      AND COALESCE(win_upto, '') = COALESCE($${idx + 3}, '')
    )`);
    params.push(
      contest.player_count,
      contest.point_value,
      contest.entry,
      contest.win_upto,
    );
    idx += 4;
  }

  const result = await query(
    `SELECT id, game_id, player_count, point_value, entry, win_upto, sort_order, active
     FROM contests
     WHERE game_id = $1
       AND (${conditions.join(' OR ')})`,
    params
  );

  return result.rows;
}

async function findDuplicateContestsWithClient(client, { gameId, contests }) {
  if (!Array.isArray(contests) || contests.length === 0) {
    return [];
  }

  const conditions = [];
  const params = [gameId];
  let idx = 2;

  for (const contest of contests) {
    conditions.push(`(
      player_count = $${idx}
      AND COALESCE(point_value, '') = COALESCE($${idx + 1}, '')
      AND entry = $${idx + 2}
      AND COALESCE(win_upto, '') = COALESCE($${idx + 3}, '')
    )`);
    params.push(
      contest.player_count,
      contest.point_value,
      contest.entry,
      contest.win_upto,
    );
    idx += 4;
  }

  const result = await client.query(
    `SELECT id, game_id, player_count, point_value, entry, win_upto, sort_order, active
     FROM contests
     WHERE game_id = $1
       AND (${conditions.join(' OR ')})`,
    params
  );

  return result.rows;
}

async function createContests({
  gameId,
  contests,
  playTypes,
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [gameId]);

    const duplicates = await findDuplicateContestsWithClient(client, { gameId, contests });
    if (duplicates.length > 0) {
      const err = new Error('DUPLICATE_CONTEST_CONFIG');
      err.code = 'DUPLICATE_CONTEST_CONFIG';
      err.details = {
        duplicates: duplicates.map((row) => ({
          id: row.id,
          player_count: row.player_count,
          point_value: row.point_value,
          entry: row.entry,
          win_upto: row.win_upto,
          sort_order: row.sort_order,
          active: row.active,
        })),
      };
      throw err;
    }

    const createdContests = [];
    for (const contestInput of contests) {
      const contestResult = await client.query(
        `INSERT INTO contests (game_id, player_count, point_value, entry, win_upto, sort_order, active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING id, game_id, player_count, point_value, entry, win_upto, sort_order, active, created_at, updated_at`,
        [
          gameId,
          contestInput.player_count,
          contestInput.point_value,
          contestInput.entry,
          contestInput.win_upto,
          contestInput.sort_order,
          contestInput.active,
        ]
      );
      const contest = contestResult.rows[0];

      const valuePlaceholders = playTypes
        .map((_, index) => `($1, $${index + 2})`)
        .join(', ');
      await client.query(
        `INSERT INTO contest_play_types (contest_id, play_type) VALUES ${valuePlaceholders}`,
        [contest.id, ...playTypes]
      );

      createdContests.push({
        ...contest,
        play_types: playTypes,
      });
    }

    await client.query('COMMIT');
    return createdContests;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getAllWithContests,
  updateGameActive,
  updateContestActive,
  findGameById,
  getNextContestSortOrder,
  findDuplicateContests,
  createContests,
};

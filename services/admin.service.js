const userModel = require('../models/user.model');
const kycModel = require('../models/kyc.model');
const walletModel = require('../models/wallet.model');
const avatarModel = require('../models/avatar.model');
const addCashOptionModel = require('../models/addCashOption.model');
const withdrawOptionModel = require('../models/withdrawOption.model');
const faqModel = require('../models/faq.model');
const supportLinkModel = require('../models/supportLink.model');
const stateModel = require('../models/state.model');
const maintenanceModeModel = require('../models/maintenanceMode.model');
const appUpdateConfigModel = require('../models/appUpdateConfig.model');
const appUpdateBuildModel = require('../models/appUpdateBuild.model');
const notificationService = require('./notification.service');
const uploadService = require('./upload.service');
const { query } = require('../db');

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return null;
}

function normalizeKycStatusFilter(status) {
  if (status == null || String(status).trim() === '' || String(status).trim().toLowerCase() === 'all') {
    return null;
  }

  const normalized = String(status).trim().toLowerCase();
  if (normalized === 'pending') {
    return 'submitted';
  }

  if (['submitted', 'approved', 'rejected'].includes(normalized)) {
    return normalized;
  }

  const err = new Error('INVALID_KYC_STATUS_FILTER');
  err.code = 'INVALID_KYC_STATUS_FILTER';
  throw err;
}

function normalizeDateFilter(value, code) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  return parsed.toISOString();
}

function normalizeGameHistoryStatusFilter(status) {
  // Default to finished matches only so admin "history" is not flooded with stale waiting/active rows.
  // Pass status=all for full ledger, or status=live for non-terminal sessions.
  if (status == null || String(status).trim() === '') {
    return 'completed';
  }
  const normalized = String(status).trim().toLowerCase();
  if (['all', 'live', 'completed'].includes(normalized)) {
    return normalized;
  }
  const err = new Error('INVALID_GAME_HISTORY_STATUS');
  err.code = 'INVALID_GAME_HISTORY_STATUS';
  throw err;
}

function normalizeWalletTransactionFilter(filter) {
  if (filter == null || String(filter).trim() === '') return 'all';
  const normalized = String(filter).trim().toLowerCase();
  const allowed = new Set([
    'all',
    'won',
    'lost',
    'money_add',
    'withdraw',
    'release_bonus',
    'game',
    'recharge',
    'bonus',
  ]);
  if (!allowed.has(normalized)) {
    const err = new Error('INVALID_WALLET_TX_FILTER');
    err.code = 'INVALID_WALLET_TX_FILTER';
    throw err;
  }
  return normalized;
}

function normalizeWalletTransactionDirection(direction) {
  if (direction == null || String(direction).trim() === '') return 'all';
  const normalized = String(direction).trim().toLowerCase();
  if (['all', 'credit', 'debit'].includes(normalized)) return normalized;
  const err = new Error('INVALID_WALLET_TX_DIRECTION');
  err.code = 'INVALID_WALLET_TX_DIRECTION';
  throw err;
}

function toNumberOrNull(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIntegerFilter(value, code) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  return parsed;
}

function toBooleanStrict(value, code) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  const err = new Error(code);
  err.code = code;
  throw err;
}

function normalizeOptionalDate(value, code) {
  if (value == null || value === '') return null;
  return normalizeDateFilter(value, code);
}

function toMaintenanceResponse(row) {
  const current = maintenanceModeModel.formatForResponse(row) || {
    enabled: false,
    title: 'Scheduled Maintenance',
    message: 'We are currently under maintenance. Please try again shortly.',
    start_at: null,
    end_at: null,
    metadata: {},
  };

  const serverTime = new Date();
  const startAt = current.start_at ? new Date(current.start_at) : null;
  const endAt = current.end_at ? new Date(current.end_at) : null;
  const startsInSeconds = startAt && startAt.getTime() > serverTime.getTime()
    ? Math.max(0, Math.floor((startAt.getTime() - serverTime.getTime()) / 1000))
    : 0;
  const endsInSeconds = endAt && endAt.getTime() > serverTime.getTime()
    ? Math.max(0, Math.floor((endAt.getTime() - serverTime.getTime()) / 1000))
    : 0;

  return {
    enabled: current.enabled === true,
    title: current.title,
    message: current.message,
    start_at: current.start_at || null,
    end_at: current.end_at || null,
    server_time: serverTime.toISOString(),
    starts_in_seconds: startsInSeconds,
    ends_in_seconds: endsInSeconds,
    timing_message: (
      current.enabled
        ? (endsInSeconds > 0 ? `Maintenance is active. Estimated end in ${endsInSeconds} seconds.` : 'Maintenance is active.')
        : (startsInSeconds > 0 ? `Maintenance is scheduled to start in ${startsInSeconds} seconds.` : 'Maintenance is not active.')
    ),
    metadata: current.metadata || {},
    updated_by: current.updated_by || null,
    updated_at: current.updated_at || null,
  };
}

function normalizeSessionModeValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.includes('practice')) return 'practice';
  if (normalized.includes('spin')) return 'spin_go';
  if (normalized.includes('deal')) return 'deals_2';
  if (normalized.includes('pool')) return 'pool';
  if (normalized.includes('point')) return 'points';
  return null;
}

function resolveSettlementSummary({ row, result }) {
  const settlement = result && result.settlement && typeof result.settlement === 'object' ? result.settlement : {};
  const prizePool = result && result.prize_pool && typeof result.prize_pool === 'object' ? result.prize_pool : {};
  const mode = normalizeSessionModeValue(
    result?.mode
    || row?.metadata?.game_mode
    || row?.metadata?.game_type
    || row?.metadata?.mode
    || row?.game_name
  );

  const playersCount = toNumberOrNull(row.players_count) || toNumberOrNull(row.contest_player_count) || 0;
  const entry = toNumberOrNull(row.contest_entry);
  const computedTotalEntry = (playersCount > 0 && entry != null) ? (entry * playersCount) : null;
  const contestPointValue = toNumberOrNull(row.contest_point_value);

  const winnerGainFromResults = Array.isArray(result?.results)
    ? result.results.reduce((max, item) => {
      const value = toNumberOrNull(item?.won_amount);
      if (value == null) return max;
      return max == null ? value : Math.max(max, value);
    }, null)
    : null;

  const pointsLossPoolFromResults = Array.isArray(result?.results)
    ? result.results.reduce((sum, item) => {
      if (item?.is_winner === true) return sum;
      const points = toNumberOrNull(item?.points);
      if (points == null || points <= 0) return sum;
      if (contestPointValue == null || contestPointValue <= 0) return sum;
      return sum + (points * contestPointValue);
    }, 0)
    : 0;

  const winnerGain = toNumberOrNull(settlement.winner_gain)
    ?? winnerGainFromResults
    ?? toNumberOrNull(prizePool.current_prize_pool)
    ?? null;

  const totalEntry = mode === 'points'
    ? (
      toNumberOrNull(settlement.total_entry)
      ?? toNumberOrNull(prizePool.total_entry)
      ?? null
    )
    : (
      toNumberOrNull(settlement.total_entry)
      ?? toNumberOrNull(prizePool.total_entry)
      ?? computedTotalEntry
      ?? null
    );

  const adminCommissionAmount = toNumberOrNull(settlement.admin_commission_amount)
    ?? toNumberOrNull(prizePool.admin_commission_amount)
    ?? (
      mode === 'points' && winnerGain != null && pointsLossPoolFromResults > 0
        ? Math.max(0, Number((pointsLossPoolFromResults - winnerGain).toFixed(2)))
        : null
    )
    ?? (
      totalEntry != null && winnerGain != null
        ? Math.max(0, Number((totalEntry - winnerGain).toFixed(2)))
        : null
    );

  return {
    settlement_type: settlement.settlement_type || null,
    total_entry: totalEntry == null ? null : Number(totalEntry.toFixed(2)),
    admin_commission_amount: adminCommissionAmount == null ? null : Number(adminCommissionAmount.toFixed(2)),
    winner_gain: winnerGain == null ? null : Number(winnerGain.toFixed(2)),
  };
}

function buildAdminWinnerBlock(row, result) {
  return {
    user_id: toNumberOrNull(result.winner_user_id),
    name: row.winner_name || null,
    phone: row.winner_phone || null,
    view_id: row.winner_view_id || null,
  };
}

/** How to interpret `winner` for admins (pool may stash last-round winner in metadata while status is still active). */
function resolveAdminWinnerContext(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 'final_match';
  if (s === 'cancelled') return 'cancelled';
  return 'interim_metadata_only';
}

function formatAdminGameHistoryItem(row) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const result = metadata.result && typeof metadata.result === 'object' ? metadata.result : {};
  const winnerBlock = buildAdminWinnerBlock(row, result);
  const winnerContext = resolveAdminWinnerContext(row.status);
  const hasWinnerUser = winnerBlock.user_id != null;

  return {
    session_id: row.id,
    session_code: row.session_code,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    duration_seconds: row.started_at && row.ended_at
      ? Math.max(0, Math.floor((new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 1000))
      : null,
    mode: normalizeSessionModeValue(metadata.game_mode)
      || normalizeSessionModeValue(metadata.game_type)
      || normalizeSessionModeValue(metadata.mode)
      || normalizeSessionModeValue(row.game_name),
    game: {
      id: row.game_id,
      name: row.game_name,
    },
    contest: {
      id: row.contest_id,
      player_count: toNumberOrNull(row.contest_player_count),
      entry: toNumberOrNull(row.contest_entry),
      point_value: row.contest_point_value == null ? null : Number(row.contest_point_value),
      win_upto: row.contest_win_upto == null ? null : Number(row.contest_win_upto),
    },
    players_count: toNumberOrNull(row.players_count) || 0,
    // Same shape as before: user from metadata.result.winner_user_id + JOIN users.
    winner: winnerBlock,
    // interim_metadata_only | final_match | cancelled — clarifies pool / zombie confusion without DB writes.
    winner_context: winnerContext,
    // Populated only when the session row is completed and metadata names a winner (authoritative final winner).
    final_match_winner: winnerContext === 'final_match' && hasWinnerUser ? winnerBlock : null,
    // False for live/waiting pool rounds: settlement_* may be null or derived from contest math only.
    settlement_authoritative: winnerContext === 'final_match',
    settlement: resolveSettlementSummary({ row, result }),
  };
}

async function listGamesHistoryForAdmin({
  page = 1,
  limit = 20,
  status,
  gameId,
  contestId,
  userId,
  dateFrom,
  dateTo,
} = {}) {
  const normalizedStatus = normalizeGameHistoryStatusFilter(status);
  const normalizedDateFrom = normalizeDateFilter(dateFrom, 'INVALID_DATE_FROM');
  const normalizedDateTo = normalizeDateFilter(dateTo, 'INVALID_DATE_TO');
  const normalizedGameId = gameId == null || gameId === '' ? null : Number(gameId);
  const normalizedContestId = contestId == null || contestId === '' ? null : Number(contestId);
  const normalizedUserId = userId == null || userId === '' ? null : Number(userId);

  if (normalizedGameId != null && (!Number.isInteger(normalizedGameId) || normalizedGameId <= 0)) {
    const err = new Error('INVALID_GAME_ID_FILTER');
    err.code = 'INVALID_GAME_ID_FILTER';
    throw err;
  }
  if (normalizedContestId != null && (!Number.isInteger(normalizedContestId) || normalizedContestId <= 0)) {
    const err = new Error('INVALID_CONTEST_ID_FILTER');
    err.code = 'INVALID_CONTEST_ID_FILTER';
    throw err;
  }
  if (normalizedUserId != null && (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0)) {
    const err = new Error('INVALID_USER_ID_FILTER');
    err.code = 'INVALID_USER_ID_FILTER';
    throw err;
  }

  const where = [];
  const params = [];
  let idx = 1;

  if (normalizedStatus === 'live') {
    where.push(`gs.status IN ('waiting', 'ready', 'active')`);
  } else if (normalizedStatus === 'completed') {
    where.push(`gs.status = 'completed'`);
  }

  if (normalizedGameId != null) {
    where.push(`gs.game_id = $${idx++}`);
    params.push(normalizedGameId);
  }

  if (normalizedContestId != null) {
    where.push(`gs.contest_id = $${idx++}`);
    params.push(normalizedContestId);
  }

  if (normalizedDateFrom) {
    where.push(`COALESCE(gs.ended_at, gs.updated_at, gs.created_at) >= $${idx++}`);
    params.push(normalizedDateFrom);
  }

  if (normalizedDateTo) {
    where.push(`COALESCE(gs.ended_at, gs.updated_at, gs.created_at) <= $${idx++}`);
    params.push(normalizedDateTo);
  }

  if (normalizedUserId != null) {
    where.push(`EXISTS (
      SELECT 1
      FROM game_session_players gsp_filter
      WHERE gsp_filter.game_session_id = gs.id
        AND gsp_filter.user_id = $${idx++}
    )`);
    params.push(normalizedUserId);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM game_sessions gs
     ${whereClause}`,
    params
  );
  const total = countResult.rows[0] ? Number(countResult.rows[0].total) : 0;

  const offset = (page - 1) * limit;
  const listParams = [...params, limit, offset];
  const limitParam = idx++;
  const offsetParam = idx;

  const listResult = await query(
    `SELECT
       gs.*,
       g.name AS game_name,
       c.player_count AS contest_player_count,
       c.entry AS contest_entry,
       c.point_value AS contest_point_value,
       c.win_upto AS contest_win_upto,
       player_stats.players_count,
       winner_user.name AS winner_name,
       winner_user.phone AS winner_phone,
       winner_user.view_id AS winner_view_id
     FROM game_sessions gs
     LEFT JOIN games g ON g.id = gs.game_id
     LEFT JOIN contests c ON c.id = gs.contest_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS players_count
       FROM game_session_players gsp
       WHERE gsp.game_session_id = gs.id
     ) AS player_stats ON true
     LEFT JOIN users winner_user
       ON winner_user.id = CASE
         WHEN (gs.metadata->'result'->>'winner_user_id') ~ '^[0-9]+$'
         THEN (gs.metadata->'result'->>'winner_user_id')::int
         ELSE NULL
       END
     ${whereClause}
     ORDER BY COALESCE(gs.ended_at, gs.updated_at, gs.created_at) DESC, gs.id DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams
  );

  return {
    history: listResult.rows.map(formatAdminGameHistoryItem),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    filters: {
      status: normalizedStatus,
      game_id: normalizedGameId,
      contest_id: normalizedContestId,
      user_id: normalizedUserId,
      date_from: normalizedDateFrom,
      date_to: normalizedDateTo,
    },
  };
}

async function getGameHistoryDetailsForAdmin(sessionId) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('INVALID_SESSION_ID');
    err.code = 'INVALID_SESSION_ID';
    throw err;
  }

  const sessionResult = await query(
    `SELECT
       gs.*,
       g.name AS game_name,
       c.player_count AS contest_player_count,
       c.entry AS contest_entry,
       c.point_value AS contest_point_value,
       c.win_upto AS contest_win_upto,
       player_stats.players_count,
       winner_user.name AS winner_name,
       winner_user.phone AS winner_phone,
       winner_user.view_id AS winner_view_id
     FROM game_sessions gs
     LEFT JOIN games g ON g.id = gs.game_id
     LEFT JOIN contests c ON c.id = gs.contest_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS players_count
       FROM game_session_players gsp
       WHERE gsp.game_session_id = gs.id
     ) AS player_stats ON true
     LEFT JOIN users winner_user
       ON winner_user.id = CASE
         WHEN (gs.metadata->'result'->>'winner_user_id') ~ '^[0-9]+$'
         THEN (gs.metadata->'result'->>'winner_user_id')::int
         ELSE NULL
       END
     WHERE gs.id = $1
     LIMIT 1`,
    [id]
  );

  const row = sessionResult.rows[0] || null;
  if (!row) {
    const err = new Error('SESSION_NOT_FOUND');
    err.code = 'SESSION_NOT_FOUND';
    throw err;
  }

  const [playersResult, eventsResult] = await Promise.all([
    query(
      `SELECT
         gsp.id,
         gsp.user_id,
         gsp.seat_no,
         gsp.status,
         gsp.left_at,
         gsp.metadata,
         gsp.joined_at,
         u.name,
         u.phone,
         u.avatar,
         u.view_id
       FROM game_session_players gsp
       JOIN users u ON u.id = gsp.user_id
       WHERE gsp.game_session_id = $1
       ORDER BY gsp.seat_no ASC, gsp.id ASC`,
      [id]
    ),
    query(
      `SELECT id, user_id, event_type, payload, created_at
       FROM game_session_events
       WHERE game_session_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
      [id]
    ),
  ]);

  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const result = metadata.result && typeof metadata.result === 'object' ? metadata.result : {};
  const resultByUserId = new Map(
    (Array.isArray(result.results) ? result.results : [])
      .filter((item) => toNumberOrNull(item?.user_id) != null)
      .map((item) => [toNumberOrNull(item.user_id), item])
  );

  return {
    session: formatAdminGameHistoryItem(row),
    players: playersResult.rows.map((player) => ({
      ...(resultByUserId.get(Number(player.user_id)) ? {
        result: {
          points: toNumberOrNull(resultByUserId.get(Number(player.user_id)).points),
          total_score: toNumberOrNull(resultByUserId.get(Number(player.user_id)).total_score),
          round_points: toNumberOrNull(resultByUserId.get(Number(player.user_id)).round_points),
          cumulative_points: toNumberOrNull(resultByUserId.get(Number(player.user_id)).cumulative_points),
          is_winner: resultByUserId.get(Number(player.user_id)).is_winner === true,
          player_status: resultByUserId.get(Number(player.user_id)).player_status || null,
          status_color: resultByUserId.get(Number(player.user_id)).status_color || null,
          submission_status: resultByUserId.get(Number(player.user_id)).submission_status || null,
          won_amount: toNumberOrNull(resultByUserId.get(Number(player.user_id)).won_amount),
          dropped: resultByUserId.get(Number(player.user_id)).dropped === true,
        },
      } : {}),
      id: player.id,
      user_id: player.user_id,
      seat_no: player.seat_no,
      status: player.status,
      left_at: player.left_at,
      metadata: player.metadata || {},
      joined_at: player.joined_at,
      user: {
        name: player.name,
        phone: player.phone,
        avatar: player.avatar,
        view_id: player.view_id,
      },
    })),
    events: eventsResult.rows.reverse(),
  };
}

async function listWalletTransactionsForAdmin({
  page = 1,
  limit = 20,
  filter,
  direction,
  transactionType,
  source,
  referenceType,
  referenceId,
  userId,
  phone,
  orderId,
  dateFrom,
  dateTo,
  minAmount,
  maxAmount,
} = {}) {
  const normalizedFilter = normalizeWalletTransactionFilter(filter);
  const normalizedDirection = normalizeWalletTransactionDirection(direction);
  const normalizedDateFrom = normalizeDateFilter(dateFrom, 'INVALID_DATE_FROM');
  const normalizedDateTo = normalizeDateFilter(dateTo, 'INVALID_DATE_TO');
  const normalizedReferenceId = normalizeIntegerFilter(referenceId, 'INVALID_REFERENCE_ID_FILTER');
  const normalizedUserId = normalizeIntegerFilter(userId, 'INVALID_USER_ID_FILTER');
  const normalizedPhone = phone == null ? null : String(phone).trim();
  const normalizedOrderId = orderId == null ? null : String(orderId).trim();
  const normalizedTxType = transactionType == null ? null : String(transactionType).trim().toLowerCase();
  const normalizedSource = source == null ? null : String(source).trim().toLowerCase();
  const normalizedReferenceType = referenceType == null ? null : String(referenceType).trim().toLowerCase();
  const normalizedMinAmount = minAmount == null || minAmount === '' ? null : Number(minAmount);
  const normalizedMaxAmount = maxAmount == null || maxAmount === '' ? null : Number(maxAmount);

  if (normalizedMinAmount != null && !Number.isFinite(normalizedMinAmount)) {
    const err = new Error('INVALID_MIN_AMOUNT');
    err.code = 'INVALID_MIN_AMOUNT';
    throw err;
  }
  if (normalizedMaxAmount != null && !Number.isFinite(normalizedMaxAmount)) {
    const err = new Error('INVALID_MAX_AMOUNT');
    err.code = 'INVALID_MAX_AMOUNT';
    throw err;
  }

  const debitTypes = ['game_loss_debit', 'game_entry_debit', 'withdraw_debit', 'withdrawal_debit'];
  const creditTypes = [
    'deposit_credit',
    'game_win_credit',
    'pending_bonus_credit',
    'bonus_release_credit',
    'released_bonus_credit',
    'release_bonus_credit',
  ];

  const where = [];
  const params = [];
  let idx = 1;

  if (normalizedUserId != null) {
    where.push(`wt.user_id = $${idx++}`);
    params.push(normalizedUserId);
  }
  if (normalizedPhone) {
    where.push(`u.phone ILIKE $${idx++}`);
    params.push(`%${normalizedPhone}%`);
  }
  if (normalizedOrderId) {
    where.push(`rt.order_id ILIKE $${idx++}`);
    params.push(`%${normalizedOrderId}%`);
  }
  if (normalizedTxType) {
    where.push(`LOWER(wt.transaction_type) = $${idx++}`);
    params.push(normalizedTxType);
  }
  if (normalizedSource) {
    where.push(`LOWER(wt.source) = $${idx++}`);
    params.push(normalizedSource);
  }
  if (normalizedReferenceType) {
    where.push(`LOWER(wt.reference_type) = $${idx++}`);
    params.push(normalizedReferenceType);
  }
  if (normalizedReferenceId != null) {
    where.push(`wt.reference_id = $${idx++}`);
    params.push(normalizedReferenceId);
  }
  if (normalizedDateFrom) {
    where.push(`wt.created_at >= $${idx++}`);
    params.push(normalizedDateFrom);
  }
  if (normalizedDateTo) {
    where.push(`wt.created_at <= $${idx++}`);
    params.push(normalizedDateTo);
  }
  if (normalizedMinAmount != null) {
    where.push(`ABS(COALESCE(wt.amount, 0)) >= $${idx++}`);
    params.push(normalizedMinAmount);
  }
  if (normalizedMaxAmount != null) {
    where.push(`ABS(COALESCE(wt.amount, 0)) <= $${idx++}`);
    params.push(normalizedMaxAmount);
  }

  if (normalizedDirection === 'credit') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(creditTypes);
  } else if (normalizedDirection === 'debit') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(debitTypes);
  }

  if (normalizedFilter === 'won') {
    where.push(`wt.transaction_type = $${idx++}`);
    params.push('game_win_credit');
  } else if (normalizedFilter === 'lost') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(['game_loss_debit', 'game_entry_debit']);
  } else if (normalizedFilter === 'money_add') {
    where.push(`wt.transaction_type = $${idx++}`);
    params.push('deposit_credit');
    where.push(`wt.source = $${idx++}`);
    params.push('recharge');
  } else if (normalizedFilter === 'withdraw') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(['withdraw_debit', 'withdrawal_debit']);
  } else if (normalizedFilter === 'release_bonus') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(['bonus_release_credit', 'released_bonus_credit', 'release_bonus_credit']);
  } else if (normalizedFilter === 'game') {
    where.push(`wt.source = $${idx++}`);
    params.push('game');
  } else if (normalizedFilter === 'recharge') {
    where.push(`wt.source = $${idx++}`);
    params.push('recharge');
  } else if (normalizedFilter === 'bonus') {
    where.push(`wt.transaction_type = ANY($${idx++}::text[])`);
    params.push(['pending_bonus_credit', 'bonus_release_credit', 'released_bonus_credit', 'release_bonus_credit']);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const baseFromJoin = `
    FROM wallet_transactions wt
    LEFT JOIN users u ON u.id = wt.user_id
    LEFT JOIN game_sessions gs
      ON wt.reference_type = 'game_session'
     AND gs.id = wt.reference_id
    LEFT JOIN games g ON g.id = gs.game_id
    LEFT JOIN contests c ON c.id = gs.contest_id
    LEFT JOIN recharge_transactions rt
      ON wt.reference_type = 'recharge_transaction'
     AND rt.id = wt.reference_id
    ${whereClause}
  `;

  const countResult = await query(
    `SELECT COUNT(*)::int AS total ${baseFromJoin}`,
    params
  );
  const total = Number(countResult.rows[0]?.total || 0);

  const summaryResult = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN wt.transaction_type = ANY($${idx}::text[]) THEN ABS(wt.amount) ELSE 0 END), 0)::numeric(14,2) AS total_credit,
       COALESCE(SUM(CASE WHEN wt.transaction_type = ANY($${idx + 1}::text[]) THEN ABS(wt.amount) ELSE 0 END), 0)::numeric(14,2) AS total_debit
     ${baseFromJoin}`,
    [...params, creditTypes, debitTypes]
  );

  const offset = (page - 1) * limit;
  const listResult = await query(
    `SELECT
       wt.*,
       u.name AS user_name,
       u.phone AS user_phone,
       u.view_id AS user_view_id,
       gs.game_id AS session_game_id,
       gs.contest_id AS session_contest_id,
       gs.session_code,
       gs.status AS session_status,
       gs.metadata AS session_metadata,
       g.name AS game_name,
       c.entry AS contest_entry,
       c.point_value AS contest_point_value,
       rt.order_id AS recharge_order_id,
       rt.status AS recharge_status
     ${baseFromJoin}
     ORDER BY wt.created_at DESC, wt.id DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  const items = listResult.rows.map((row) => {
    const txType = String(row.transaction_type || '').toLowerCase();
    const absoluteAmount = Math.abs(Number(row.amount) || 0);
    const directionValue = debitTypes.includes(txType) ? 'debit' : 'credit';
    const signedAmount = directionValue === 'debit' ? -absoluteAmount : absoluteAmount;
    return {
      id: row.id,
      user: {
        id: row.user_id,
        name: row.user_name || null,
        phone: row.user_phone || null,
        view_id: row.user_view_id || null,
      },
      transaction_type: row.transaction_type,
      source: row.source,
      type: row.type,
      direction: directionValue,
      amount: Number(absoluteAmount.toFixed(2)),
      signed_amount: Number(signedAmount.toFixed(2)),
      reference_type: row.reference_type,
      reference_id: row.reference_id,
      reference: {
        game_session: row.reference_type === 'game_session' ? {
          session_id: row.reference_id,
          session_code: row.session_code || null,
          status: row.session_status || null,
          game_id: row.session_game_id,
          game_name: row.game_name || null,
          contest_id: row.session_contest_id,
          contest_entry: toNumberOrNull(row.contest_entry),
          contest_point_value: toNumberOrNull(row.contest_point_value),
        } : null,
        recharge_transaction: row.reference_type === 'recharge_transaction' ? {
          recharge_transaction_id: row.reference_id,
          order_id: row.recharge_order_id || null,
          status: row.recharge_status || null,
        } : null,
      },
      metadata: row.metadata || {},
      expires_at: row.expires_at || null,
      created_at: row.created_at,
    };
  });

  const totalCredit = toNumberOrNull(summaryResult.rows[0]?.total_credit) || 0;
  const totalDebit = toNumberOrNull(summaryResult.rows[0]?.total_debit) || 0;

  return {
    transactions: items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    filters: {
      filter: normalizedFilter,
      direction: normalizedDirection,
      transaction_type: normalizedTxType,
      source: normalizedSource,
      reference_type: normalizedReferenceType,
      reference_id: normalizedReferenceId,
      user_id: normalizedUserId,
      phone: normalizedPhone || null,
      order_id: normalizedOrderId || null,
      date_from: normalizedDateFrom,
      date_to: normalizedDateTo,
      min_amount: normalizedMinAmount,
      max_amount: normalizedMaxAmount,
    },
    summary: {
      total_credit: Number(totalCredit.toFixed(2)),
      total_debit: Number(totalDebit.toFixed(2)),
      net: Number((totalCredit - totalDebit).toFixed(2)),
    },
  };
}

async function listRechargesForAdmin({
  page = 1,
  limit = 20,
  status,
  type,
  userId,
  phone,
  orderId,
  paymentRef,
  dateFrom,
  dateTo,
  minAmount,
  maxAmount,
} = {}) {
  const normalizedDateFrom = normalizeDateFilter(dateFrom, 'INVALID_DATE_FROM');
  const normalizedDateTo = normalizeDateFilter(dateTo, 'INVALID_DATE_TO');
  const normalizedUserId = normalizeIntegerFilter(userId, 'INVALID_USER_ID_FILTER');
  const normalizedPhone = phone == null ? null : String(phone).trim();
  const normalizedOrderId = orderId == null ? null : String(orderId).trim();
  const normalizedPaymentRef = paymentRef == null ? null : String(paymentRef).trim();
  const normalizedStatus = status == null || String(status).trim() === ''
    ? 'all'
    : String(status).trim().toLowerCase();
  const normalizedType = type == null || String(type).trim() === ''
    ? 'all'
    : String(type).trim().toLowerCase();
  const normalizedMinAmount = minAmount == null || minAmount === '' ? null : Number(minAmount);
  const normalizedMaxAmount = maxAmount == null || maxAmount === '' ? null : Number(maxAmount);

  if (!['all', 'init', 'payment_success', 'failed', 'not_paid'].includes(normalizedStatus)) {
    const err = new Error('INVALID_RECHARGE_STATUS_FILTER');
    err.code = 'INVALID_RECHARGE_STATUS_FILTER';
    throw err;
  }
  if (!['all', 'conventional', 'p2p'].includes(normalizedType)) {
    const err = new Error('INVALID_RECHARGE_TYPE_FILTER');
    err.code = 'INVALID_RECHARGE_TYPE_FILTER';
    throw err;
  }
  if (normalizedMinAmount != null && !Number.isFinite(normalizedMinAmount)) {
    const err = new Error('INVALID_MIN_AMOUNT');
    err.code = 'INVALID_MIN_AMOUNT';
    throw err;
  }
  if (normalizedMaxAmount != null && !Number.isFinite(normalizedMaxAmount)) {
    const err = new Error('INVALID_MAX_AMOUNT');
    err.code = 'INVALID_MAX_AMOUNT';
    throw err;
  }

  const where = [];
  const params = [];
  let idx = 1;

  if (normalizedStatus !== 'all') {
    where.push(`LOWER(rt.status) = $${idx++}`);
    params.push(normalizedStatus);
  }
  if (normalizedType !== 'all') {
    where.push(`LOWER(rt.type) = $${idx++}`);
    params.push(normalizedType);
  }
  if (normalizedUserId != null) {
    where.push(`rt.user_id = $${idx++}`);
    params.push(normalizedUserId);
  }
  if (normalizedPhone) {
    where.push(`COALESCE(rt.phone, u.phone, '') ILIKE $${idx++}`);
    params.push(`%${normalizedPhone}%`);
  }
  if (normalizedOrderId) {
    where.push(`rt.order_id ILIKE $${idx++}`);
    params.push(`%${normalizedOrderId}%`);
  }
  if (normalizedPaymentRef) {
    where.push(`COALESCE(rt.payment_ref, '') ILIKE $${idx++}`);
    params.push(`%${normalizedPaymentRef}%`);
  }
  if (normalizedDateFrom) {
    where.push(`rt.requested_at >= $${idx++}`);
    params.push(normalizedDateFrom);
  }
  if (normalizedDateTo) {
    where.push(`rt.requested_at <= $${idx++}`);
    params.push(normalizedDateTo);
  }
  if (normalizedMinAmount != null) {
    where.push(`rt.amount >= $${idx++}`);
    params.push(normalizedMinAmount);
  }
  if (normalizedMaxAmount != null) {
    where.push(`rt.amount <= $${idx++}`);
    params.push(normalizedMaxAmount);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const fromJoin = `
    FROM recharge_transactions rt
    LEFT JOIN users u ON u.id = rt.user_id
    LEFT JOIN wallets w ON w.id = rt.wallet_id
    LEFT JOIN promo_codes pc ON pc.id = rt.promo_code_id
    LEFT JOIN add_cash_options aco ON aco.id = rt.add_cash_option_id
    ${whereClause}
  `;

  const countResult = await query(`SELECT COUNT(*)::int AS total ${fromJoin}`, params);
  const total = Number(countResult.rows[0]?.total || 0);

  const summaryResult = await query(
    `SELECT
       COALESCE(SUM(rt.amount), 0)::numeric(14,2) AS requested_total,
       COALESCE(SUM(CASE WHEN rt.status = 'payment_success' THEN rt.amount ELSE 0 END), 0)::numeric(14,2) AS success_total,
       COUNT(*) FILTER (WHERE rt.status = 'payment_success')::int AS success_count,
       COUNT(*) FILTER (WHERE rt.status = 'failed')::int AS failed_count,
       COUNT(*) FILTER (WHERE rt.status = 'init')::int AS init_count,
       COUNT(*) FILTER (WHERE rt.status = 'not_paid')::int AS not_paid_count
     ${fromJoin}`,
    params
  );

  const offset = (page - 1) * limit;
  const listResult = await query(
    `SELECT
       rt.*,
       u.name AS user_name,
       u.phone AS user_phone,
       u.view_id AS user_view_id,
       w.deposit AS wallet_deposit,
       w.pending_bonus AS wallet_pending_bonus,
       w.total_balance AS wallet_total_balance,
       pc.code AS promo_code,
       aco.base_amount AS option_base_amount,
       aco.instant_cash AS option_instant_cash,
       aco.bonus AS option_bonus
     ${fromJoin}
     ORDER BY rt.requested_at DESC, rt.id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...params, limit, offset]
  );

  const recharges = listResult.rows.map((row) => ({
    id: row.id,
    order_id: row.order_id,
    status: row.status,
    type: row.type,
    amount: toNumberOrNull(row.amount),
    currency: row.currency,
    payment_ref: row.payment_ref,
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user: {
      id: row.user_id,
      name: row.user_name || row.name || null,
      phone: row.user_phone || row.phone || null,
      view_id: row.user_view_id || null,
      email: row.email || null,
    },
    wallet: {
      id: row.wallet_id,
      deposit: toNumberOrNull(row.wallet_deposit),
      pending_bonus: toNumberOrNull(row.wallet_pending_bonus),
      total_balance: toNumberOrNull(row.wallet_total_balance),
    },
    add_cash_option: row.add_cash_option_id ? {
      id: row.add_cash_option_id,
      base_amount: toNumberOrNull(row.option_base_amount),
      instant_cash: toNumberOrNull(row.option_instant_cash),
      bonus: toNumberOrNull(row.option_bonus),
    } : null,
    promo: row.promo_code_id ? {
      id: row.promo_code_id,
      code: row.promo_code || null,
      bonus_amount: toNumberOrNull(row.promo_bonus_amount),
      instant_cash: toNumberOrNull(row.promo_instant_cash),
    } : null,
  }));

  const summaryRow = summaryResult.rows[0] || {};
  return {
    recharges,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    filters: {
      status: normalizedStatus,
      type: normalizedType,
      user_id: normalizedUserId,
      phone: normalizedPhone || null,
      order_id: normalizedOrderId || null,
      payment_ref: normalizedPaymentRef || null,
      date_from: normalizedDateFrom,
      date_to: normalizedDateTo,
      min_amount: normalizedMinAmount,
      max_amount: normalizedMaxAmount,
    },
    summary: {
      requested_total: toNumberOrNull(summaryRow.requested_total) || 0,
      success_total: toNumberOrNull(summaryRow.success_total) || 0,
      success_count: Number(summaryRow.success_count || 0),
      failed_count: Number(summaryRow.failed_count || 0),
      init_count: Number(summaryRow.init_count || 0),
      not_paid_count: Number(summaryRow.not_paid_count || 0),
    },
  };
}

async function getRechargeDetailsForAdmin(rechargeId) {
  const id = normalizeIntegerFilter(rechargeId, 'INVALID_RECHARGE_ID');

  const rechargeResult = await query(
    `SELECT
       rt.*,
       u.name AS user_name,
       u.phone AS user_phone,
       u.view_id AS user_view_id,
       u.avatar AS user_avatar,
       w.deposit AS wallet_deposit,
       w.pending_bonus AS wallet_pending_bonus,
       w.released_bonus AS wallet_released_bonus,
       w.withdrawable AS wallet_withdrawable,
       w.total_balance AS wallet_total_balance,
       pc.code AS promo_code,
       aco.base_amount AS option_base_amount,
       aco.instant_cash AS option_instant_cash,
       aco.bonus AS option_bonus
     FROM recharge_transactions rt
     LEFT JOIN users u ON u.id = rt.user_id
     LEFT JOIN wallets w ON w.id = rt.wallet_id
     LEFT JOIN promo_codes pc ON pc.id = rt.promo_code_id
     LEFT JOIN add_cash_options aco ON aco.id = rt.add_cash_option_id
     WHERE rt.id = $1
     LIMIT 1`,
    [id]
  );

  const row = rechargeResult.rows[0] || null;
  if (!row) {
    const err = new Error('RECHARGE_NOT_FOUND');
    err.code = 'RECHARGE_NOT_FOUND';
    throw err;
  }

  const ledgerResult = await query(
    `SELECT wt.*
     FROM wallet_transactions wt
     WHERE wt.reference_type = 'recharge_transaction'
       AND wt.reference_id = $1
     ORDER BY wt.created_at ASC, wt.id ASC`,
    [id]
  );

  const ledger = ledgerResult.rows.map((tx) => ({
    id: tx.id,
    transaction_type: tx.transaction_type,
    amount: toNumberOrNull(tx.amount),
    source: tx.source,
    reference_type: tx.reference_type,
    reference_id: tx.reference_id,
    expires_at: tx.expires_at || null,
    metadata: tx.metadata || {},
    created_at: tx.created_at,
  }));

  return {
    recharge: {
      id: row.id,
      order_id: row.order_id,
      status: row.status,
      type: row.type,
      amount: toNumberOrNull(row.amount),
      currency: row.currency,
      payment_ref: row.payment_ref,
      payment_response: row.payment_response,
      requested_at: row.requested_at,
      completed_at: row.completed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      user: {
        id: row.user_id,
        name: row.user_name || row.name || null,
        phone: row.user_phone || row.phone || null,
        email: row.email || null,
        view_id: row.user_view_id || null,
        avatar: row.user_avatar || null,
      },
      wallet: {
        id: row.wallet_id,
        deposit: toNumberOrNull(row.wallet_deposit),
        pending_bonus: toNumberOrNull(row.wallet_pending_bonus),
        released_bonus: toNumberOrNull(row.wallet_released_bonus),
        withdrawable: toNumberOrNull(row.wallet_withdrawable),
        total_balance: toNumberOrNull(row.wallet_total_balance),
      },
      add_cash_option: row.add_cash_option_id ? {
        id: row.add_cash_option_id,
        base_amount: toNumberOrNull(row.option_base_amount),
        instant_cash: toNumberOrNull(row.option_instant_cash),
        bonus: toNumberOrNull(row.option_bonus),
      } : null,
      promo: row.promo_code_id ? {
        id: row.promo_code_id,
        code: row.promo_code || null,
        bonus_amount: toNumberOrNull(row.promo_bonus_amount),
        instant_cash: toNumberOrNull(row.promo_instant_cash),
      } : null,
    },
    ledger,
  };
}

async function getMaintenanceModeForAdmin() {
  const row = await maintenanceModeModel.getCurrent();
  return {
    maintenance_mode: toMaintenanceResponse(row),
  };
}

async function updateMaintenanceModeForAdmin({
  enabled,
  message,
  updatedBy,
}) {
  const normalizedEnabled = toBooleanStrict(enabled, 'INVALID_MAINTENANCE_ENABLED');
  const normalizedMessage = message == null
    ? 'We are currently under maintenance. Please try again shortly.'
    : String(message).trim();

  const next = await maintenanceModeModel.upsertCurrent({
    enabled: normalizedEnabled,
    title: 'Scheduled Maintenance',
    message: normalizedMessage || 'We are currently under maintenance. Please try again shortly.',
    startAt: null,
    endAt: null,
    metadata: {},
    updatedBy: updatedBy == null ? null : normalizeIntegerFilter(updatedBy, 'INVALID_UPDATED_BY_ADMIN_ID'),
  });

  return {
    maintenance_mode: toMaintenanceResponse(next),
  };
}

async function getAppSettingsForAdmin() {
  const [avatars, states, addCashOptions, withdrawOptions, faqs, supports, maintenanceMode] = await Promise.all([
    avatarModel.getAll(),
    stateModel.getActiveForConfig(),
    addCashOptionModel.getAllForAdmin(),
    withdrawOptionModel.getAllForAdmin(),
    faqModel.getAllForAdmin(),
    supportLinkModel.getAllForAdmin(),
    maintenanceModeModel.getCurrent(),
  ]);

  return {
    app_settings: {
      avatars,
      states,
      addCashOptions,
      withdrawOptions,
      faqs,
      supports,
      maintenanceMode: toMaintenanceResponse(maintenanceMode),
    },
  };
}

async function updateAvatarActiveForAdmin({ avatarId, active }) {
  const id = normalizeIntegerFilter(avatarId, 'INVALID_AVATAR_ID');
  const nextActive = toBooleanStrict(active, 'INVALID_ACTIVE_FLAG');
  const updated = await avatarModel.updateActive(id, nextActive);
  if (!updated) {
    const err = new Error('AVATAR_NOT_FOUND');
    err.code = 'AVATAR_NOT_FOUND';
    throw err;
  }
  return { avatar: updated };
}

async function updateAddCashOptionActiveForAdmin({ optionId, active }) {
  const id = normalizeIntegerFilter(optionId, 'INVALID_ADD_CASH_OPTION_ID');
  const nextActive = toBooleanStrict(active, 'INVALID_ACTIVE_FLAG');
  const updated = await addCashOptionModel.updateActive(id, nextActive);
  if (!updated) {
    const err = new Error('ADD_CASH_OPTION_NOT_FOUND');
    err.code = 'ADD_CASH_OPTION_NOT_FOUND';
    throw err;
  }
  return { add_cash_option: updated };
}

async function updateWithdrawOptionActiveForAdmin({ optionId, active }) {
  const id = normalizeIntegerFilter(optionId, 'INVALID_WITHDRAW_OPTION_ID');
  const nextActive = toBooleanStrict(active, 'INVALID_ACTIVE_FLAG');
  const updated = await withdrawOptionModel.updateActive(id, nextActive);
  if (!updated) {
    const err = new Error('WITHDRAW_OPTION_NOT_FOUND');
    err.code = 'WITHDRAW_OPTION_NOT_FOUND';
    throw err;
  }
  return { withdraw_option: updated };
}

async function updateFaqActiveForAdmin({ faqId, active }) {
  const id = normalizeIntegerFilter(faqId, 'INVALID_FAQ_ID');
  const nextActive = toBooleanStrict(active, 'INVALID_ACTIVE_FLAG');
  const updated = await faqModel.updateActive(id, nextActive);
  if (!updated) {
    const err = new Error('FAQ_NOT_FOUND');
    err.code = 'FAQ_NOT_FOUND';
    throw err;
  }
  return { faq: updated };
}

async function updateSupportForAdmin({
  supportId,
  active,
  redirectUrl,
  title,
  imageUrl,
  sortOrder,
}) {
  const id = normalizeIntegerFilter(supportId, 'INVALID_SUPPORT_ID');
  const fields = {};
  if (active !== undefined) fields.active = toBooleanStrict(active, 'INVALID_ACTIVE_FLAG');
  if (redirectUrl !== undefined) fields.redirectUrl = redirectUrl == null ? '' : String(redirectUrl).trim();
  if (title !== undefined) fields.title = title == null ? '' : String(title).trim();
  if (imageUrl !== undefined) fields.imageUrl = imageUrl == null ? null : String(imageUrl).trim();
  if (sortOrder !== undefined) {
    const parsed = Number(sortOrder);
    if (!Number.isInteger(parsed) || parsed < 0) {
      const err = new Error('INVALID_SORT_ORDER');
      err.code = 'INVALID_SORT_ORDER';
      throw err;
    }
    fields.sortOrder = parsed;
  }
  if (Object.keys(fields).length === 0) {
    const err = new Error('NO_SUPPORT_UPDATE_FIELDS');
    err.code = 'NO_SUPPORT_UPDATE_FIELDS';
    throw err;
  }
  const updated = await supportLinkModel.updateById(id, fields);
  if (!updated) {
    const err = new Error('SUPPORT_NOT_FOUND');
    err.code = 'SUPPORT_NOT_FOUND';
    throw err;
  }
  return { support: updated };
}

async function createAvatarForAdmin({ url, sortOrder, active }) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    const err = new Error('INVALID_AVATAR_URL');
    err.code = 'INVALID_AVATAR_URL';
    throw err;
  }
  const parsedSortOrder = sortOrder == null ? 0 : Number(sortOrder);
  if (!Number.isInteger(parsedSortOrder) || parsedSortOrder < 0) {
    const err = new Error('INVALID_SORT_ORDER');
    err.code = 'INVALID_SORT_ORDER';
    throw err;
  }
  const parsedActive = active == null ? true : toBooleanStrict(active, 'INVALID_ACTIVE_FLAG');
  const avatar = await avatarModel.createAvatar({
    url: normalizedUrl,
    sortOrder: parsedSortOrder,
    active: parsedActive,
  });
  return { avatar };
}

async function createAddCashOptionForAdmin({
  baseAmount,
  instantCash,
  bonus,
  isHot,
  active,
  sortOrder,
}) {
  const parsedBaseAmount = Number(baseAmount);
  if (!Number.isFinite(parsedBaseAmount) || parsedBaseAmount <= 0) {
    const err = new Error('INVALID_BASE_AMOUNT');
    err.code = 'INVALID_BASE_AMOUNT';
    throw err;
  }
  const parsedInstantCash = instantCash == null ? 0 : Number(instantCash);
  const parsedBonus = bonus == null ? 0 : Number(bonus);
  if (!Number.isFinite(parsedInstantCash) || parsedInstantCash < 0) {
    const err = new Error('INVALID_INSTANT_CASH');
    err.code = 'INVALID_INSTANT_CASH';
    throw err;
  }
  if (!Number.isFinite(parsedBonus) || parsedBonus < 0) {
    const err = new Error('INVALID_BONUS');
    err.code = 'INVALID_BONUS';
    throw err;
  }
  const parsedSortOrder = sortOrder == null ? 0 : Number(sortOrder);
  if (!Number.isInteger(parsedSortOrder) || parsedSortOrder < 0) {
    const err = new Error('INVALID_SORT_ORDER');
    err.code = 'INVALID_SORT_ORDER';
    throw err;
  }

  const option = await addCashOptionModel.createOption({
    baseAmount: parsedBaseAmount,
    instantCash: parsedInstantCash,
    bonus: parsedBonus,
    isHot: isHot == null ? false : toBooleanStrict(isHot, 'INVALID_IS_HOT'),
    active: active == null ? true : toBooleanStrict(active, 'INVALID_ACTIVE_FLAG'),
    sortOrder: parsedSortOrder,
  });
  return { add_cash_option: option };
}

async function createWithdrawOptionForAdmin({
  amount,
  minKycLevel,
  isHot,
  active,
  sortOrder,
}) {
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    const err = new Error('INVALID_WITHDRAW_AMOUNT');
    err.code = 'INVALID_WITHDRAW_AMOUNT';
    throw err;
  }
  const normalizedKycLevel = String(minKycLevel || 'none').trim().toLowerCase();
  if (!['none', 'basic', 'full'].includes(normalizedKycLevel)) {
    const err = new Error('INVALID_MIN_KYC_LEVEL');
    err.code = 'INVALID_MIN_KYC_LEVEL';
    throw err;
  }
  const parsedSortOrder = sortOrder == null ? 0 : Number(sortOrder);
  if (!Number.isInteger(parsedSortOrder) || parsedSortOrder < 0) {
    const err = new Error('INVALID_SORT_ORDER');
    err.code = 'INVALID_SORT_ORDER';
    throw err;
  }

  const option = await withdrawOptionModel.createOption({
    amount: parsedAmount,
    minKycLevel: normalizedKycLevel,
    isHot: isHot == null ? false : toBooleanStrict(isHot, 'INVALID_IS_HOT'),
    active: active == null ? true : toBooleanStrict(active, 'INVALID_ACTIVE_FLAG'),
    sortOrder: parsedSortOrder,
  });
  return { withdraw_option: option };
}

async function createFaqForAdmin({
  question,
  answer,
  active,
  sortOrder,
}) {
  const normalizedQuestion = String(question || '').trim();
  const normalizedAnswer = String(answer || '').trim();
  if (!normalizedQuestion) {
    const err = new Error('INVALID_FAQ_QUESTION');
    err.code = 'INVALID_FAQ_QUESTION';
    throw err;
  }
  if (!normalizedAnswer) {
    const err = new Error('INVALID_FAQ_ANSWER');
    err.code = 'INVALID_FAQ_ANSWER';
    throw err;
  }
  const parsedSortOrder = sortOrder == null ? 0 : Number(sortOrder);
  if (!Number.isInteger(parsedSortOrder) || parsedSortOrder < 0) {
    const err = new Error('INVALID_SORT_ORDER');
    err.code = 'INVALID_SORT_ORDER';
    throw err;
  }
  const faq = await faqModel.createFaq({
    question: normalizedQuestion,
    answer: normalizedAnswer,
    active: active == null ? true : toBooleanStrict(active, 'INVALID_ACTIVE_FLAG'),
    sortOrder: parsedSortOrder,
  });
  return { faq };
}

async function createSupportForAdmin({
  key,
  title,
  imageUrl,
  redirectUrl,
  active,
  sortOrder,
}) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const normalizedTitle = String(title || '').trim();
  const normalizedRedirectUrl = String(redirectUrl || '').trim();
  if (!normalizedKey) {
    const err = new Error('INVALID_SUPPORT_KEY');
    err.code = 'INVALID_SUPPORT_KEY';
    throw err;
  }
  if (!normalizedTitle) {
    const err = new Error('INVALID_SUPPORT_TITLE');
    err.code = 'INVALID_SUPPORT_TITLE';
    throw err;
  }
  if (!normalizedRedirectUrl) {
    const err = new Error('INVALID_SUPPORT_REDIRECT_URL');
    err.code = 'INVALID_SUPPORT_REDIRECT_URL';
    throw err;
  }
  const parsedSortOrder = sortOrder == null ? 0 : Number(sortOrder);
  if (!Number.isInteger(parsedSortOrder) || parsedSortOrder < 0) {
    const err = new Error('INVALID_SORT_ORDER');
    err.code = 'INVALID_SORT_ORDER';
    throw err;
  }

  try {
    const support = await supportLinkModel.createSupport({
      key: normalizedKey,
      title: normalizedTitle,
      imageUrl: imageUrl == null ? null : String(imageUrl).trim(),
      redirectUrl: normalizedRedirectUrl,
      active: active == null ? true : toBooleanStrict(active, 'INVALID_ACTIVE_FLAG'),
      sortOrder: parsedSortOrder,
    });
    return { support };
  } catch (err) {
    if (err && err.code === '23505') {
      const error = new Error('SUPPORT_KEY_ALREADY_EXISTS');
      error.code = 'SUPPORT_KEY_ALREADY_EXISTS';
      throw error;
    }
    throw err;
  }
}

async function listKycApplications({
  page = 1,
  limit = 20,
  status,
  search,
  state,
  active,
  dateFrom,
  dateTo,
} = {}) {
  const normalizedStatus = normalizeKycStatusFilter(status);
  const normalizedActive = active == null || active === '' ? null : toBool(active);
  if (active != null && active !== '' && normalizedActive == null) {
    const err = new Error('INVALID_ACTIVE_FLAG');
    err.code = 'INVALID_ACTIVE_FLAG';
    throw err;
  }

  const normalizedSearch = search == null ? null : String(search).trim();
  const normalizedState = state == null ? null : String(state).trim();
  const normalizedDateFrom = normalizeDateFilter(dateFrom, 'INVALID_DATE_FROM');
  const normalizedDateTo = normalizeDateFilter(dateTo, 'INVALID_DATE_TO');

  const { items, total } = await kycModel.listForAdmin({
    page,
    limit,
    status: normalizedStatus,
    search: normalizedSearch || null,
    state: normalizedState || null,
    active: normalizedActive,
    dateFrom: normalizedDateFrom,
    dateTo: normalizedDateTo,
  });

  return {
    kyc: items.map(kycModel.formatAdminListItem),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    filters: {
      status: status == null || String(status).trim() === '' ? 'all' : String(status).trim().toLowerCase(),
      search: normalizedSearch || null,
      state: normalizedState || null,
      active: normalizedActive,
      date_from: normalizedDateFrom,
      date_to: normalizedDateTo,
    },
  };
}

async function updateUserActiveStatus({ userId, active }) {
  const normalizedActive = toBool(active);
  if (normalizedActive == null) {
    const err = new Error('INVALID_ACTIVE_FLAG');
    err.code = 'INVALID_ACTIVE_FLAG';
    throw err;
  }

  const updatedUser = await userModel.updateActiveStatus(userId, normalizedActive);
  if (!updatedUser) {
    const err = new Error('USER_NOT_FOUND');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  return {
    id: updatedUser.id,
    phone: updatedUser.phone,
    active: updatedUser.active,
    updated_at: updatedUser.updated_at,
  };
}

async function updateUserKycStatus({ userId, status, rejectionNote }) {
  const allowed = new Set(['submitted', 'approved', 'rejected']);
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!allowed.has(normalizedStatus)) {
    const err = new Error('INVALID_KYC_STATUS');
    err.code = 'INVALID_KYC_STATUS';
    throw err;
  }

  const kyc = await kycModel.findByUserId(userId);
  if (!kyc) {
    const err = new Error('KYC_NOT_FOUND');
    err.code = 'KYC_NOT_FOUND';
    throw err;
  }

  const note = rejectionNote == null ? null : String(rejectionNote).trim();
  const finalNote = normalizedStatus === 'rejected' ? (note || null) : null;

  const updated = await kycModel.adminUpdateStatusByUserId({
    userId,
    status: normalizedStatus,
    rejectionNote: finalNote,
  });

  // Best-effort user notification when admin approves/rejects KYC.
  try {
    if (normalizedStatus === 'approved') {
      await notificationService.createNotification(userId, {
        title: 'KYC Approved',
        content: 'Your KYC has been approved successfully.',
        type: 'system',
        metadata: { kyc_status: 'approved' },
      });
    } else if (normalizedStatus === 'rejected') {
      const reason = finalNote ? ` Reason: ${finalNote}` : '';
      await notificationService.createNotification(userId, {
        title: 'KYC Rejected',
        content: `Your KYC has been rejected.${reason}`,
        type: 'system',
        metadata: { kyc_status: 'rejected', rejection_note: finalNote },
      });
    }
  } catch (notifyErr) {
    console.error('updateUserKycStatus notification error:', notifyErr);
  }

  return kycModel.formatForResponse(updated);
}

async function getUserDetailsById(userId) {
  const user = await userModel.findById(userId);
  if (!user) {
    const err = new Error('USER_NOT_FOUND');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const [kyc, wallet] = await Promise.all([
    kycModel.findByUserId(userId),
    walletModel.getOrCreateByUserId(userId),
  ]);

  return {
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      avatar: user.avatar,
      view_id: user.view_id,
      is_verified: user.is_verified ?? false,
      active: user.active !== false,
      created_at: user.created_at,
      updated_at: user.updated_at,
    },
    kyc_details: kyc ? kycModel.formatForResponse(kyc) : null,
    wallet,
  };
}

function normalizeAppUpdatePlatform(platform) {
  const normalized = String(platform || '').trim().toLowerCase();
  if (normalized === 'android' || normalized === 'ios') return normalized;
  const err = new Error('INVALID_APP_UPDATE_PLATFORM');
  err.code = 'INVALID_APP_UPDATE_PLATFORM';
  throw err;
}

function normalizeAppVersionField(value, code) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  return normalized;
}

function compareSemver(a, b) {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (aParts[i] > bParts[i]) return 1;
    if (aParts[i] < bParts[i]) return -1;
  }
  return 0;
}

const APP_UPDATE_RETAINED_VERSION_COUNT = 3;

function toAppUpdateBuildResponse(build) {
  if (!build) return null;
  return {
    id: build.id,
    platform: build.platform,
    version: build.version,
    url: build.download_url,
    s3_key: build.s3_key,
    release_notes: build.release_notes || '',
    file_name: build.file_name || null,
    mime_type: build.mime_type || null,
    size_bytes: Number(build.size_bytes || 0),
    uploaded_by: build.uploaded_by || null,
    created_at: build.created_at || null,
    updated_at: build.updated_at || null,
    is_deleted: build.is_deleted === true,
    deleted_at: build.deleted_at || null,
    deleted_by: build.deleted_by || null,
    delete_reason: build.delete_reason || null,
    metadata: build.metadata || {},
  };
}

function classifyBuildRows(builds = []) {
  const keepers = (Array.isArray(builds) ? builds : []).slice(0, APP_UPDATE_RETAINED_VERSION_COUNT);
  const old = (Array.isArray(builds) ? builds : []).slice(APP_UPDATE_RETAINED_VERSION_COUNT);
  return {
    keepers,
    old,
  };
}

async function getAppUpdateConfigForAdmin() {
  const rows = await appUpdateConfigModel.listAll();
  const buildsByPlatformEntries = await Promise.all(
    rows.map(async (row) => {
      const builds = await appUpdateBuildModel.listBuildsByPlatform(row.platform, { includeDeleted: false });
      const { keepers, old } = classifyBuildRows(builds);
      return [row.platform, {
        current: toAppUpdateBuildResponse(keepers[0] || null),
        previous: keepers.slice(1, 3).map(toAppUpdateBuildResponse),
        old_count: old.length,
        can_delete_old: old.length > 0,
      }];
    })
  );

  const buildsByPlatform = Object.fromEntries(buildsByPlatformEntries);

  return {
    app_update: rows.reduce((acc, row) => {
      acc[row.platform] = {
        latest: row.latest,
        minimum: row.minimum,
        url: row.url,
        release_notes: row.release_notes || '',
        enabled: row.enabled === true,
        metadata: row.metadata || {},
        updated_by: row.updated_by || null,
        updated_at: row.updated_at || null,
        versions_summary: buildsByPlatform[row.platform] || {
          current: null,
          previous: [],
          old_count: 0,
          can_delete_old: false,
        },
      };
      return acc;
    }, {}),
  };
}

async function updateAppUpdateConfigForAdmin({
  platform,
  latest,
  minimum,
  url,
  releaseNotes,
  enabled,
  metadata,
  updatedBy,
}) {
  const normalizedPlatform = normalizeAppUpdatePlatform(platform);
  const normalizedLatest = normalizeAppVersionField(latest, 'INVALID_APP_UPDATE_LATEST');
  const normalizedMinimum = normalizeAppVersionField(minimum, 'INVALID_APP_UPDATE_MINIMUM');
  if (compareSemver(normalizedMinimum, normalizedLatest) > 0) {
    const err = new Error('INVALID_APP_UPDATE_VERSION_RANGE');
    err.code = 'INVALID_APP_UPDATE_VERSION_RANGE';
    throw err;
  }
  const normalizedEnabled = toBooleanStrict(enabled, 'INVALID_APP_UPDATE_ENABLED');
  const normalizedUrl = String(url || '').trim();
  if (normalizedEnabled && !normalizedUrl) {
    const err = new Error('INVALID_APP_UPDATE_URL');
    err.code = 'INVALID_APP_UPDATE_URL';
    throw err;
  }
  const updated = await appUpdateConfigModel.upsertByPlatform({
    platform: normalizedPlatform,
    latest: normalizedLatest,
    minimum: normalizedMinimum,
    url: normalizedUrl,
    releaseNotes: releaseNotes == null ? '' : String(releaseNotes).trim(),
    enabled: normalizedEnabled,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    updatedBy: updatedBy == null ? null : normalizeIntegerFilter(updatedBy, 'INVALID_UPDATED_BY_ADMIN_ID'),
  });

  return {
    app_update: {
      platform: updated.platform,
      latest: updated.latest,
      minimum: updated.minimum,
      url: updated.url,
      release_notes: updated.release_notes || '',
      enabled: updated.enabled === true,
      metadata: updated.metadata || {},
      updated_by: updated.updated_by || null,
      updated_at: updated.updated_at || null,
    },
  };
}

async function uploadAppUpdateApkForAdmin({
  file,
  platform,
  version,
  minimum,
  releaseNotes,
  enabled,
  updatedBy,
}) {
  if (!file || !file.buffer) {
    const err = new Error('APK_FILE_REQUIRED');
    err.code = 'APK_FILE_REQUIRED';
    throw err;
  }

  const normalizedPlatform = normalizeAppUpdatePlatform(platform);
  const latest = normalizeAppVersionField(version, 'INVALID_APP_UPDATE_LATEST');
  const minimumVersion = minimum == null || String(minimum).trim() === ''
    ? latest
    : normalizeAppVersionField(minimum, 'INVALID_APP_UPDATE_MINIMUM');

  if (compareSemver(minimumVersion, latest) > 0) {
    const err = new Error('INVALID_APP_UPDATE_VERSION_RANGE');
    err.code = 'INVALID_APP_UPDATE_VERSION_RANGE';
    throw err;
  }

  const mimeType = String(file.mimetype || '').toLowerCase();
  const originalName = String(file.originalname || '').toLowerCase();
  const isMimeApk = mimeType === 'application/vnd.android.package-archive' || mimeType === 'application/octet-stream';
  const isApkExt = originalName.endsWith('.apk');
  if (normalizedPlatform === 'android' && (!isMimeApk || !isApkExt)) {
    const err = new Error('INVALID_APK_FILE_TYPE');
    err.code = 'INVALID_APK_FILE_TYPE';
    throw err;
  }
  if (normalizedPlatform === 'ios') {
    const err = new Error('IOS_BINARY_UPLOAD_NOT_SUPPORTED');
    err.code = 'IOS_BINARY_UPLOAD_NOT_SUPPORTED';
    throw err;
  }

  const timestamp = Date.now();
  const key = `apks/${normalizedPlatform}/app-v${latest}-${timestamp}.apk`;
  const uploaded = await uploadService.uploadBufferWithKey({
    buffer: file.buffer,
    mimeType: 'application/vnd.android.package-archive',
    key,
  });

  const normalizedEnabled = enabled == null ? true : toBooleanStrict(enabled, 'INVALID_APP_UPDATE_ENABLED');
  const updated = await appUpdateConfigModel.upsertByPlatform({
    platform: normalizedPlatform,
    latest,
    minimum: minimumVersion,
    url: uploaded.publicUrl,
    releaseNotes: releaseNotes == null ? '' : String(releaseNotes).trim(),
    enabled: normalizedEnabled,
    metadata: {
      s3_key: uploaded.key,
      uploaded_file_name: file.originalname || null,
      uploaded_mime_type: file.mimetype || null,
      uploaded_size: Number(file.size || 0),
    },
    updatedBy: updatedBy == null ? null : normalizeIntegerFilter(updatedBy, 'INVALID_UPDATED_BY_ADMIN_ID'),
  });

  const build = await appUpdateBuildModel.createBuild({
    platform: normalizedPlatform,
    version: latest,
    downloadUrl: uploaded.publicUrl,
    s3Key: uploaded.key,
    releaseNotes: releaseNotes == null ? '' : String(releaseNotes).trim(),
    fileName: file.originalname || null,
    mimeType: file.mimetype || null,
    sizeBytes: Number(file.size || 0),
    uploadedBy: updatedBy == null ? null : normalizeIntegerFilter(updatedBy, 'INVALID_UPDATED_BY_ADMIN_ID'),
    metadata: {
      source: 'admin_upload_apk',
    },
  });

  const activeBuilds = await appUpdateBuildModel.listBuildsByPlatform(normalizedPlatform, { includeDeleted: false });
  const { keepers, old } = classifyBuildRows(activeBuilds);

  return {
    app_update: {
      platform: updated.platform,
      latest: updated.latest,
      minimum: updated.minimum,
      url: updated.url,
      release_notes: updated.release_notes || '',
      enabled: updated.enabled === true,
      metadata: updated.metadata || {},
      updated_by: updated.updated_by || null,
      updated_at: updated.updated_at || null,
    },
    upload: {
      key: uploaded.key,
      public_url: uploaded.publicUrl,
      size_bytes: Number(file.size || 0),
    },
    build: toAppUpdateBuildResponse(build),
    versions_summary: {
      current: toAppUpdateBuildResponse(keepers[0] || null),
      previous: keepers.slice(1, 3).map(toAppUpdateBuildResponse),
      old_count: old.length,
      can_delete_old: old.length > 0,
    },
  };
}

async function listAppUpdateVersionsForAdmin({ platform }) {
  const normalizedPlatform = normalizeAppUpdatePlatform(platform);
  const builds = await appUpdateBuildModel.listBuildsByPlatform(normalizedPlatform, { includeDeleted: true });
  const activeBuilds = builds.filter((item) => item.is_deleted !== true);
  const { keepers, old } = classifyBuildRows(activeBuilds);
  const current = keepers[0] || null;
  const currentIds = new Set(keepers.map((item) => item.id));

  const versions = builds.map((item) => ({
    ...toAppUpdateBuildResponse(item),
    retention_bucket: item.is_deleted
      ? 'deleted'
      : (currentIds.has(item.id) ? 'retained' : 'old'),
    is_current: current ? Number(item.id) === Number(current.id) : false,
  }));

  return {
    platform: normalizedPlatform,
    current: toAppUpdateBuildResponse(current),
    previous: keepers.slice(1, 3).map(toAppUpdateBuildResponse),
    old_count: old.length,
    can_delete_old: old.length > 0,
    keep_limit: APP_UPDATE_RETAINED_VERSION_COUNT,
    versions,
  };
}

async function deleteOldAppUpdateVersionsForAdmin({
  platform,
  deletedBy,
}) {
  const normalizedPlatform = normalizeAppUpdatePlatform(platform);
  const normalizedDeletedBy = deletedBy == null ? null : normalizeIntegerFilter(deletedBy, 'INVALID_UPDATED_BY_ADMIN_ID');

  const config = await appUpdateConfigModel.getByPlatform(normalizedPlatform);
  const activeBuilds = await appUpdateBuildModel.listBuildsByPlatform(normalizedPlatform, { includeDeleted: false });
  const { keepers, old } = classifyBuildRows(activeBuilds);
  const protectedUrls = new Set([config?.url].filter(Boolean));
  const protectedKeys = new Set([config?.metadata?.s3_key].filter(Boolean));

  const candidates = old.filter((item) => (
    !protectedUrls.has(item.download_url) && !protectedKeys.has(item.s3_key)
  ));
  const skippedProtected = old
    .filter((item) => protectedUrls.has(item.download_url) || protectedKeys.has(item.s3_key))
    .map((item) => Number(item.id));

  const deletedIds = [];
  const s3DeletedKeys = [];
  const s3DeleteFailures = [];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await uploadService.deleteObjectByKey(candidate.s3_key);
      s3DeletedKeys.push(candidate.s3_key);
    } catch (err) {
      s3DeleteFailures.push({
        build_id: Number(candidate.id),
        s3_key: candidate.s3_key,
        reason: err?.message || 'S3_DELETE_FAILED',
      });
      // Avoid marking row deleted when S3 delete failed.
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const marked = await appUpdateBuildModel.markBuildDeleted({
      id: candidate.id,
      deletedBy: normalizedDeletedBy,
      reason: 'manual_delete_old_versions',
      metadataPatch: {
        deleted_via: 'admin_delete_old',
      },
    });
    if (marked) {
      deletedIds.push(Number(marked.id));
    }
  }

  const refreshed = await listAppUpdateVersionsForAdmin({ platform: normalizedPlatform });
  return {
    platform: normalizedPlatform,
    requested_old_count: old.length,
    deleted_count: deletedIds.length,
    deleted_build_ids: deletedIds,
    skipped_protected_build_ids: skippedProtected,
    failed_s3_deletes: s3DeleteFailures,
    deleted_s3_keys: s3DeletedKeys,
    retained: {
      current: toAppUpdateBuildResponse(keepers[0] || null),
      previous: keepers.slice(1, 3).map(toAppUpdateBuildResponse),
      keep_limit: APP_UPDATE_RETAINED_VERSION_COUNT,
    },
    versions_summary: {
      old_count: refreshed.old_count,
      can_delete_old: refreshed.can_delete_old,
    },
  };
}

function normalizeSupportTicketStatus(status) {
  if (status == null || String(status).trim() === '') return 'all';
  const normalized = String(status).trim().toLowerCase();
  if (['all', 'open', 'in_review', 'resolved', 'rejected'].includes(normalized)) return normalized;
  const err = new Error('INVALID_SUPPORT_STATUS_FILTER');
  err.code = 'INVALID_SUPPORT_STATUS_FILTER';
  throw err;
}

async function listReportFeedbackForAdmin({
  page = 1,
  limit = 20,
  type,
  status,
  userId,
  phone,
  search,
  dateFrom,
  dateTo,
} = {}) {
  const normalizedType = String(type || '').trim().toLowerCase();
  if (!['withdrawal', 'bug_report'].includes(normalizedType)) {
    const err = new Error('INVALID_REPORT_FEEDBACK_TYPE');
    err.code = 'INVALID_REPORT_FEEDBACK_TYPE';
    throw err;
  }

  const normalizedStatus = normalizeSupportTicketStatus(status);
  const normalizedUserId = normalizeIntegerFilter(userId, 'INVALID_USER_ID_FILTER');
  const normalizedPhone = phone == null ? null : String(phone).trim();
  const normalizedSearch = search == null ? null : String(search).trim();
  const normalizedDateFrom = normalizeOptionalDate(dateFrom, 'INVALID_DATE_FROM');
  const normalizedDateTo = normalizeOptionalDate(dateTo, 'INVALID_DATE_TO');

  const where = ['rf.type = $1'];
  const params = [normalizedType];
  let idx = 2;

  if (normalizedStatus !== 'all') {
    where.push(`rf.status = $${idx++}`);
    params.push(normalizedStatus);
  }
  if (normalizedUserId != null) {
    where.push(`rf.user_id = $${idx++}`);
    params.push(normalizedUserId);
  }
  if (normalizedPhone) {
    where.push(`COALESCE(rf.phone, u.phone, '') ILIKE $${idx++}`);
    params.push(`%${normalizedPhone}%`);
  }
  if (normalizedSearch) {
    where.push(`rf.feedback_content ILIKE $${idx++}`);
    params.push(`%${normalizedSearch}%`);
  }
  if (normalizedDateFrom) {
    where.push(`rf.created_at >= $${idx++}`);
    params.push(normalizedDateFrom);
  }
  if (normalizedDateTo) {
    where.push(`rf.created_at <= $${idx++}`);
    params.push(normalizedDateTo);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const fromJoin = `
    FROM reports_feedback rf
    LEFT JOIN users u ON u.id = rf.user_id
    ${whereClause}
  `;

  const countResult = await query(`SELECT COUNT(*)::int AS total ${fromJoin}`, params);
  const total = Number(countResult.rows[0]?.total || 0);

  const offset = (page - 1) * limit;
  const listResult = await query(
    `SELECT
       rf.*,
       u.name AS user_name,
       u.phone AS user_phone,
       u.view_id AS user_view_id
     ${fromJoin}
     ORDER BY rf.created_at DESC, rf.id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...params, limit, offset]
  );

  return {
    feedback: listResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      feedback_content: row.feedback_content,
      picture_urls: row.picture_urls || [],
      status: row.status,
      admin_notes: row.admin_notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
      user: {
        id: row.user_id,
        name: row.user_name || null,
        phone: row.user_phone || row.phone || null,
        view_id: row.user_view_id || null,
      },
    })),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    filters: {
      type: normalizedType,
      status: normalizedStatus,
      user_id: normalizedUserId,
      phone: normalizedPhone || null,
      search: normalizedSearch || null,
      date_from: normalizedDateFrom,
      date_to: normalizedDateTo,
    },
  };
}

async function listAddCashComplaintsForAdmin({
  page = 1,
  limit = 20,
  status,
  userId,
  phone,
  cashTransactionId,
  utrNo,
  dateFrom,
  dateTo,
} = {}) {
  const normalizedStatus = normalizeSupportTicketStatus(status);
  const normalizedUserId = normalizeIntegerFilter(userId, 'INVALID_USER_ID_FILTER');
  const normalizedPhone = phone == null ? null : String(phone).trim();
  const normalizedCashTransactionId = cashTransactionId == null ? null : String(cashTransactionId).trim();
  const normalizedUtrNo = utrNo == null ? null : String(utrNo).trim();
  const normalizedDateFrom = normalizeOptionalDate(dateFrom, 'INVALID_DATE_FROM');
  const normalizedDateTo = normalizeOptionalDate(dateTo, 'INVALID_DATE_TO');

  const where = [];
  const params = [];
  let idx = 1;

  if (normalizedStatus !== 'all') {
    where.push(`acc.status = $${idx++}`);
    params.push(normalizedStatus);
  }
  if (normalizedUserId != null) {
    where.push(`acc.user_id = $${idx++}`);
    params.push(normalizedUserId);
  }
  if (normalizedPhone) {
    where.push(`COALESCE(acc.phone, u.phone, '') ILIKE $${idx++}`);
    params.push(`%${normalizedPhone}%`);
  }
  if (normalizedCashTransactionId) {
    where.push(`acc.cash_transaction_id ILIKE $${idx++}`);
    params.push(`%${normalizedCashTransactionId}%`);
  }
  if (normalizedUtrNo) {
    where.push(`COALESCE(acc.utr_no, '') ILIKE $${idx++}`);
    params.push(`%${normalizedUtrNo}%`);
  }
  if (normalizedDateFrom) {
    where.push(`acc.created_at >= $${idx++}`);
    params.push(normalizedDateFrom);
  }
  if (normalizedDateTo) {
    where.push(`acc.created_at <= $${idx++}`);
    params.push(normalizedDateTo);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const fromJoin = `
    FROM add_cash_complaints acc
    LEFT JOIN users u ON u.id = acc.user_id
    LEFT JOIN recharge_transactions rt ON rt.id = acc.recharge_transaction_id
    ${whereClause}
  `;

  const countResult = await query(`SELECT COUNT(*)::int AS total ${fromJoin}`, params);
  const total = Number(countResult.rows[0]?.total || 0);

  const offset = (page - 1) * limit;
  const listResult = await query(
    `SELECT
       acc.*,
       u.name AS user_name,
       u.phone AS user_phone,
       u.view_id AS user_view_id,
       rt.order_id AS recharge_order_id,
       rt.status AS recharge_status
     ${fromJoin}
     ORDER BY acc.created_at DESC, acc.id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...params, limit, offset]
  );

  return {
    complaints: listResult.rows.map((row) => ({
      id: row.id,
      cash_transaction_id: row.cash_transaction_id,
      recharge_transaction_id: row.recharge_transaction_id,
      payment_proof_image_url: row.payment_proof_image_url,
      utr_no: row.utr_no,
      payment_time: row.payment_time,
      status: row.status,
      admin_notes: row.admin_notes,
      phone: row.phone,
      created_at: row.created_at,
      updated_at: row.updated_at,
      user: {
        id: row.user_id,
        name: row.user_name || null,
        phone: row.user_phone || row.phone || null,
        view_id: row.user_view_id || null,
      },
      recharge: row.recharge_transaction_id ? {
        id: row.recharge_transaction_id,
        order_id: row.recharge_order_id || null,
        status: row.recharge_status || null,
      } : null,
    })),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    filters: {
      status: normalizedStatus,
      user_id: normalizedUserId,
      phone: normalizedPhone || null,
      cash_transaction_id: normalizedCashTransactionId || null,
      utr_no: normalizedUtrNo || null,
      date_from: normalizedDateFrom,
      date_to: normalizedDateTo,
    },
  };
}

async function getReportFeedbackDetailsForAdmin({ feedbackId, type }) {
  const id = normalizeIntegerFilter(feedbackId, 'INVALID_REPORT_FEEDBACK_ID');
  const normalizedType = String(type || '').trim().toLowerCase();
  if (!['withdrawal', 'bug_report'].includes(normalizedType)) {
    const err = new Error('INVALID_REPORT_FEEDBACK_TYPE');
    err.code = 'INVALID_REPORT_FEEDBACK_TYPE';
    throw err;
  }

  const result = await query(
    `SELECT
       rf.*,
       u.name AS user_name,
       u.phone AS user_phone,
       u.view_id AS user_view_id
     FROM reports_feedback rf
     LEFT JOIN users u ON u.id = rf.user_id
     WHERE rf.id = $1
       AND rf.type = $2
     LIMIT 1`,
    [id, normalizedType]
  );

  const row = result.rows[0] || null;
  if (!row) {
    const err = new Error('REPORT_FEEDBACK_NOT_FOUND');
    err.code = 'REPORT_FEEDBACK_NOT_FOUND';
    throw err;
  }

  return {
    feedback: {
      id: row.id,
      type: row.type,
      feedback_content: row.feedback_content,
      picture_urls: row.picture_urls || [],
      status: row.status,
      admin_notes: row.admin_notes,
      phone: row.phone,
      created_at: row.created_at,
      updated_at: row.updated_at,
      user: {
        id: row.user_id,
        name: row.user_name || null,
        phone: row.user_phone || row.phone || null,
        view_id: row.user_view_id || null,
      },
    },
  };
}

async function updateReportFeedbackStatusForAdmin({ feedbackId, type, status, adminNotes }) {
  const id = normalizeIntegerFilter(feedbackId, 'INVALID_REPORT_FEEDBACK_ID');
  const normalizedType = String(type || '').trim().toLowerCase();
  if (!['withdrawal', 'bug_report'].includes(normalizedType)) {
    const err = new Error('INVALID_REPORT_FEEDBACK_TYPE');
    err.code = 'INVALID_REPORT_FEEDBACK_TYPE';
    throw err;
  }

  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!['open', 'in_review', 'resolved', 'rejected'].includes(normalizedStatus)) {
    const err = new Error('INVALID_SUPPORT_STATUS_UPDATE');
    err.code = 'INVALID_SUPPORT_STATUS_UPDATE';
    throw err;
  }

  const normalizedAdminNotes = adminNotes == null ? null : String(adminNotes).trim();
  const result = await query(
    `UPDATE reports_feedback
     SET status = $1,
         admin_notes = $2,
         updated_at = NOW()
     WHERE id = $3
       AND type = $4
     RETURNING *`,
    [normalizedStatus, normalizedAdminNotes || null, id, normalizedType]
  );
  const row = result.rows[0] || null;
  if (!row) {
    const err = new Error('REPORT_FEEDBACK_NOT_FOUND');
    err.code = 'REPORT_FEEDBACK_NOT_FOUND';
    throw err;
  }

  return { feedback: row };
}

async function getAddCashComplaintDetailsForAdmin({ complaintId }) {
  const id = normalizeIntegerFilter(complaintId, 'INVALID_ADD_CASH_COMPLAINT_ID');
  const result = await query(
    `SELECT
       acc.*,
       u.name AS user_name,
       u.phone AS user_phone,
       u.view_id AS user_view_id,
       rt.order_id AS recharge_order_id,
       rt.status AS recharge_status
     FROM add_cash_complaints acc
     LEFT JOIN users u ON u.id = acc.user_id
     LEFT JOIN recharge_transactions rt ON rt.id = acc.recharge_transaction_id
     WHERE acc.id = $1
     LIMIT 1`,
    [id]
  );
  const row = result.rows[0] || null;
  if (!row) {
    const err = new Error('ADD_CASH_COMPLAINT_NOT_FOUND');
    err.code = 'ADD_CASH_COMPLAINT_NOT_FOUND';
    throw err;
  }

  return {
    complaint: {
      id: row.id,
      cash_transaction_id: row.cash_transaction_id,
      recharge_transaction_id: row.recharge_transaction_id,
      payment_proof_image_url: row.payment_proof_image_url,
      utr_no: row.utr_no,
      payment_time: row.payment_time,
      status: row.status,
      admin_notes: row.admin_notes,
      phone: row.phone,
      created_at: row.created_at,
      updated_at: row.updated_at,
      user: {
        id: row.user_id,
        name: row.user_name || null,
        phone: row.user_phone || row.phone || null,
        view_id: row.user_view_id || null,
      },
      recharge: row.recharge_transaction_id ? {
        id: row.recharge_transaction_id,
        order_id: row.recharge_order_id || null,
        status: row.recharge_status || null,
      } : null,
    },
  };
}

async function updateAddCashComplaintStatusForAdmin({ complaintId, status, adminNotes }) {
  const id = normalizeIntegerFilter(complaintId, 'INVALID_ADD_CASH_COMPLAINT_ID');
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!['open', 'in_review', 'resolved', 'rejected'].includes(normalizedStatus)) {
    const err = new Error('INVALID_SUPPORT_STATUS_UPDATE');
    err.code = 'INVALID_SUPPORT_STATUS_UPDATE';
    throw err;
  }

  const normalizedAdminNotes = adminNotes == null ? null : String(adminNotes).trim();
  const result = await query(
    `UPDATE add_cash_complaints
     SET status = $1,
         admin_notes = $2,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [normalizedStatus, normalizedAdminNotes || null, id]
  );
  const row = result.rows[0] || null;
  if (!row) {
    const err = new Error('ADD_CASH_COMPLAINT_NOT_FOUND');
    err.code = 'ADD_CASH_COMPLAINT_NOT_FOUND';
    throw err;
  }
  return { complaint: row };
}

module.exports = {
  createAddCashOptionForAdmin,
  createAvatarForAdmin,
  createFaqForAdmin,
  createSupportForAdmin,
  createWithdrawOptionForAdmin,
  getAppSettingsForAdmin,
  getMaintenanceModeForAdmin,
  getRechargeDetailsForAdmin,
  getGameHistoryDetailsForAdmin,
  getUserDetailsById,
  getAppUpdateConfigForAdmin,
  listAppUpdateVersionsForAdmin,
  uploadAppUpdateApkForAdmin,
  deleteOldAppUpdateVersionsForAdmin,
  updateAvatarActiveForAdmin,
  updateAddCashOptionActiveForAdmin,
  updateWithdrawOptionActiveForAdmin,
  updateFaqActiveForAdmin,
  updateSupportForAdmin,
  updateAppUpdateConfigForAdmin,
  updateMaintenanceModeForAdmin,
  listRechargesForAdmin,
  listWalletTransactionsForAdmin,
  listGamesHistoryForAdmin,
  listReportFeedbackForAdmin,
  listAddCashComplaintsForAdmin,
  getReportFeedbackDetailsForAdmin,
  updateReportFeedbackStatusForAdmin,
  getAddCashComplaintDetailsForAdmin,
  updateAddCashComplaintStatusForAdmin,
  listKycApplications,
  updateUserActiveStatus,
  updateUserKycStatus,
};

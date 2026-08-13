const userModel = require('../models/user.model');
const kycModel = require('../models/kyc.model');
const walletModel = require('../models/wallet.model');
const rewardsService = require('./rewards.service');

/** Shared user/profile shape – user only, no key_details inside. */
function formatProfile(user) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    avatar: user.avatar,
    view_id: user.view_id,
    is_verified: user.is_verified ?? false,
  };
}

/** Admin-facing profile shape – includes joining date and live play / activity flags. */
function formatAdminProfile(user) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    avatar: user.avatar,
    view_id: user.view_id,
    is_verified: user.is_verified ?? false,
    active: user.active !== false,
    created_at: user.created_at,
    onboard_at: user.onboard_at || user.created_at || null,
    updated_at: user.updated_at || null,
    is_playing: user.is_playing === true,
    session_status: user.session_status || null,
    player_status: user.player_status || null,
    last_gameplay_at: user.last_gameplay_at || null,
    last_socket_at: user.last_socket_at || null,
    last_activity_at: user.last_activity_at || user.last_socket_at || null,
    last_successful_withdrawal_at: user.last_successful_withdrawal_at || null,
  };
}

/**
 * Build profile response.
 * - If first arg has { user, ... } shape, pass through nested objects (e.g. key_details, wallet).
 * - Else treat as raw user (e.g. auth) and wrap into { user }.
 */
function profileResponse(profileOrUser, message = 'Success') {
  const isWrapped =
    profileOrUser &&
    typeof profileOrUser === 'object' &&
    'user' in profileOrUser;

  if (isWrapped) {
    const { user, kyc_details, wallet, daily_rewards } = profileOrUser;
    return {
      success: true,
      message,
      user,
      ...(kyc_details !== undefined ? { kyc_details } : {}),
      ...(wallet !== undefined ? { wallet } : {}),
      ...(daily_rewards !== undefined ? { daily_rewards } : {}),
    };
  }

  return {
    success: true,
    message,
    user: formatProfile(profileOrUser),
  };
}

async function getProfile(userId) {
  const user = await userModel.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');

  const [kyc, wallet, dailyRewards] = await Promise.all([
    kycModel.findByUserId(userId),
    walletModel.getOrCreateByUserId(userId),
    rewardsService.getDailyStatus(userId),
  ]);
  const kyc_details = kyc ? kycModel.formatForResponse(kyc) : null;

  return {
    user: formatProfile(user),
    kyc_details,
    wallet,
    daily_rewards: dailyRewards,
  };
}

async function updateProfile(userId, { name, avatar }) {
  const user = await userModel.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');

  const updated = await userModel.updateProfile(userId, { name, avatar });

  const [kyc, wallet] = await Promise.all([
    kycModel.findByUserId(userId),
    walletModel.getOrCreateByUserId(userId),
  ]);
  const keyDetails = kyc ? kycModel.formatForResponse(kyc) : null;

  return {
    user: formatProfile(updated),
    key_details: keyDetails,
    wallet,
  };
}

async function listUsers({ page = 1, limit = 20, last7days = false, inactiveGameplayDays = null } = {}) {
  const { users, total } = await userModel.getAllPaginated({
    page,
    limit,
    last7days,
    inactiveGameplayDays,
  });
  return {
    users: users.map(formatAdminProfile),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

module.exports = {
  formatProfile,
  profileResponse,
  getProfile,
  updateProfile,
  listUsers,
};

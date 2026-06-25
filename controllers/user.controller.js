const userService = require('../services/user.service');

async function getProfile(req, res) {
  try {
    const userId = req.user.id;
    const user = await userService.getProfile(userId);
    res.json(userService.profileResponse(user, 'Profile retrieved successfully'));
  } catch (err) {
    console.error('getProfile error:', err);
    if (err.message === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.status(500).json({ success: false, message: 'Failed to get profile' });
  }
}

async function updateProfile(req, res) {
  try {
    const userId = req.user.id;
    const { name, avatar } = req.body;
    const user = await userService.updateProfile(userId, { name, avatar });
    const updateKey  =  name ? 'Name' : avatar ? 'Avatar' : 'Profile';
    res.json(userService.profileResponse(user, `${updateKey} updated successfully`));
  } catch (err) {
    console.error('updateProfile error:', err);
    if (err.message === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
}

function isAdminUser(userId) {
  const adminIdsEnv = process.env.ADMIN_USER_IDS || '';
  if (!adminIdsEnv.trim()) {
    // No admin list configured, allow all for now.
    return true;
  }

  const adminIds = adminIdsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !Number.isNaN(n));
  return adminIds.includes(userId);
}

async function listUsers(req, res) {
  try {
    // const userId = req.user.id;
    // if (!isAdminUser(userId)) {
    //   return res.status(403).json({ success: false, message: 'Forbidden' });
    // }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const last7days = req.query.last7days === 'true';

    const result = await userService.listUsers({ page, limit, last7days });
    res.json({ success: true, message: 'Users fetched successfully', ...result });
  } catch (err) {
    console.error('listUsers error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
}

module.exports = {
  getProfile,
  updateProfile,
  listUsers,
};

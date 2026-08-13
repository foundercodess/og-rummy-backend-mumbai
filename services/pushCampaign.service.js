'use strict';

const { query } = require('../db');
const pushCampaignModel = require('../models/pushCampaign.model');
const userDeviceTokenModel = require('../models/userDeviceToken.model');
const pushService = require('./push.service');
const { enqueuePushCampaign } = require('../queues/pushCampaign.queue');

const CAMPAIGN_TYPE_INACTIVE_REMINDER = 'inactive_gameplay_reminder';

const DEFAULT_TITLE = 'We miss you at OG Rummy!';
const DEFAULT_BODY =
  'It’s been a while since your last game. Come back, play a quick match, and claim your rewards.';

function formatCampaign(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    inactive_days: row.inactive_days,
    title: row.title,
    body: row.body,
    status: row.status,
    target_users: Number(row.target_users) || 0,
    tokens_total: Number(row.tokens_total) || 0,
    tokens_sent: Number(row.tokens_sent) || 0,
    tokens_failed: Number(row.tokens_failed) || 0,
    created_by: row.created_by,
    error_message: row.error_message,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function bulkInsertNotifications({ userIds, title, body, metadata }) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  if (!ids.length) return 0;

  const metaJson = JSON.stringify(metadata || {});
  const result = await query(
    `INSERT INTO notifications (user_id, title, content, type, metadata)
     SELECT u.uid, $2, $3, 'promo', $4
     FROM UNNEST($1::int[]) AS u(uid)`,
    [ids, title, body, metaJson]
  );
  return result.rowCount || 0;
}

async function processInactiveReminderCampaign({ campaignId }) {
  const id = Number(campaignId);
  const campaign = await pushCampaignModel.getCampaignById(id);
  if (!campaign) {
    throw new Error(`Campaign ${id} not found`);
  }
  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    return formatCampaign(campaign);
  }

  await pushCampaignModel.markRunning(id);

  if (!pushService.isConfigured()) {
    await pushCampaignModel.markFailed(id, 'FCM is not configured on this server');
    throw new Error('FCM_NOT_CONFIGURED');
  }

  const inactiveDays = Number(campaign.inactive_days) || 3;
  const targetUsers = await userDeviceTokenModel.countUsersWithTokensForInactiveGameplay(inactiveDays);
  await pushCampaignModel.bumpProgress(id, { targetUsers });

  let afterId = 0;
  const pageSize = pushService.MULTICAST_MAX || 500;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await userDeviceTokenModel.listActiveTokensForInactiveGameplay({
      inactiveDays,
      afterId,
      limit: pageSize,
    });
    if (!rows.length) break;

    afterId = rows[rows.length - 1].id;
    const tokens = rows.map((r) => r.fcm_token).filter(Boolean);
    const userIds = rows.map((r) => r.user_id);

    const result = await pushService.sendMulticast(tokens, {
      title: campaign.title,
      body: campaign.body,
      data: {
        event: 'inactive_gameplay_reminder',
        type: 'promo',
        campaign_id: String(id),
        inactive_days: String(inactiveDays),
      },
    });

    try {
      await bulkInsertNotifications({
        userIds,
        title: campaign.title,
        body: campaign.body,
        metadata: {
          event: 'inactive_gameplay_reminder',
          campaign_id: id,
          inactive_days: inactiveDays,
        },
      });
    } catch (err) {
      console.error('[push-campaign] in-app notification insert failed:', err.message);
    }

    await pushCampaignModel.bumpProgress(id, {
      tokensTotal: tokens.length,
      tokensSent: result.sent || 0,
      tokensFailed: result.failed || 0,
      targetUsers,
    });
  }

  const done = await pushCampaignModel.markCompleted(id);
  return formatCampaign(done);
}

async function enqueueInactiveGameplayReminder({
  inactiveDays = 3,
  title,
  body,
  createdByAdminId = null,
}) {
  const days = Number(inactiveDays);
  if (![3, 7, 14, 30].includes(days) && !(Number.isInteger(days) && days >= 1 && days <= 90)) {
    const err = new Error('INVALID_INACTIVE_DAYS');
    err.code = 'INVALID_INACTIVE_DAYS';
    throw err;
  }

  if (!pushService.isConfigured()) {
    const err = new Error('FCM_NOT_CONFIGURED');
    err.code = 'FCM_NOT_CONFIGURED';
    throw err;
  }

  const existing = await pushCampaignModel.findRecentActiveCampaign({
    type: CAMPAIGN_TYPE_INACTIVE_REMINDER,
    inactiveDays: days,
    withinMinutes: 30,
  });
  if (existing) {
    const err = new Error('CAMPAIGN_ALREADY_RUNNING');
    err.code = 'CAMPAIGN_ALREADY_RUNNING';
    err.campaign = formatCampaign(existing);
    throw err;
  }

  const targetUsers = await userDeviceTokenModel.countUsersWithTokensForInactiveGameplay(days);
  if (targetUsers <= 0) {
    const err = new Error('NO_ELIGIBLE_USERS');
    err.code = 'NO_ELIGIBLE_USERS';
    throw err;
  }

  const campaign = await pushCampaignModel.createCampaign({
    type: CAMPAIGN_TYPE_INACTIVE_REMINDER,
    inactiveDays: days,
    title: String(title || DEFAULT_TITLE).trim().slice(0, 160) || DEFAULT_TITLE,
    body: String(body || DEFAULT_BODY).trim() || DEFAULT_BODY,
    createdBy: createdByAdminId,
  });

  await pushCampaignModel.bumpProgress(campaign.id, { targetUsers });

  try {
    await enqueuePushCampaign(campaign.id);
  } catch (err) {
    if (err?.code === 'PUSH_QUEUE_UNAVAILABLE') {
      // Fallback: run inline so local/dev without queue still works.
      setImmediate(() => {
        processInactiveReminderCampaign({ campaignId: campaign.id }).catch((e) => {
          console.error('[push-campaign] inline process failed:', e.message);
          pushCampaignModel.markFailed(campaign.id, e.message).catch(() => {});
        });
      });
    } else {
      await pushCampaignModel.markFailed(campaign.id, err.message);
      throw err;
    }
  }

  return {
    campaign: formatCampaign(await pushCampaignModel.getCampaignById(campaign.id)),
    eligible_users_with_tokens: targetUsers,
  };
}

async function getCampaign(campaignId) {
  return formatCampaign(await pushCampaignModel.getCampaignById(campaignId));
}

module.exports = {
  CAMPAIGN_TYPE_INACTIVE_REMINDER,
  DEFAULT_TITLE,
  DEFAULT_BODY,
  processInactiveReminderCampaign,
  enqueueInactiveGameplayReminder,
  getCampaign,
};

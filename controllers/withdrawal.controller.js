const withdrawalService = require('../services/withdrawal.service');

function mapWithdrawalError(err, res) {
  const code = err.code || '';
  const clientErrors = new Set([
    'INVALID_AMOUNT',
    'MIN_AMOUNT',
    'BANK_NOT_FOUND',
    'INSUFFICIENT_BALANCE',
    'DAILY_COUNT_LIMIT',
    'DAILY_AMOUNT_LIMIT',
    'INVALID_BANK_HOLDER',
    'INVALID_BANK_NAME',
    'INVALID_ACCOUNT_NUMBER',
    'INVALID_IFSC',
    'BANK_LIMIT_REACHED',
    'INVALID_CALLBACK',
    'USER_BLOCKED',
    'WITHDRAWALS_FROZEN',
    'KYC_NOT_SUBMITTED',
    'KYC_PENDING',
    'KYC_REJECTED',
    'KYC_NOT_APPROVED',
    'SUSPICIOUS_ACCOUNT',
  ]);

  if (clientErrors.has(code)) {
    return res.status(400).json({ success: false, message: err.message });
  }
  if (code === 'PG_NOT_CONFIGURED') {
    return res.status(503).json({ success: false, message: 'Payout gateway is not configured' });
  }
  if (['PG_UNAVAILABLE', 'PG_INVALID_RESPONSE', 'PG_INIT_FAILED'].includes(code)) {
    console.error('withdrawal PG error:', code, err.message, err.gatewayResponse || '');
    return res.status(502).json({
      success: false,
      message: err.message || 'Failed to initiate payout',
    });
  }
  return null;
}

async function listBankAccounts(req, res) {
  try {
    const accounts = await withdrawalService.listBankAccounts(req.user.id);
    return res.json({
      success: true,
      message: 'Bank accounts retrieved successfully',
      bank_accounts: accounts,
    });
  } catch (err) {
    console.error('listBankAccounts error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve bank accounts' });
  }
}

async function addBankAccount(req, res) {
  try {
    const {
      account_holder_name: accountHolderName,
      bank_name: bankName,
      account_number: accountNumber,
      ifsc_code: ifscCode,
      branch,
    } = req.body || {};

    const account = await withdrawalService.addBankAccount(req.user.id, {
      accountHolderName,
      bankName,
      accountNumber,
      ifscCode,
      branch,
    });

    return res.status(201).json({
      success: true,
      message: 'Bank account added successfully',
      bank_account: account,
    });
  } catch (err) {
    const mapped = mapWithdrawalError(err, res);
    if (mapped) return mapped;
    console.error('addBankAccount error:', err);
    return res.status(500).json({ success: false, message: 'Failed to add bank account' });
  }
}

async function deleteBankAccount(req, res) {
  try {
    const bankAccountId = Number(req.params.id);
    if (!bankAccountId) {
      return res.status(400).json({ success: false, message: 'Valid bank account id required' });
    }

    const result = await withdrawalService.deleteBankAccount(req.user.id, bankAccountId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }

    return res.json({
      success: true,
      message: result.message,
    });
  } catch (err) {
    console.error('deleteBankAccount error:', err);
    return res.status(500).json({ success: false, message: 'Failed to remove bank account' });
  }
}

async function createWithdrawal(req, res) {
  try {
    const {
      amount,
      bank_account_id: bankAccountId,
      type,
      phone,
    } = req.body || {};

    const numericBankId = Number(bankAccountId);
    if (!numericBankId) {
      return res.status(400).json({ success: false, message: 'bank_account_id is required' });
    }

    const withdrawal = await withdrawalService.createWithdrawal({
      userId: req.user.id,
      amount: Number(amount),
      bankAccountId: numericBankId,
      type,
      phone: phone || req.user.phone || null,
    });

    return res.status(201).json({
      success: true,
      message: 'Withdrawal request submitted successfully',
      withdrawal,
    });
  } catch (err) {
    const mapped = mapWithdrawalError(err, res);
    if (mapped) return mapped;
    console.error('createWithdrawal error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit withdrawal request' });
  }
}

async function listWithdrawals(req, res) {
  try {
    const { type, limit, offset } = req.query || {};
    const withdrawals = await withdrawalService.listWithdrawals({
      userId: req.user.id,
      type: type || null,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });

    return res.json({
      success: true,
      message: 'Withdrawals retrieved successfully',
      withdrawals,
    });
  } catch (err) {
    console.error('listWithdrawals error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve withdrawals' });
  }
}

async function getWithdrawalDetail(req, res) {
  try {
    const withdrawalId = Number(req.params.id);
    if (!withdrawalId) {
      return res.status(400).json({ success: false, message: 'Valid withdrawal id required' });
    }

    const withdrawal = await withdrawalService.getWithdrawalDetail({
      userId: req.user.id,
      withdrawalId,
    });

    if (!withdrawal) {
      return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    }

    return res.json({
      success: true,
      message: 'Withdrawal details retrieved successfully',
      withdrawal,
    });
  } catch (err) {
    console.error('getWithdrawalDetail error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve withdrawal details' });
  }
}

async function payoutCallback(req, res) {
  try {
    const result = await withdrawalService.handlePayoutCallback(req.query || {});
    if (!result) {
      return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    }

    return res.json({
      success: true,
      message: 'Payout callback processed',
      withdrawal: result.tx,
      status: result.resolvedStatus,
    });
  } catch (err) {
    const mapped = mapWithdrawalError(err, res);
    if (mapped) return mapped;
    console.error('payoutCallback error:', err);
    return res.status(500).json({ success: false, message: 'Failed to process payout callback' });
  }
}

module.exports = {
  listBankAccounts,
  addBankAccount,
  deleteBankAccount,
  createWithdrawal,
  listWithdrawals,
  getWithdrawalDetail,
  payoutCallback,
};

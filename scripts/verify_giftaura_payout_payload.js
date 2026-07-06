#!/usr/bin/env node
/* eslint-disable no-console */

const assert = require('assert');
const { buildPayoutSaltPayload } = require('../services/giftauraPayout.service');

function testSaltEncodingShape() {
  const { salt, innerPayload } = buildPayoutSaltPayload({
    merchantId: 'INDIANPAY00GIFTAURA00004',
    merchantToken: 'secret-token',
    accountNo: '7919002100002393',
    ifscCode: 'PUNB0791900',
    amount: 1000,
    bankName: 'PNB Bank',
    remark: 'remark',
    orderId: '115454643446545336440',
    name: 'Founder Code Technology',
    contact: '9876543210',
    email: 'a@gmail.com',
  });

  assert.strictEqual(typeof salt, 'string');
  assert.ok(salt.length > 0);

  const decoded = JSON.parse(Buffer.from(salt, 'base64').toString('utf8'));
  assert.deepStrictEqual(decoded, innerPayload);
  assert.strictEqual(decoded.merchant_id, 'INDIANPAY00GIFTAURA00004');
  assert.strictEqual(decoded.merchant_token, 'secret-token');
  assert.strictEqual(decoded.account_no, '7919002100002393');
  assert.strictEqual(decoded.ifsccode, 'PUNB0791900');
  assert.strictEqual(decoded.amount, '1000');
  assert.strictEqual(decoded.bankname, 'PNB Bank');
  assert.strictEqual(decoded.orderid, '115454643446545336440');
  assert.strictEqual(decoded.contact, '9876543210');
  assert.strictEqual(decoded.email, 'a@gmail.com');
}

function main() {
  testSaltEncodingShape();
  console.log('verify_giftaura_payout_payload: ok');
}

main();

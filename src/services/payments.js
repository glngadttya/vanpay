const crypto = require('crypto');
const { config } = require('../config');
const settings = require('../settings');
const qris = require('../../lib/qris');
const telegram = require('../../lib/telegram');
const logger = require('../../lib/logger');

class AppError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
    this.expose = true;
  }
}

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function calcFee(amount) {
  const pct = settings.getNum('billing.fee_pct', config.feePct);
  const min = settings.getNum('billing.min_fee', config.minFee);
  return Math.max(min, Math.round(amount * (pct / 100)));
}

function effectiveQris() {
  return settings.get('qr.qris_string', '') || config.qrisString;
}

async function createPayment(db, user, { amount, note }) {
  amount = Math.round(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, 'Nominal tidak valid');
  const minAmt = settings.getNum('billing.min_qris', config.minQrisAmount);
  const maxAmt = settings.getNum('billing.max_qris', config.maxQrisAmount);
  if (amount < minAmt) throw new AppError(400, `Minimal QRIS ${minAmt}`);
  if (amount > maxAmt) throw new AppError(400, `Maksimal QRIS ${maxAmt}`);

  const qrString0 = effectiveQris();
  if (!qrString0) throw new AppError(503, 'QRIS utama belum dikonfigurasi owner');

  const fee = await calcFee(amount);
  const pending = await db.payments.listPending();
  const used = new Set(pending.map((p) => Number(p.pay_amount)));
  let code = 0;
  let payAmount = 0;
  for (let i = 1; i <= config.uniqueCodeMax; i++) {
    const pa = amount + fee + i;
    if (!used.has(pa)) { code = i; payAmount = pa; break; }
  }
  if (!code) throw new AppError(503, 'Server sibuk, silakan coba beberapa saat lagi');

  const id = newId('PN');
  const expiresAt = new Date(Date.now() + config.expireMinutes * 60000).toISOString();
  const mode = settings.get('qr.mode', 'dynamic');
  let qrString;
  try {
    qrString = mode === 'static' ? qris.qrToPayload(qrString0) : qris.buildDynamicQris(qrString0, payAmount);
  } catch (e) {
    throw new AppError(400, 'QRIS utama tidak valid: ' + e.message);
  }

  const txn = await db.payments.create({
    id, userId: user.id, amount, fee, uniqueCode: code, payAmount, qrString,
    expiresAt, note: String(note || '').slice(0, 80) || null,
  });
  logger.info(`[payments] buat ${id}: amount=${amount} fee=${fee} pay=${payAmount} code=${code} mode=${mode} user#${user.id}`);
  return txn;
}

async function onIncoming(db, entry) {
  const amount = Number(entry.amount);
  if (!amount || amount <= 0) return;
  const txn = await db.payments.getByPayAmount(amount);
  if (!txn) return;
  const marked = await db.payments.markPaid(txn.id, entry.trxId || null);
  if (!marked) return;
  const user = await db.users.get(txn.user_id);
  await db.users.credit(txn.user_id, txn.amount, { type: 'deposit', ref: txn.id, note: `QRIS ${txn.id} terbayar` });
  logger.info(`[payments] ${txn.id} PAID pay_amount=${amount} credit user#${txn.user_id} +${txn.amount} tx=${entry.trxId || ''}`);
  telegram.deposit(user, txn.amount, txn);
}

async function statusOf(txn) {
  if (!txn) return null;
  if (txn.status === 'PENDING') {
    if (new Date(txn.expires_at).getTime() < Date.now()) {
      const { getDb } = require('../db');
      await getDb().payments.expire(txn.id);
      txn.status = 'EXPIRED';
    }
  }
  return {
    id: txn.id,
    status: txn.status,
    amount: txn.amount,
    fee: txn.fee,
    payAmount: txn.payAmount,
    expiration: txn.expires_at,
    note: txn.note,
  };
}

module.exports = { createPayment, onIncoming, statusOf, calcFee, newId, AppError };
const { config } = require('../config');
const settings = require('../settings');
const telegram = require('../../lib/telegram');
const logger = require('../../lib/logger');
const { newId, AppError } = require('./payments');

const METHODS = ['DANA', 'GOPAY', 'SHOPEEPAY'];
const ALLOWED = new Set(METHODS);

async function requestWithdraw(db, user, { amount, method, accountNumber, accountName }) {
  amount = Math.round(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, 'Nominal tidak valid');
  const minWd = settings.getNum('billing.min_wd', config.minWithdraw);
  const maxWd = settings.getNum('billing.max_wd', config.maxWithdraw);
  if (amount < minWd) throw new AppError(400, `Minimal penarikan ${minWd}`);
  if (amount > maxWd) throw new AppError(400, `Maksimal penarikan ${maxWd}`);
  if (!ALLOWED.has(String(method).toUpperCase())) throw new AppError(400, 'Metode harus DANA / GOPAY / SHOPEEPAY');
  if (!accountNumber || !String(accountNumber).trim()) throw new AppError(400, 'Nomor rekening wajib diisi');

  const id = newId('WD');
  const held = await db.users.hold(user.id, amount, { type: 'withdraw_hold', ref: id, note: `Penarikan ${method}` });
  if (!held) throw new AppError(400, 'Saldo tidak cukup');

  const wd = await db.withdrawals.create({
    id,
    userId: user.id,
    amount,
    method: String(method).toUpperCase(),
    accountNumber: String(accountNumber).replace(/\D/g, ''),
    accountName: String(accountName || '').slice(0, 60) || null,
  });
  const u2 = await db.users.get(user.id);
  logger.info(`[withdraw] ${id} diminta user#${user.id} ${amount} ${wd.method}`);
  telegram.withdrawRequest(user, wd, u2.balance);
  return wd;
}

async function approve(db, wdId) {
  const wd = await db.withdrawals.get(wdId);
  if (!wd) throw new AppError(404, 'Data tidak ditemukan');
  if (wd.status !== 'PENDING') throw new AppError(400, `Status sudah ${wd.status}`);
  const ok = await db.withdrawals.updateStatus(wdId, 'DONE', 'Disetujui & diproses manual');
  if (!ok) throw new AppError(409, 'Gagal memperbarui');
  telegram.withdrawProcessed(wd, 'DONE', 'Ditransfer oleh admin');
  logger.info(`[withdraw] ${wdId} DISETUJUI`);
  return { ok: true };
}

async function reject(db, wdId, note) {
  const wd = await db.withdrawals.get(wdId);
  if (!wd) throw new AppError(404, 'Data tidak ditemukan');
  if (wd.status !== 'PENDING') throw new AppError(400, `Status sudah ${wd.status}`);
  const ok = await db.withdrawals.updateStatus(wdId, 'REJECTED', String(note || '').slice(0, 200) || 'Ditolak');
  if (!ok) throw new AppError(409, 'Gagal memperbarui');
  await db.users.credit(wd.user_id, wd.amount, { type: 'withdraw_refund', ref: wdId, note: 'Refund penarikan ditolak' });
  telegram.withdrawProcessed(wd, 'REJECTED', note || '');
  logger.info(`[withdraw] ${wdId} DITOLAK, saldo user#${wd.user_id} di-refund`);
  return { ok: true };
}

module.exports = { requestWithdraw, approve, reject, METHODS };
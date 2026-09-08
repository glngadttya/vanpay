#!/usr/bin/env node
require('dotenv').config();
const readline = require('readline');
const { config } = require('./src/config');
const { getDb } = require('./src/db');
const gobiz = require('./lib/gobiz');
const { saveAuth, clearAuth, getAuth } = require('./src/services/gobiz-state');
const logger = require('./lib/logger');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function main() {
  const db = getDb();
  const prev = await getAuth(db);
  logger.info('=== Login GoBiz / GoPay Merchant ===');
  logger.info('Previous: ' + (prev.accessToken ? 'ADA (token tersimpan, merchant ' + (prev.merchantId || '?') + ')' : 'KOSONG'));

  const mode = (await ask('Mode? [o]tp / [p]assword / [r]efresh / [x] logout ke, default o: ').then((s) => s.trim().toLowerCase() || 'o'));

  if (mode === 'x') {
    await clearAuth(db);
    logger.info('Kredensial GoBiz dihapus.');
    rl.close();
    return;
  }

  if (mode === 'r') {
    if (!prev.refreshToken) { logger.error('ga ada refresh_token.'); rl.close(); return; }
    const tok = await gobiz.refresh(prev.refreshToken);
    const merchantId = tok.merchantId || prev.merchantId || await gobiz.detectMerchantId(tok.accessToken);
    await saveAuth(db, { ...tok, merchantId, phone: prev.phone });
    logger.info('Refresh OK. Merchant ID = ' + (merchantId || '???') + '. Token baru tersimpan.');
    rl.close();
    return;
  }

  const cc = config.goPay.countryCode || '+62';
  const phone = (await ask(`Nomor GoPay (tanpa ${cc}): `)).trim();

  if (mode === 'p') {
    const email = (await ask('Email/username GoBiz: ')).trim();
    const password = (await ask('Password: ')).trim();
    const tok = await gobiz.loginWithPassword(email, password);
    const merchantId = tok.merchantId || await gobiz.detectMerchantId(tok.accessToken);
    await saveAuth(db, { ...tok, merchantId, phone });
    logger.info('Login OK. Merchant ID = ' + (merchantId || '???') + '. Token tersimpan.');
    rl.close();
    return;
  }

  await gobiz.requestOtp(phone, cc);
  const isOtpLink = await ask('Ada kode OTP + link? (selain y/no, bisa langsung tempel link) [y]: ').then((s) => s.trim().toLowerCase() || 'y') !== 'n';
  const otpInput = await ask('Kode OTP (6 digit): ');
  const otp = otpInput.trim();

  const tok = await gobiz.verifyOtp(phone, cc, otp);
  let merchantId = tok.merchantId;
  if (!merchantId) merchantId = await gobiz.detectMerchantId(tok.accessToken);
  await saveAuth(db, { ...tok, merchantId, phone });
  logger.info('Login OK. Merchant ID = ' + (merchantId || '???') + '. Token tersimpan.');
  logger.info('Poller akan otomatis memakai token ini.');
  rl.close();
}

main().catch((e) => {
  logger.error('gagal: ' + (e && e.stack || e));
  process.exit(1);
});
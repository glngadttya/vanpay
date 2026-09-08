const logger = require('../../lib/logger');
const gobiz = require('../../lib/gobiz');
const { config } = require('../config');
const { onIncoming } = require('./payments');
const { getAuth, saveAuth, clearAuth } = require('./gobiz-state');

let dbRef = null;
let timer = null;
let lastRunAt = 0;
let running = false;

function useDb(db) { dbRef = db; }

function init(db) { useDb(db); }

async function refreshTokenOnce(auth) {
  if (!auth.refreshToken) return null;
  const tok = await gobiz.refresh(auth.refreshToken);
  if (tok.accessToken) {
    await saveAuth(dbRef, { accessToken: tok.accessToken, refreshToken: tok.refreshToken || auth.refreshToken, merchantId: tok.merchantId || auth.merchantId });
    logger.info('[poller] token GoBiz di-refresh');
    return { ...auth, accessToken: tok.accessToken, refreshToken: tok.refreshToken || auth.refreshToken, merchantId: tok.merchantId || auth.merchantId };
  }
  return null;
}

async function fetchEntries(auth) {
  let lastErr;
  try {
    return await gobiz.getHistory(auth.accessToken, auth.merchantId, {});
  } catch (e) {
    lastErr = e;
    logger.warn('[poller] history gagal: ' + e.message + ' — coba refresh token');
    const fresh = await refreshTokenOnce(auth);
    if (fresh) {
      try {
        return await gobiz.getHistory(fresh.accessToken, fresh.merchantId, {});
      } catch (e2) {
        return { error: e2, kind: 'newtoken' };
      }
    }
    return { error: lastErr, kind: 'norefresh' };
  }
}

async function runCycle(db) {
  useDb(db || dbRef);
  if (!dbRef) return;
  if (running) return;
  running = true;
  try {
    await dbRef.payments.expireDue();

    const auth = await getAuth(dbRef);
    if (!auth.accessToken || !auth.merchantId) {
      logger.debug('[poller] belum ada kredensial GoBiz (login via node login.js)');
      return;
    }

    const gotten = await fetchEntries(auth);
    if (gotten.error) {
      logger.warn('[poller] ' + (gotten.kind || '') + ': ' + (gotten.error && gotten.error.message));
      if (gotten.kind === 'norefresh') await clearAuth(dbRef);
      return;
    }

    const entries = (gotten || []).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let count = 0;
    for (const e of entries) {
      const before = await dbRef.payments.countByStatus('PAID');
      await onIncoming(dbRef, e);
      const after = await dbRef.payments.countByStatus('PAID');
      if (after.c > before.c) count += 1;
    }
    if (count) logger.info(`[poller] siklus selesai, ${count} deposit baru diproses`);
  } catch (e) {
    logger.warn('[poller] error: ' + (e && e.message));
  } finally {
    running = false;
    lastRunAt = Date.now();
  }
}

function startPoller(db) {
  useDb(db);
  if (timer) return;
  timer = setInterval(() => {
    if (Date.now() - lastRunAt >= config.pollMinIntervalMs) runCycle();
  }, config.pollMinIntervalMs);
  timer.unref();
  logger.info(`[poller] aktif tiap ${config.pollMinIntervalMs}ms`);
  runCycle().catch(() => {});
}

function stopPoller() {
  if (timer) { clearInterval(timer); timer = null; }
}

async function runCycleNow(db, force) {
  if (force) lastRunAt = 0;
  await runCycle(db);
  return { ok: true };
}

module.exports = { init, useDb, runCycle, runCycleNow, startPoller, stopPoller };
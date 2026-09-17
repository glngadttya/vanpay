#!/usr/bin/env node
require('dotenv').config();

const { config, checkConfig } = require('./src/config');
const { getDb } = require('./src/db');
const settings = require('./src/settings');
const { startPoller, stopPoller } = require('./src/services/poller');
const logger = require('./lib/logger');

async function main() {
  for (const p of checkConfig()) logger.warn(p.msg);

  const db = getDb();
  await settings.load(db);
  await settings.ensureBootstrap();

  const app = require('./src/app').buildApp(db);

  const port = config.port;
  const server = app.listen(port, () => {
    logger.info(`[VanPay] listening on :${port}`);
    logger.info(`[VanPay] buka  http://localhost:${port}`);
  });

  server.on('error', (e) => {
    logger.error('server error: ' + e.message);
    process.exit(1);
  });

  startPoller();

  const shut = () => {
    logger.info('[VanPay] shutting down...');
    stopPoller();
    try { server.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shut);
  process.on('SIGTERM', shut);
}

main().catch((e) => {
  logger.error('[VanPay] fatal: ' + (e && e.stack || e));
  process.exit(1);
});
#!/usr/bin/env node
require('dotenv').config();

const { config, checkConfig } = require('./src/config');
const { getDb } = require('./src/db');
const { startPoller, stopPoller } = require('./src/services/poller');
const logger = require('./lib/logger');

async function main() {
  const problems = checkConfig();
  for (const p of problems) {
    if (p.fatal) throw new Error('Config fatal: ' + p.msg);
    logger.warn(p.msg);
  }

  const db = getDb();
  const app = require('./src/app').buildApp(db);

  const port = config.port;
  const server = app.listen(port, () => {
    logger.info(`[VanPay] listening on :${port}`);
    const pub = config.publicUrl || `http://localhost:${port}`;
    logger.info(`[VanPay] open  ${pub}`);
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
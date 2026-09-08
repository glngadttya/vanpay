require('dotenv').config();
const { getDb } = require('../src/db');

let db;

if (!process.env.VERCEL) {
  const { startPoller } = require('../src/services/poller');
  db = getDb();
  startPoller();
} else {
  db = getDb();
}

module.exports = require('../src/app').buildApp(db);
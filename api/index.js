require('dotenv').config();
const { getDb } = require('../src/db');
const settings = require('../src/settings');
const poller = require('../src/services/poller');

let app = null;
let db = null;

async function getApp() {
  if (!app) {
    db = getDb();
    await settings.load(db);
    await settings.ensureBootstrap();
    if (!process.env.VERCEL) poller.startPoller();
    app = require('../src/app').buildApp(db);
  }
  return app;
}

module.exports = async (req, res) => {
  const a = await getApp();
  return a(req, res);
};
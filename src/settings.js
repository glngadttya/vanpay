const crypto = require('crypto');
const { config } = require('./config');
const logger = require('../lib/logger');

let db = null;
const cache = new Map();

const NUMERIC = new Set(['billing.fee_pct', 'billing.min_fee', 'billing.min_qris', 'billing.max_qris', 'billing.min_wd', 'billing.max_wd']);

async function load(database) {
  db = database;
  cache.clear();
  if (db) {
    const rows = await db.settings.listAll();
    for (const r of rows) cache.set(r.key, r.value);
  }
  logger.info('[settings] cache siap (' + cache.size + ' key)');
}

function get(key, def = '') {
  if (cache.has(key)) {
    const v = cache.get(key);
    return v === undefined ? def : v;
  }
  return def;
}

function getNum(key, defNum) {
  const v = get(key, '');
  const x = Number(v);
  return Number.isFinite(x) && v !== '' ? x : defNum;
}

function getUrl(key, def = '') {
  return String(get(key, def)).replace(/\/+$/, '');
}

function getB(key, defBool = false) {
  const v = String(get(key, '')).toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return defBool;
}

async function set(key, value) {
  if (!db) throw new Error('settings belum di-load');
  if (value === undefined || value === null) value = '';
  value = String(value);
  if (NUMERIC.has(key)) value = String(Number(value));
  await db.settings.set(key, value);
  cache.set(key, value);
  return value;
}

async function remove(key) {
  if (!db) return;
  await db.settings.delete(key);
  cache.delete(key);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function ensureBootstrap() {
  if (!db) return '';
  let raw = cache.get('sys.bootstrap_raw');
  if (!raw) {
    raw = crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, '').slice(0, 22);
    await db.settings.set('sys.bootstrap_raw', raw);
    await db.settings.set('sys.bootstrap_hash', sha256(raw));
    cache.set('sys.bootstrap_raw', raw);
    cache.set('sys.bootstrap_hash', sha256(raw));
  }
  const owner = await hasOwner();
  if (!owner) {
    logger.warn('===== OWNER SETUP =====');
    logger.warn('Belum ada owner. Buka link ini SEKALI biar akun lu jadi OWNER:');
    logger.warn('GET  /bootstrap/' + raw);
    logger.warn('Setelah itu kelola semuanya di dashboard -> PENGATURAN.');
    logger.warn('=======================');
  }
  return raw;
}

function checkBootstrap(token) {
  if (!token) return false;
  const stored = cache.get('sys.bootstrap_raw');
  return !!stored && stored.length === String(token).length && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(String(token)));
}

function resetBootstrap() {
  const raw = crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, '').slice(0, 22);
  if (!db) return raw;
  db.settings.set('sys.bootstrap_raw', raw).then(() => db.settings.set('sys.bootstrap_hash', sha256(raw)));
  cache.set('sys.bootstrap_raw', raw);
  cache.set('sys.bootstrap_hash', sha256(raw));
  return raw;
}

async function hasOwner() {
  if (!db) return false;
  const users = await db.users.list();
  return users.some((u) => u.role === 'owner');
}

module.exports = { load, get, getNum, getUrl, getB, set, remove, ensureBootstrap, checkBootstrap, resetBootstrap, hasOwner };
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const logger = require('../lib/logger');

const nowIso = () => new Date().toISOString();

let gdb = null;

function initSqlite(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try { db.exec(`PRAGMA journal_mode = WAL;`); } catch (_) { }
  db.exec(`PRAGMA busy_timeout = 5000;`);
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'oauth',
    provider_id TEXT,
    email TEXT UNIQUE,
    name TEXT,
    avatar TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    balance INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0,
    unique_code INTEGER NOT NULL DEFAULT 0,
    pay_amount INTEGER NOT NULL,
    qr_string TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    gobiz_id TEXT,
    note TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_pay ON payments(pay_amount, status);
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    ref TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);
  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    account_number TEXT,
    account_name TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    admin_note TEXT,
    requested_at TEXT NOT NULL,
    processed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `);
}

function buildSqliteHandle(db) {
  const mapUser = (r) => (r ? ({ ...r }) : null);

  function getByEmail(email) {
    return mapUser(db.prepare(`SELECT * FROM users WHERE email = ?`).get(email));
  }

  function credit(id, amount, entry) {
    if (!amount || amount <= 0) return null;
    db.prepare(`UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?`).run(amount, nowIso(), id);
    ledgerInsert({ userId: id, type: entry.type, amount, ref: entry.ref, note: entry.note });
    return mapUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
  }

  function hold(id, amount, entry) {
    const r = db.prepare(`UPDATE users SET balance = balance - ?, updated_at = ? WHERE id = ? AND balance >= ?`).run(amount, nowIso(), id, amount);
    if (r.changes === 0) return null;
    ledgerInsert({ userId: id, type: entry.type, amount: -amount, ref: entry.ref, note: entry.note });
    return mapUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
  }

  function ledgerInsert({ userId, type, amount, ref, note }) {
    db.prepare(`INSERT INTO ledger (user_id, type, amount, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(userId, type, amount, ref || null, note || null, nowIso());
  }

  const users = {
    findOrCreate({ provider, providerId, email, name, avatar }) {
      let row = getByEmail(email);
      if (row) return row;
      db.prepare(`INSERT INTO users (provider, provider_id, email, name, avatar, role, balance, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'user', 0, 'active', ?, ?)`).run(provider, providerId || null, email, name || null, avatar || null, nowIso(), nowIso());
      return getByEmail(email);
    },
    getByEmail,
    get: (id) => mapUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id)),
    getByProvider(provider, providerId) {
      return mapUser(db.prepare(`SELECT * FROM users WHERE provider = ? AND provider_id = ?`).get(provider, providerId));
    },
    list: () => db.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all().map(mapUser),
    promoteOwner: (email) => { db.prepare(`UPDATE users SET role = 'owner', updated_at = ? WHERE email = ?`).run(nowIso(), email); },
    update(id, fields) {
      const cur = mapUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
      if (!cur) return null;
      const nxt = { ...cur, ...fields, updated_at: nowIso() };
      db.prepare(`UPDATE users SET name=?, avatar=?, role=?, status=?, updated_at=? WHERE id=?`)
        .run(nxt.name || null, nxt.avatar || null, nxt.role, nxt.status, nxt.updated_at, id);
      return mapUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
    },
    credit,
    hold,
    balance: (id) => { const u = mapUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id)); return u ? u.balance : 0; },
  };

  const sessions = {
    create(userId, ttlDays) {
      const token = crypto.randomBytes(24).toString('hex');
      const t1 = new Date(Date.now() + ttlDays * 86400000).toISOString();
      db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(token, userId, nowIso(), t1);
      return token;
    },
    get(token) {
      const row = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
      if (!row) return null;
      if (new Date(row.expires_at).getTime() < Date.now()) {
        sessions.destroy(token);
        return null;
      }
      return { token, userId: row.user_id, expiresAt: row.expires_at, user: mapUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id)) };
    },
    destroy: (token) => { db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token); },
  };

  const payments = {
    create({ id, userId, amount, fee, uniqueCode, payAmount, qrString, expiresAt, note }) {
      db.prepare(`INSERT INTO payments (id, user_id, amount, fee, unique_code, pay_amount, qr_string, status, note, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`)
        .run(id, userId, amount, fee, uniqueCode, payAmount, qrString || null, note || null, nowIso(), expiresAt);
      return payments.get(id);
    },
    get: (id) => mapUser(db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id)),
    getByPayAmount(amount) {
      return mapUser(db.prepare(`SELECT * FROM payments WHERE pay_amount = ? AND status = 'PENDING' ORDER BY created_at ASC LIMIT 1`).get(amount));
    },
    listPending: () => db.prepare(`SELECT * FROM payments WHERE status = 'PENDING' ORDER BY created_at ASC`).all(),
    listByUser(userId, limit = 20) {
      return db.prepare(`SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
    },
    list({ status, limit = 50 }) {
      if (status) return db.prepare(`SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit);
      return db.prepare(`SELECT * FROM payments ORDER BY created_at DESC LIMIT ?`).all(limit);
    },
    markPaid(id, gobizId) {
      const r = db.prepare(`UPDATE payments SET status = 'PAID', gobiz_id = ?, paid_at = ? WHERE id = ? AND status = 'PENDING'`).run(gobizId || null, nowIso(), id);
      return r.changes > 0;
    },
    expire(id) {
      return db.prepare(`UPDATE payments SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'`).run(id).changes > 0;
    },
    expireDue() {
      const rows = db.prepare(`SELECT id FROM payments WHERE status = 'PENDING' AND expires_at < ?`).all(nowIso());
      for (const r of rows) payments.expire(r.id);
      return rows.length;
    },
    countByStatus(status) {
      return db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(pay_amount),0) s FROM payments WHERE status = ?`).get(status);
    },
    dailyVolume(days) {
      const from = new Date(Date.now() - days * 86400000).toISOString();
      return db.prepare(`SELECT substr(paid_at, 1, 10) d, COUNT(*) c, COALESCE(SUM(amount),0) s FROM payments WHERE status = 'PAID' AND paid_at >= ? GROUP BY d ORDER BY d`).all(from);
    },
  };

  const ledger = {
    insert: ledgerInsert,
    listByUser(userId, limit = 50) {
      return db.prepare(`SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit);
    },
    list: (limit = 100) => db.prepare(`SELECT * FROM ledger ORDER BY id DESC LIMIT ?`).all(limit),
    sumByUser(userId) {
      const g = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id = ? AND type IN ('deposit','withdraw_refund')`).get(userId);
      return g.s;
    },
  };

  const withdrawals = {
    create({ id, userId, amount, method, accountNumber, accountName }) {
      db.prepare(`INSERT INTO withdrawals (id, user_id, amount, method, account_number, account_name, status, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`).run(id, userId, amount, method, accountNumber || null, accountName || null, nowIso());
      return withdrawals.get(id);
    },
    get: (id) => mapUser(db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).get(id)),
    listByUser(userId, limit = 20) {
      return db.prepare(`SELECT * FROM withdrawals WHERE user_id = ? ORDER BY requested_at DESC LIMIT ?`).all(userId, limit);
    },
    list({ status, limit = 50 }) {
      if (status) return db.prepare(`SELECT * FROM withdrawals WHERE status = ? ORDER BY requested_at DESC LIMIT ?`).all(status, limit);
      return db.prepare(`SELECT * FROM withdrawals ORDER BY requested_at DESC LIMIT ?`).all(limit);
    },
    updateStatus(id, status, adminNote) {
      return db.prepare(`UPDATE withdrawals SET status = ?, admin_note = COALESCE(?, admin_note), processed_at = COALESCE(?, processed_at) WHERE id = ?`)
        .run(status, adminNote || null, status === 'PENDING' ? null : nowIso(), id).changes > 0;
    },
    countByStatus(status) {
      return db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM withdrawals WHERE status = ?`).get(status);
    },
  };

  const settings = {
    get(key, def = null) {
      const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
      return r ? r.value : def;
    },
    set(key, value) {
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
    },
    delete: (key) => { db.prepare(`DELETE FROM settings WHERE key = ?`).run(key); },
    listAll() {
      return db.prepare(`SELECT * FROM settings`).all();
    },
  };

  const groups = { users, sessions, payments, ledger, withdrawals, settings };
  const handle = { db, close: () => { try { db.close(); } catch (_) {} } };
  for (const [g, methods] of Object.entries(groups)) {
    handle[g] = {};
    for (const [m, fn] of Object.entries(methods)) {
      handle[g][m] = (...args) => Promise.resolve().then(() => fn(...args));
    }
  }
  return handle;
}

function getDb(file) {
  if (gdb) return gdb;
  if (config.databaseUrl) {
    try {
      gdb = require('./db-pg').init(config.databaseUrl);
      logger.info('[db] using Postgres (DATABASE_URL)');
      return gdb;
    } catch (e) {
      logger.warn('[db] Postgres init gagal, fallback ke SQLite: ' + e.message);
    }
  }
  gdb = buildSqliteHandle(initSqlite(file || config.dbFile));
  logger.info(`[db] SQLite ready at ${file || config.dbFile}`);
  return gdb;
}

function reset() { gdb = null; }

module.exports = { getDb, reset, initSqlite, migrate, buildSqliteHandle };
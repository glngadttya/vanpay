const { Pool } = require('pg');
const crypto = require('crypto');

let pool = null;

const nowIso = () => new Date().toISOString();

async function init(url) {
  pool = new Pool({ connectionString: url, max: 5 });
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  await migrate(client);
  await client.end().catch(() => {});
  return buildHandle();
}

async function migrate(c) {
  await c.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'oauth',
    provider_id TEXT,
    email TEXT UNIQUE,
    name TEXT,
    avatar TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    balance BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await c.query(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  await c.query(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount BIGINT NOT NULL,
    fee BIGINT NOT NULL DEFAULT 0,
    unique_code INTEGER NOT NULL DEFAULT 0,
    pay_amount BIGINT NOT NULL,
    qr_string TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    gobiz_id TEXT,
    note TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_payments_pay ON payments(pay_amount, status)`);
  await c.query(`CREATE TABLE IF NOT EXISTS ledger (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount BIGINT NOT NULL,
    ref TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  )`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id)`);
  await c.query(`CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount BIGINT NOT NULL,
    method TEXT NOT NULL,
    account_number TEXT,
    account_name TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    admin_note TEXT,
    requested_at TEXT NOT NULL,
    processed_at TEXT
  )`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id)`);
  await c.query(`CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`);
  await c.query(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
}

const mapUser = (r) => (r ? ({ id: Number(r.id), provider: r.provider, provider_id: r.provider_id, email: r.email, name: r.name, avatar: r.avatar, role: r.role, balance: Number(r.balance || 0), status: r.status, created_at: r.created_at, updated_at: r.updated_at }) : null);

async function createUser(p) {
  const r = await pool.query(`INSERT INTO users (provider, provider_id, email, name, avatar, role, balance, status, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,'user',0,'active',$6,$7) RETURNING *`,
    [p.provider, p.providerId || null, p.email, p.name || null, p.avatar || null, nowIso(), nowIso()]);
  return mapUser(r.rows[0]);
}

function buildHandle() {
  const ledgerPoly = {
    async insert({ userId, type, amount, ref, note }) {
      await pool.query(`INSERT INTO ledger (user_id, type, amount, ref, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, type, amount, ref || null, note || null, nowIso()]);
    },
    async listByUser(userId, limit = 50) {
      const r = await pool.query(`SELECT * FROM ledger WHERE user_id = $1 ORDER BY id DESC LIMIT $2`, [userId, limit]);
      return r.rows;
    },
    async list(limit = 100) {
      const r = await pool.query(`SELECT * FROM ledger ORDER BY id DESC LIMIT $1`, [limit]);
      return r.rows;
    },
    async sumByUser(userId) {
      const r = await pool.query(`SELECT COALESCE(SUM(amount),0)::int s FROM ledger WHERE user_id = $1 AND type IN ('deposit','withdraw_refund')`, [userId]);
      return Number(r.rows[0].s || 0);
    },
  };

  return {
    db: { raw: (sql, p) => pool.query(sql, p).then(x => x.rows) },
    close: () => pool.end().catch(() => {}),

    users: {
      async findOrCreate({ provider, providerId, email, name, avatar }) {
        let row = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (row.rows[0]) return mapUser(row.rows[0]);
        const r = await pool.query(`SELECT * FROM users WHERE provider = $1 AND provider_id = $2`, [provider, providerId]);
        if (r.rows[0]) return mapUser(r.rows[0]);
        return createUser({ provider, providerId, email, name, avatar });
      },
      getByEmail: async (email) => {
        const r = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        return mapUser(r.rows[0]);
      },
      get: async (id) => {
        const r = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
        return mapUser(r.rows[0]);
      },
      getByProvider: async (provider, providerId) => {
        const r = await pool.query(`SELECT * FROM users WHERE provider = $1 AND provider_id = $2`, [provider, providerId]);
        return mapUser(r.rows[0]);
      },
      list: async () => {
        const r = await pool.query(`SELECT * FROM users ORDER BY created_at DESC`);
        return r.rows.map(mapUser);
      },
      promoteOwner: async (email) => {
        await pool.query(`UPDATE users SET role = 'owner', updated_at = $2 WHERE email = $1`, [email, nowIso()]);
      },
      update: async (id, fields) => {
        const cur = mapUser((await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0]);
        if (!cur) return null;
        await pool.query(`UPDATE users SET name=$1, avatar=$2, role=$3, status=$4, updated_at=$5 WHERE id=$6`,
          [fields.name ?? cur.name, fields.avatar ?? cur.avatar, fields.role ?? cur.role, fields.status ?? cur.status, nowIso(), id]);
        return mapUser((await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0]);
      },
      credit: async (id, amount, entry) => {
        if (!amount || amount <= 0) return null;
        await pool.query(`UPDATE users SET balance = balance + $2, updated_at = $3 WHERE id = $1`, [id, amount, nowIso()]);
        await ledgerPoly.insert({ userId: id, type: entry.type, amount, ref: entry.ref, note: entry.note });
        return mapUser((await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0]);
      },
      hold: async (id, amount, entry) => {
        const r = await pool.query(`UPDATE users SET balance = balance - $2, updated_at = $3 WHERE id = $1 AND balance >= $2`, [id, amount, nowIso()]);
        if (r.rowCount === 0) return null;
        await ledgerPoly.insert({ userId: id, type: entry.type, amount: -amount, ref: entry.ref, note: entry.note });
        return mapUser((await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0]);
      },
      balance: async (id) => {
        const u = await this.get(id);
        return u ? u.balance : 0;
      },
    },

    sessions: {
      create: async (userId, ttlDays) => {
        const token = crypto.randomBytes(24).toString('hex');
        const t1 = new Date(Date.now() + ttlDays * 86400000).toISOString();
        await pool.query(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)`, [token, userId, nowIso(), t1]);
        return token;
      },
      get: async (token) => {
        const r = await pool.query(`SELECT * FROM sessions WHERE token = $1`, [token]);
        const row = r.rows[0];
        if (!row) return null;
        if (new Date(row.expires_at).getTime() < Date.now()) {
          await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
          return null;
        }
        const u = mapUser((await pool.query(`SELECT * FROM users WHERE id = $1`, [row.user_id])).rows[0]);
        return { token, userId: row.user_id, expiresAt: row.expires_at, user: u };
      },
      destroy: async (token) => {
        await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
      },
    },

    payments: {
      create: async (p) => {
        await pool.query(`INSERT INTO payments (id, user_id, amount, fee, unique_code, pay_amount, qr_string, status, note, created_at, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10)`,
          [p.id, p.userId, p.amount, p.fee, p.uniqueCode, p.payAmount, p.qrString || null, p.note || null, nowIso(), p.expiresAt]);
        return this.get(p.id);
      },
      get: async (id) => {
        const r = await pool.query(`SELECT * FROM payments WHERE id = $1`, [id]);
        return r.rows[0] ? pix(r.rows[0]) : null;
      },
      getByPayAmount: async (amount) => {
        const r = await pool.query(`SELECT * FROM payments WHERE pay_amount = $1 AND status = 'PENDING' ORDER BY created_at ASC LIMIT 1`, [amount]);
        return r.rows[0] ? pix(r.rows[0]) : null;
      },
      listPending: async () => {
        const r = await pool.query(`SELECT * FROM payments WHERE status = 'PENDING' ORDER BY created_at ASC`);
        return r.rows.map(pix);
      },
      listByUser: async (userId, limit = 20) => {
        const r = await pool.query(`SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
        return r.rows.map(pix);
      },
      list: async ({ status, limit = 50 }) => {
        const sql = status ? `SELECT * FROM payments WHERE status = $1 ORDER BY created_at DESC LIMIT $2` : `SELECT * FROM payments ORDER BY created_at DESC LIMIT $1`;
        const r = status ? await pool.query(sql, [status, limit]) : await pool.query(sql, [limit]);
        return r.rows.map(pix);
      },
      markPaid: async (id, gobizId) => {
        const r = await pool.query(`UPDATE payments SET status = 'PAID', gobiz_id = $2, paid_at = $3 WHERE id = $1 AND status = 'PENDING'`, [id, gobizId || null, nowIso()]);
        return r.rowCount > 0;
      },
      expire: async (id) => {
        const r = await pool.query(`UPDATE payments SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING'`, [id]);
        return r.rowCount > 0;
      },
      expireDue: async () => {
        const r = await pool.query(`SELECT id FROM payments WHERE status = 'PENDING' AND expires_at < $1`, [nowIso()]);
        for (const row of r.rows) await this.expire(row.id);
        return r.rows.length;
      },
      countByStatus: async (status) => {
        const r = await pool.query(`SELECT COUNT(*) c, COALESCE(SUM(pay_amount),0) s FROM payments WHERE status = $1`, [status]);
        return { c: Number(r.rows[0].c), s: Number(r.rows[0].s || 0) };
      },
      dailyVolume: async (days) => {
        const from = new Date(Date.now() - days * 86400000).toISOString();
        const r = await pool.query(`SELECT substr(paid_at,1,10) d, COUNT(*) c, COALESCE(SUM(amount),0) s FROM payments WHERE status = 'PAID' AND paid_at >= $1 GROUP BY d ORDER BY d`, [from]);
        return r.rows.map(x => ({ d: x.d, c: Number(x.c), s: Number(x.s || 0) }));
      },
    },

    ledger: ledgerPoly,

    withdrawals: {
      create: async (p) => {
        await pool.query(`INSERT INTO withdrawals (id, user_id, amount, method, account_number, account_name, status, requested_at)
          VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7)`,
          [p.id, p.userId, p.amount, p.method, p.accountNumber || null, p.accountName || null, nowIso()]);
        return this.get(p.id);
      },
      get: async (id) => {
        const r = await pool.query(`SELECT * FROM withdrawals WHERE id = $1`, [id]);
        return r.rows[0];
      },
      listByUser: async (userId, limit = 20) => {
        const r = await pool.query(`SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY requested_at DESC LIMIT $2`, [userId, limit]);
        return r.rows;
      },
      list: async ({ status, limit = 50 }) => {
        const sql = status ? `SELECT * FROM withdrawals WHERE status = $1 ORDER BY requested_at DESC LIMIT $2` : `SELECT * FROM withdrawals ORDER BY requested_at DESC LIMIT $1`;
        const r = status ? await pool.query(sql, [status, limit]) : await pool.query(sql, [limit]);
        return r.rows;
      },
      updateStatus: async (id, status, adminNote) => {
        const r = await pool.query(`UPDATE withdrawals SET status = $2, admin_note = COALESCE($3, admin_note), processed_at = CASE WHEN $2 = 'PENDING' THEN processed_at ELSE $4 END WHERE id = $1`,
          [id, status, adminNote || null, nowIso()]);
        return r.rowCount > 0;
      },
      countByStatus: async (status) => {
        const r = await pool.query(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM withdrawals WHERE status = $1`, [status]);
        return { c: Number(r.rows[0].c), s: Number(r.rows[0].s || 0) };
      },
    },

    settings: {
      get: async (key, def = null) => {
        const r = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
        return r.rows[0] ? r.rows[0].value : def;
      },
      set: async (key, value) => {
        await pool.query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, String(value)]);
      },
      delete: async (key) => {
        await pool.query(`DELETE FROM settings WHERE key = $1`, [key]);
      },
      listAll: async () => {
        const r = await pool.query(`SELECT * FROM settings`);
        return r.rows;
      },
    },

    apiKeys: {
      create: async ({ userId, keyPrefix, keyHash, name }) => {
        const r = await pool.query(`INSERT INTO api_keys (user_id, key_prefix, key_hash, name, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [userId, keyPrefix, keyHash, name || null, nowIso()]);
        return r.rows[0];
      },
      getByHash: async (hash) => {
        const r = await pool.query(`SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [hash]);
        if (!r.rows[0]) return null;
        await pool.query(`UPDATE api_keys SET last_used_at = $2 WHERE id = $1`, [r.rows[0].id, nowIso()]);
        return r.rows[0];
      },
      listByUser: async (userId) => {
        const r = await pool.query(`SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
        return r.rows;
      },
      revoke: async (id, userId) => {
        const r = await pool.query(`UPDATE api_keys SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [id, userId, nowIso()]);
        return r.rowCount > 0;
      },
    },
  };
}

const pix = (r) => ({
  id: r.id, user_id: Number(r.user_id), amount: Number(r.amount), fee: Number(r.fee),
  unique_code: Number(r.unique_code), pay_amount: Number(r.pay_amount), qr_string: r.qr_string,
  status: r.status, gobiz_id: r.gobiz_id, note: r.note, paid_at: r.paid_at,
  created_at: r.created_at, expires_at: r.expires_at,
});

module.exports = { init };
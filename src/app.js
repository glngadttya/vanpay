const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

const { config } = require('./config');
const logger = require('../lib/logger');
const { randToken, makeRl, securityHeaders, safeEqual, clientIp } = require('../lib/security');
const github = require('../lib/auth/github');
const google = require('../lib/auth/google');
const paymentsSvc = require('./services/payments');
const withdrawals = require('./services/withdrawals');
const statsSvc = require('./services/stats');
const poller = require('./services/poller');
const { hasAuth } = require('./services/gobiz-state');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function buildApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb' }));

  app.use((req, _res, next) => {
    req.cookies = {};
    const h = req.headers.cookie;
    if (h) {
      for (const p of h.split(';')) {
        const i = p.indexOf('=');
        if (i > 0) req.cookies[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
      }
    }
    next();
  });

  const isSecure = /^https/.test(config.publicUrl);
  const setSession = (res, token) => {
    res.setHeader('Set-Cookie', `vanpay=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionTtlDays * 86400}${isSecure ? '; Secure' : ''}`);
  };
  const clearSession = (res) => {
    res.setHeader('Set-Cookie', 'vanpay=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  };

  async function loadUser(req) {
    const token = req.cookies.vanpay;
    if (!token) return null;
    const s = await db.sessions.get(token);
    if (!s) return null;
    req.user = s.user;
  }

  async function requireAuth(req, res, next) {
    await loadUser(req);
    if (!req.user) return res.status(401).json({ ok: false, error: 'Belum login' });
    if (req.user.status !== 'active') return res.status(403).json({ ok: false, error: 'Akun nonaktif' });
    next();
  }

  async function requireOwner(req, res, next) {
    await loadUser(req);
    if (!req.user) return res.status(401).json({ ok: false, error: 'Belum login' });
    if (req.user.role !== 'owner') return res.status(403).json({ ok: false, error: 'Hanya owner' });
    next();
  }

  const rlQris = makeRl((req) => (req.user ? 'u' + req.user.id : clientIp(req)), { windowMs: 60000, max: 12 });
  const rlWd = makeRl((req) => (req.user ? 'w' + req.user.id : clientIp(req)), { windowMs: 60000, max: 8 });

  const ok = (res, data) => res.json({ ok: true, data });
  const withAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------------- auth oauth ----------------

  app.get('/auth/github', withAsync(async (_req, res) => {
    if (!config.github.clientId) return res.status(503).send('GitHub login belum dikonfigurasi');
    const state = randToken(16);
    res.setHeader('Set-Cookie', `vp_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    res.redirect(github.authorizeUrl(state));
  }));

  app.get('/auth/github/callback', withAsync(async (req, res) => {
    if (req.cookies.vp_state && req.query.state && req.cookies.vp_state !== req.query.state) return res.status(400).send('State tidak cocok');
    const token = await github.exchange(String(req.query.code || ''));
    const info = await github.userInfo(token);
    await finishLogin(db, res, info);
  }));

  app.get('/auth/google', withAsync(async (_req, res) => {
    if (!config.google.clientId) return res.status(503).send('Google login belum dikonfigurasi');
    const state = randToken(16);
    res.setHeader('Set-Cookie', `vp_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    res.redirect(google.authorizeUrl(state));
  }));

  app.get('/auth/google/callback', withAsync(async (req, res) => {
    if (req.cookies.vp_state && req.query.state && req.cookies.vp_state !== req.query.state) return res.status(400).send('State tidak cocok');
    const token = await google.exchange(String(req.query.code || ''));
    const info = await google.userInfo(token);
    await finishLogin(db, res, info);
  }));

  async function finishLogin(db, res, info) {
    let user = await db.users.findOrCreate(info);
    if (!user) return res.status(500).send('Gagal membuat akun');
    if (config.ownerEmail && String(user.email).toLowerCase() === String(config.ownerEmail).toLowerCase() && user.role !== 'owner') {
      await db.users.promoteOwner(user.email);
      user = await db.users.get(user.id);
    }
    const token = await db.sessions.create(user.id, config.sessionTtlDays);
    setSession(res, token);
    logger.info(`[auth] login ${user.email} role=${user.role}`);
    res.redirect('/dashboard');
  }

  app.get('/logout', withAsync(async (req, res) => {
    if (req.cookies.vanpay) await db.sessions.destroy(req.cookies.vanpay);
    clearSession(res);
    res.redirect('/');
  }));

  // ---------------- public static ----------------

  app.use(express.static(PUBLIC_DIR));
  app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));

  app.get('/auth/me', withAsync(async (req, res) => {
    await loadUser(req);
    if (!req.user) return res.status(401).json({ ok: false, error: 'Belum login' });
    ok(res, publicUser(req.user));
  }));

  // ---------------- user api ----------------

  app.get('/api/bal', requireAuth, withAsync(async (req, res) => ok(res, { balance: req.user.balance })));

  app.get('/api/payments', requireAuth, withAsync(async (req, res) => {
    const rows = await db.payments.listByUser(req.user.id, 50);
    ok(res, rows.map((p) => ({
      id: p.id, amount: p.amount, fee: p.fee, payAmount: p.pay_amount, uniqueCode: p.unique_code,
      status: p.status, note: p.note, createdAt: p.created_at, paidAt: p.paid_at, expiresAt: p.expires_at,
    })));
  }));

  app.get('/api/ledger', requireAuth, withAsync(async (req, res) => {
    const rows = await db.ledger.listByUser(req.user.id, 100);
    ok(res, rows);
  }));

  app.get('/api/withdraws', requireAuth, withAsync(async (req, res) => {
    const rows = await db.withdrawals.listByUser(req.user.id, 50);
    ok(res, rows.map((w) => sanitizeWd(w, false)));
  }));

  app.get('/api/stats', requireAuth, withAsync(async (req, res) => {
    ok(res, await statsSvc.userStats(db, req.user));
  }));

  app.post('/api/qris/create', requireAuth, rlQris, withAsync(async (req, res) => {
    const txn = await paymentsSvc.createPayment(db, req.user, {
      amount: req.body.amount,
      note: req.body.note,
    });
    ok(res, {
      id: txn.id,
      amount: txn.amount,
      fee: txn.fee,
      payAmount: txn.pay_amount,
      uniqueCode: txn.unique_code,
      status: txn.status,
      expiresAt: txn.expires_at,
      note: txn.note,
      qrUrl: `/api/qris/${txn.id}/qr.png`,
      statusUrl: `/api/qris/${txn.id}/status`,
      paymentLink: `${config.publicUrl}/pay/${txn.id}`,
    });
  }));

  app.get('/api/qris/:id/qr.png', withAsync(async (req, res) => {
    const txn = await db.payments.get(req.params.id);
    if (!txn) return res.status(404).json({ ok: false, error: 'Not found' });
    await loadUser(req);
    if (!req.user || (req.user.id !== txn.user_id && req.user.role !== 'owner')) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const buf = await QRCode.toBuffer(txn.qr_string, { margin: 1, width: 400, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=60').send(buf);
  }));

  app.get('/api/qris/:id/status', withAsync(async (req, res) => {
    const txn = await db.payments.get(req.params.id);
    const st = await paymentsSvc.statusOf(txn);
    if (!st) return res.status(404).json({ ok: false, error: 'Not found' });
    poller.runCycleNow().catch(() => {});
    ok(res, { status: st.status, paidAt: txn.paid_at || null });
  }));

  app.get('/pay/:id', withAsync(async (req, res) => {
    const txn = await db.payments.get(req.params.id);
    await loadUser(req);
    if (!req.user) return res.redirect('/login');
    if (req.user.id !== txn.user_id && req.user.role !== 'owner') return res.status(403).send('Bukan punya lo');
    res.redirect('/dashboard?pay=' + txn.id);
  }));

  app.post('/api/withdraw', requireAuth, rlWd, withAsync(async (req, res) => {
    const wd = await withdrawals.requestWithdraw(db, req.user, {
      amount: req.body.amount,
      method: req.body.method,
      accountNumber: req.body.accountNumber,
      accountName: req.body.accountName,
    });
    ok(res, sanitizeWd(wd, true));
  }));

  // ---------------- owner api ----------------

  app.get('/api/admin/stats', requireOwner, withAsync(async (req, res) => ok(res, await statsSvc.ownerStats(db))));
  app.get('/api/admin/status', requireOwner, withAsync(async (req, res) => {
    ok(res, {
      gobizLinked: await hasAuth(db),
      qrisConfigured: !!config.qrisString,
      telegram: !!(config.telegram.botToken && config.telegram.chatId),
    });
  }));

  app.get('/api/admin/users', requireOwner, withAsync(async (req, res) => {
    const users = await db.users.list();
    const out = [];
    for (const u of users) {
      const pays = await db.payments.countByStatus('PAID');
      const wds = await db.withdrawals.listByUser(u.id, 500);
      const psum = (await db.payments.listByUser(u.id, 500)).filter((p) => p.status === 'PAID').reduce((a, p) => a + Number(p.amount || 0), 0);
      out.push({
        ...publicUser(u),
        totalDeposit: psum,
        totalWithdraw: wds.filter((w) => w.status === 'DONE').reduce((a, w) => a + Number(w.amount || 0), 0),
        pendingWithdraw: wds.filter((w) => w.status === 'PENDING').length,
      });
    }
    ok(res, out);
  }));

  app.get('/api/admin/payments', requireOwner, withAsync(async (req, res) => {
    const rows = await db.payments.list({ status: req.query.status || undefined, limit: 200 });
    ok(res, rows);
  }));

  app.get('/api/admin/withdrawals', requireOwner, withAsync(async (req, res) => {
    const rows = await db.withdrawals.list({ status: req.query.status || undefined, limit: 200 });
    const users = await db.users.list();
    const byId = new Map(users.map((u) => [u.id, publicUser(u)]));
    ok(res, rows.map((w) => ({ ...w, user: byId.get(w.user_id) || null })));
  }));

  app.post('/api/admin/withdrawals/:id/approve', requireOwner, withAsync(async (req, res) => ok(res, await withdrawals.approve(db, req.params.id))));
  app.post('/api/admin/withdrawals/:id/reject', requireOwner, withAsync(async (req, res) => {
    ok(res, await withdrawals.reject(db, req.params.id, req.body && req.body.note));
  }));

  app.post('/api/admin/withdrawals/:id/done', requireOwner, withAsync(async (req, res) => ok(res, await withdrawals.approve(db, req.params.id))));

  // ---------------- cron ----------------

  app.post('/api/cron/poll', withAsync(async (req, res) => {
    const secret = req.query.secret || (req.headers['x-poll-secret'] || '');
    if (!config.pollSecret || !safeEqual(secret, config.pollSecret)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    await poller.runCycleNow(db, true);
    ok(res, { fired: true });
  }));

  app.get('/api/cron/poll', withAsync(async (req, res) => {
    const secret = req.query.secret || (req.headers['x-poll-secret'] || '');
    if (!config.pollSecret || !safeEqual(secret, config.pollSecret)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    await poller.runCycleNow(db, true);
    ok(res, { fired: true });
  }));

  // ---------------- health & error ----------------

  app.get('/health', (_req, res) => res.json({ ok: true, name: 'vanpay', uptime: process.uptime() }));

  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err && err.expose ? (err.status || 500) : 500;
    const msg = err && err.expose ? err.message : 'Kesalahan internal';
    if (!err || !err.expose) logger.error('[route] ' + (err && err.stack ? err.stack : String(err)));
    if (res.headersSent) return;
    res.status(status).json({ ok: false, error: msg });
  });

  return app;
}

function sanitizeWd(w, showAccount) {
  return {
    id: w.id,
    amount: w.amount,
    method: w.method,
    accountNumber: showAccount ? w.account_number : undefined,
    accountName: showAccount ? w.account_name : undefined,
    status: w.status,
    adminNote: w.admin_note,
    requestedAt: w.requested_at,
    processedAt: w.processed_at,
  };
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatar: u.avatar,
    role: u.role,
    balance: u.balance,
    status: u.status,
    createdAt: u.created_at,
  };
}

module.exports = { buildApp, publicUser, sanitizeWd };
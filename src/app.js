const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

const { config } = require('./config');
const settings = require('./settings');
const logger = require('../lib/logger');
const { randToken, makeRl, securityHeaders, safeEqual, clientIp } = require('../lib/security');
const github = require('../lib/auth/github');
const google = require('../lib/auth/google');
const qris = require('../lib/qris');
const gobiz = require('../lib/gobiz');
const tg = require('../lib/telegram');
const paymentsSvc = require('./services/payments');
const withdrawals = require('./services/withdrawals');
const statsSvc = require('./services/stats');
const poller = require('./services/poller');
const gstate = require('./services/gobiz-state');
const pages = require('./pages');
const vh = require('../lib/view-helpers');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, '..', 'views');

function buildApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
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

  const isSecure = (req) => req.protocol === 'https' || String(req.get('x-forwarded-proto') || '').includes('https');
  const originOf = (req) => `${req.protocol}://${req.get('host')}`;
  const setSession = (req, res, token) => {
    res.setHeader('Set-Cookie', `vanpay=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionTtlDays * 86400}${isSecure(req) ? '; Secure' : ''}`);
  };
  const clearSession = (res) => {
    res.setHeader('Set-Cookie', 'vanpay=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  };

  const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const getApiKey = (req) => {
    const h = req.header('x-api-key') || '';
    if (h && h.trim()) return h.trim();
    const auth = req.header('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return m ? m[1].trim() : null;
  };

  async function loadUser(req) {
    const sToken = req.cookies.vanpay;
    if (sToken) {
      const s = await db.sessions.get(sToken);
      if (s) {
        req.user = s.user;
        return;
      }
    }
    const apiRaw = getApiKey(req);
    if (apiRaw) {
      const k = await db.apiKeys.getByHash(sha256(apiRaw));
      if (k) req.user = await db.users.get(k.user_id);
    }
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

  function ownerEmail() {
    return settings.get('oauth.owner_email', '') || config.ownerEmail;
  }

  const rlQris = makeRl((req) => (req.user ? 'u' + req.user.id : clientIp(req)), { windowMs: 60000, max: 12 });
  const rlWd = makeRl((req) => (req.user ? 'w' + req.user.id : clientIp(req)), { windowMs: 60000, max: 8 });
  const rlBootstrap = makeRl(() => 'bootstrap', { windowMs: 60000, max: 10 });
  const rlOtp = makeRl((req) => (req.user ? 'g' + req.user.id : clientIp(req)), { windowMs: 60000, max: 6 });
  const rlKey = makeRl((req) => (req.user ? 'k' + req.user.id : clientIp(req)), { windowMs: 60000, max: 10 });

  const ok = (res, data) => res.json({ ok: true, data });
  const withAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const gob = (fn) => withAsync(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      if (e && e.expose) throw e;
      const err = new Error('GoBiz tidak bisa dihubungi: ' + (e && e.message));
      err.status = 502;
      err.expose = true;
      throw err;
    }
  });

  // ---------------- bootstrap owner ----------------

  app.get('/bootstrap/:token', rlBootstrap, withAsync(async (req, res) => {
    const valid = settings.checkBootstrap(req.params.token);
    if (!valid) {
      const owner = await settings.hasOwner();
      return res.status(owner ? 404 : 400).send(owner ? 'Owner sudah ada.' : 'Token tidak valid.');
    }
    const origin = originOf(req);
    let user = await db.users.getByProvider('bootstrap', 'owner');
    if (!user) {
      user = await db.users.findOrCreate({
        provider: 'bootstrap', providerId: 'owner', email: 'owner@' + req.get('host'), name: 'VanPay Owner', avatar: '',
      });
      user = await db.users.getByEmail('owner@' + req.get('host'));
    }
    await db.users.promoteOwner(user.email);
    user = await db.users.getByEmail(user.email);
    const token = await db.sessions.create(user.id, config.sessionTtlDays);
    setSession(req, res, token);
    logger.info(`[auth] owner bootstrap: ${user.email}`);
    logger.info(`[auth] semua pengaturan ada di /dashboard -> PENGATURAN (origin ${origin})`);
    res.redirect('/dashboard?setup=1');
  }));

  // ---------------- auth oauth ----------------

  app.get('/auth/github', withAsync(async (req, res) => {
    const cid = config.github.clientId || settings.get('oauth.github_client_id', '');
    if (!cid) return res.status(503).send('GitHub login belum dikonfigurasi. Masuk sebagai owner terlebih dahulu melalui /bootstrap, lalu atur di Pengaturan.');
    const state = randToken(16);
    res.setHeader('Set-Cookie', `vp_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    res.redirect(github.authorizeUrl(state, originOf(req) + '/auth/github/callback'));
  }));

  app.get('/auth/github/callback', withAsync(async (req, res) => {
    if (req.cookies.vp_state && req.query.state && req.cookies.vp_state !== req.query.state) return res.status(400).send('State tidak cocok');
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Tidak ada kode OAuth');
    const token = await github.exchange(code, originOf(req) + '/auth/github/callback');
    const info = await github.userInfo(token);
    await finishLogin(req, res, info);
  }));

  app.get('/auth/google', withAsync(async (req, res) => {
    const cid = config.google.clientId || settings.get('oauth.google_client_id', '');
    if (!cid) return res.status(503).send('Google login belum dikonfigurasi. Masuk sebagai owner terlebih dahulu melalui /bootstrap, lalu atur di Pengaturan.');
    const state = randToken(16);
    res.setHeader('Set-Cookie', `vp_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    res.redirect(google.authorizeUrl(state, originOf(req) + '/auth/google/callback'));
  }));

  app.get('/auth/google/callback', withAsync(async (req, res) => {
    if (req.cookies.vp_state && req.query.state && req.cookies.vp_state !== req.query.state) return res.status(400).send('State tidak cocok');
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Tidak ada kode OAuth');
    const token = await google.exchange(code, originOf(req) + '/auth/google/callback');
    const info = await google.userInfo(token);
    await finishLogin(req, res, info);
  }));

  async function finishLogin(req, res, info) {
    let user = await db.users.findOrCreate(info);
    if (!user) return res.status(500).send('Gagal membuat akun');
    const ownerMail = ownerEmail();
    if (ownerMail && String(user.email).toLowerCase() === String(ownerMail).toLowerCase() && user.role !== 'owner') {
      await db.users.promoteOwner(user.email);
      user = await db.users.get(user.id);
    }
    const token = await db.sessions.create(user.id, config.sessionTtlDays);
    setSession(req, res, token);
    logger.info(`[auth] login ${user.email} role=${user.role}`);
    res.redirect('/dashboard');
  }

  app.get('/logout', withAsync(async (req, res) => {
    if (req.cookies.vanpay) await db.sessions.destroy(req.cookies.vanpay);
    clearSession(res);
    res.redirect('/');
  }));

  // ---------------- pages ----------------

  const renderLocals = () => ({
    esc: vh.esc,
    rupiah: vh.rupiah,
    fmt: vh.fmt,
    badge: vh.badge,
    chartBars: vh.chartBars,
    ledgerTypes: vh.ledgerTypes,
  });

  async function renderDash(req, res, pageRaw) {
    const page = pages.resolvePage(pageRaw, req.user.role, req.query);
    const pl = await pages.loadPage(db, req.user, page, { query: req.query, origin: originOf(req) });
    if (!pl) {
      const e = new Error('Halaman tidak ditemukan');
      e.status = 404;
      e.expose = true;
      throw e;
    }
    res.render('dashboard', { title: 'Dashboard — VanPay Gateway', ...renderLocals(), ...pl });
  }

  async function guard(req, res, next) {
    await loadUser(req);
    if (!req.user) {
      return res.status(200).send('<!doctype html><html lang="id"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/login"><title>VanPay</title></head><body style="font-family:sans-serif;padding:2rem;text-align:center">Sedang mengalihkan ke halaman masuk&hellip;</body></html>');
    }
    if (req.user.status !== 'active') {
      clearSession(res);
      return res.redirect('/');
    }
    next();
  }

  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.get('/', (_req, res) => res.render('index', { title: 'VanPay Gateway — Terima Pembayaran QRIS secara Instan' }));
  app.get('/cara-kerja', (_req, res) => res.render('cara', { title: 'Cara Kerja — VanPay Gateway' }));
  app.get('/docs', (_req, res) => res.render('docs', { title: 'Dokumentasi API — VanPay Gateway' }));
  app.get('/login', (req, res) => res.render('login', { title: 'Masuk — VanPay Gateway', esc: vh.esc, loginErr: String(req.query.err || '') }));
  app.get('/dashboard', guard, withAsync((req, res) => renderDash(req, res, '')));
  app.get('/dashboard/:page', guard, withAsync((req, res) => renderDash(req, res, req.params.page)));
  app.get('/admin', (_req, res) => res.redirect('/dashboard'));

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

  app.post('/api/withdraw', requireAuth, rlWd, withAsync(async (req, res) => {
    const wd = await withdrawals.requestWithdraw(db, req.user, {
      amount: req.body.amount,
      method: req.body.method,
      accountNumber: req.body.accountNumber,
      accountName: req.body.accountName,
    });
    ok(res, sanitizeWd(wd, true));
  }));

  // ---------------- developer tools (api keys) ----------------

  app.get('/api/keys', requireAuth, withAsync(async (req, res) => {
    const rows = await db.apiKeys.listByUser(req.user.id);
    ok(res, rows.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.key_prefix,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revoked: !!k.revoked_at,
    })));
  }));

  app.post('/api/keys', requireAuth, rlKey, withAsync(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const raw = 'vk_' + crypto.randomBytes(16).toString('hex');
    const row = await db.apiKeys.create({
      userId: req.user.id,
      keyPrefix: raw.slice(0, 8),
      keyHash: sha256(raw),
      name: name || null,
    });
    logger.info(`[keys] buat api key #${row.id} user#${req.user.id}`);
    ok(res, { id: row.id, name: row.name, key: raw, prefix: row.key_prefix, createdAt: row.created_at });
  }));

  app.delete('/api/keys/:id', requireAuth, withAsync(async (req, res) => {
    const id = Number(req.params.id);
    const done = await db.apiKeys.revoke(id, req.user.id);
    if (!done) return res.status(404).json({ ok: false, error: 'Key tidak ditemukan' });
    ok(res, { revoked: true });
  }));

  // ---------------- owner api ----------------

  app.get('/api/admin/stats', requireOwner, withAsync(async (req, res) => ok(res, await statsSvc.ownerStats(db))));

  app.get('/api/admin/status', requireOwner, withAsync(async (req, res) => {
    ok(res, {
      gobizLinked: await gstate.hasAuth(db),
      gobiz: await gstate.getAuth(db),
      qrisConfigured: !!(settings.get('qr.qris_string', '') || config.qrisString),
      owners: (await db.users.list()).filter((u) => u.role === 'owner').length,
    });
  }));

  app.get('/api/admin/settings', requireOwner, withAsync(async (req, res) => {
    const gobAuth = await gstate.getAuth(db);
    ok(res, {
      qr: { qris_string: settings.get('qr.qris_string', ''), mode: settings.get('qr.mode', 'dynamic') },
      billing: {
        fee_pct: settings.getNum('billing.fee_pct', config.feePct),
        min_fee: settings.getNum('billing.min_fee', config.minFee),
        min_qris: settings.getNum('billing.min_qris', config.minQrisAmount),
        max_qris: settings.getNum('billing.max_qris', config.maxQrisAmount),
        min_wd: settings.getNum('billing.min_wd', config.minWithdraw),
        max_wd: settings.getNum('billing.max_wd', config.maxWithdraw),
      },
      oauth: {
        github_client_id: config.github.clientId || settings.get('oauth.github_client_id', ''),
        google_client_id: config.google.clientId || settings.get('oauth.google_client_id', ''),
        owner_email: ownerEmail(),
      },
      tg: {
        bot_token: settings.get('tg.bot_token', '') || config.telegram.botToken,
        chat_id: settings.get('tg.chat_id', '') || config.telegram.chatId,
      },
      gobiz: {
        linked: !!(gobAuth.accessToken && gobAuth.merchantId),
        merchantId: gobAuth.merchantId || '',
        merchantName: gobAuth.name || '',
        phone: gobAuth.phone || '',
        hasRefreshToken: !!gobAuth.refreshToken,
      },
      sys: {
        lastPollAt: settings.get('sys.lastPollAt', '') ,
        lastPollMsg: settings.get('sys.lastPollMsg', 'Belum pernah polling'),
        lastPollCount: settings.get('sys.lastPollCount', '0'),
        bootstrapActive: process.env.SKIP_BOOTSTRAP ? false : true,
      },
      envGobiz: !!(config.goPay.phone || config.goPay.accessToken),
    });
  }));

  const SETTABLE = new Set([
    'qr.qris_string', 'qr.mode',
    'billing.fee_pct', 'billing.min_fee', 'billing.min_qris', 'billing.max_qris', 'billing.min_wd', 'billing.max_wd',
    'oauth.github_client_id', 'oauth.github_client_secret', 'oauth.google_client_id', 'oauth.google_client_secret', 'oauth.owner_email',
    'tg.bot_token', 'tg.chat_id',
  ]);

  app.post('/api/admin/settings', requireOwner, withAsync(async (req, res) => {
    const entries = req.body && (req.body.entries || req.body);
    if (!entries || typeof entries !== 'object') return res.status(400).json({ ok: false, error: 'entries wajib objek' });
    const saved = [];
    for (const [key, value] of Object.entries(entries)) {
      if (!SETTABLE.has(key)) continue;
      if (key === 'qr.qris_string') {
        const v = String(value || '').trim();
        if (v) {
          try { qris.qrToPayload(v); } catch (e) { return res.status(400).json({ ok: false, error: 'QRIS tidak valid: ' + e.message }); }
        }
        await settings.set(key, v);
        saved.push(key);
        continue;
      }
      await settings.set(key, value);
      saved.push(key);
    }
    logger.info('[admin] settings disimpan: ' + saved.join(', '));
    ok(res, { saved });
  }));

  app.post('/api/admin/gobiz/otp', requireOwner, rlOtp, gob(async (req, res) => {
    const phone = String(req.body.phone || '').trim();
    const cc = String(req.body.cc || '+62').trim();
    if (!phone) return res.status(400).json({ ok: false, error: 'Nomor wajib diisi' });
    await gobiz.requestOtp(phone, cc);
    await db.settings.set('gobiz.otpPhone', cc + phone);
    ok(res, { sent: true, to: cc + phone });
  }));

  app.post('/api/admin/gobiz/verify', requireOwner, rlOtp, gob(async (req, res) => {
    let phone = String(req.body.phone || '').trim();
    const cc = String(req.body.cc || '+62').trim();
    if (!phone) phone = String(await db.settings.get('gobiz.otpPhone', '')).replace(cc, '');
    const otp = String(req.body.otp || '').trim().replace(/\s+/g, '');
    if (!phone || !otp) return res.status(400).json({ ok: false, error: 'Nomor & OTP wajib' });
    const tok = await gobiz.verifyOtp(phone, cc, otp);
    let merchantId = tok.merchantId;
    if (!merchantId) merchantId = await gobiz.detectMerchantId(tok.accessToken);
    await gstate.saveAuth(db, { ...tok, merchantId, phone });
    logger.info(`[admin] GoBiz OTP login OK merchant=${merchantId || '?'}`);
    ok(res, { linked: !!merchantId, merchantId: merchantId || '', name: tok.raw && (tok.raw.merchant && tok.raw.merchant.name) || '' });
    db.settings.delete('gobiz.otpPhone').catch(() => {});
  }));

  app.post('/api/admin/gobiz/password', requireOwner, rlOtp, gob(async (req, res) => {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email & password wajib' });
    const tok = await gobiz.loginWithPassword(email, password);
    let merchantId = tok.merchantId;
    if (!merchantId) merchantId = await gobiz.detectMerchantId(tok.accessToken);
    await gstate.saveAuth(db, { ...tok, merchantId, phone: tok.raw && tok.raw.phone || '' });
    logger.info(`[admin] GoBiz password login OK merchant=${merchantId || '?'}`);
    ok(res, { linked: !!merchantId, merchantId: merchantId || '', name: tok.raw && (tok.raw.merchant && tok.raw.merchant.name) || '' });
  }));

  app.post('/api/admin/gobiz/refresh', requireOwner, gob(async (req, res) => {
    const cur = await gstate.getAuth(db);
    if (!cur.refreshToken) return res.status(400).json({ ok: false, error: 'Refresh token tidak ditemukan. Silakan login ulang.' });
    const tok = await gobiz.refresh(cur.refreshToken);
    await gstate.saveAuth(db, { ...tok, merchantId: tok.merchantId || cur.merchantId, phone: cur.phone, name: cur.name });
    ok(res, { ok: true, linked: true });
  }));

  app.post('/api/admin/gobiz/logout', requireOwner, gob(async (req, res) => {
    await gstate.clearAuth(db);
    ok(res, { ok: true });
  }));

  app.post('/api/admin/telegram/test', requireOwner, withAsync(async (req, res) => {
    ok(res, await tg.testSend());
  }));

  app.get('/api/admin/users', requireOwner, withAsync(async (req, res) => {
    const users = await db.users.list();
    const out = [];
    for (const u of users) {
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
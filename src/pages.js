const { config } = require('./config');
const settings = require('./settings');
const statsSvc = require('./services/stats');
const paymentsSvc = require('./services/payments');
const gstate = require('./services/gobiz-state');
const withdrawalsSvc = require('./services/withdrawals');

const USER_PAGES = new Set(['overview', 'pay', 'payments', 'withdraw', 'ledger', 'developers']);
const OWNER_PAGES = new Set(['o-overview', 'o-users', 'o-payments', 'o-withdrawals', 'o-setup']);

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, avatar: u.avatar,
    role: u.role, balance: u.balance, status: u.status, createdAt: u.created_at,
  };
}

function sanitizeWd(w, showAccount) {
  return {
    id: w.id, amount: w.amount, method: w.method,
    accountNumber: showAccount ? w.account_number : undefined,
    accountName: showAccount ? w.account_name : undefined,
    status: w.status, adminNote: w.admin_note,
    requestedAt: w.requested_at, processedAt: w.processed_at,
  };
}

function ownerEmail() {
  return settings.get('oauth.owner_email', '') || config.ownerEmail;
}

async function loadPage(db, user, page, ctx) {
  const qry = ctx.query || {};
  const pl = { page, me: user, msg: qry.msg || '', err: qry.err || '' };

  if (page === 'overview') {
    pl.stats = await statsSvc.userStats(db, user);
    return pl;
  }
  if (page === 'pay') {
    pl.billing = {
      minQris: settings.getNum('billing.min_qris', config.minQrisAmount),
      maxQris: settings.getNum('billing.max_qris', config.maxQrisAmount),
      feePct: settings.getNum('billing.fee_pct', config.feePct),
    };
    pl.txn = null;
    if (qry.ref) {
      const txn = await db.payments.get(qry.ref);
      if (txn && txn.user_id === user.id) {
        const st = await paymentsSvc.statusOf(txn);
        pl.txn = {
          id: txn.id, amount: txn.amount, fee: txn.fee,
          payAmount: txn.payAmount, pay_amount: txn.pay_amount, uniqueCode: txn.unique_code,
          status: st.status, note: txn.note, expiresAt: txn.expires_at,
          qrUrl: `/api/qris/${txn.id}/qr.png`,
          statusUrl: `/api/qris/${txn.id}/status`,
        };
      }
    }
    return pl;
  }
  if (page === 'payments') {
    const rows = await db.payments.listByUser(user.id, 50);
    pl.list = rows.map((p) => ({
      id: p.id, amount: p.amount, fee: p.fee, payAmount: p.pay_amount, uniqueCode: p.unique_code,
      status: p.status, note: p.note, createdAt: p.created_at, paidAt: p.paid_at, expiresAt: p.expires_at,
    }));
    return pl;
  }
  if (page === 'withdraw') {
    pl.me = _me(user);
    pl.billing = { minWd: settings.getNum('billing.min_wd', config.minWithdraw), maxWd: settings.getNum('billing.max_wd', config.maxWithdraw) };
    pl.methods = withdrawalsSvc.METHODS;
    const rows = await db.withdrawals.listByUser(user.id, 50);
    pl.list = rows.map((w) => sanitizeWd(w, false));
    return pl;
  }
  if (page === 'ledger') {
    const rows = await db.ledger.listByUser(user.id, 100);
    pl.rows = rows.map((r) => ({
      id: r.id, type: r.type, amount: r.amount, ref: r.ref, note: r.note, createdAt: r.created_at,
    }));
    return pl;
  }
  if (page === 'developers') {
    const rows = await db.apiKeys.listByUser(user.id);
    pl.keys = rows.map((k) => ({
      id: k.id, name: k.name, prefix: k.key_prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at, revoked: !!k.revoked_at,
    }));
    pl.apiBase = `${ctx.origin || ''}`;
    return pl;
  }

  // ---------- owner ----------
  if (page === 'o-overview') {
    pl.stats = await statsSvc.ownerStats(db);
    return pl;
  }
  if (page === 'o-users') {
    const users = await db.users.list();
    const out = [];
    for (const u of users) {
      out.push(await aggregateUser(db, u));
    }
    pl.list = out;
    return pl;
  }
  if (page === 'o-payments') {
    const rows = await db.payments.list({ status: qry.status || undefined, limit: 300 });
    pl.list = rows;
    pl.filter = qry.status || '';
    return pl;
  }
  if (page === 'o-withdrawals') {
    const [pending, all] = await Promise.all([
      db.withdrawals.list({ status: 'PENDING', limit: 200 }),
      db.withdrawals.list({ status: qry.status || undefined, limit: 300 }),
    ]);
    const users = await db.users.list();
    const byId = new Map(users.map((u) => [u.id, publicUser(u)]));
    pl.pending = pending.map((w) => ({ ...sanitizeWd(w, true), user: byId.get(w.user_id) || null }));
    pl.all = all.map((w) => ({ ...sanitizeWd(w, false), user: byId.get(w.user_id) || null }));
    pl.filter = qry.status || '';
    return pl;
  }
  if (page === 'o-setup') {
    const gobAuth = await gstate.getAuth(db);
    pl.origin = `${ctx.origin || ''}`;
    pl.s = {
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
        lastPollAt: settings.get('sys.lastPollAt', ''),
        lastPollMsg: settings.get('sys.lastPollMsg', 'Belum pernah polling'),
        lastPollCount: settings.get('sys.lastPollCount', '0'),
        bootstrapActive: process.env.SKIP_BOOTSTRAP ? false : true,
      },
      envGobiz: !!(config.goPay.phone || config.goPay.accessToken),
    };
    return pl;
  }

  return null;
}

async function aggregateUser(db, u) {
  const wds = await db.withdrawals.listByUser(u.id, 500);
  const pays = await db.payments.listByUser(u.id, 500);
  const psum = pays.filter((p) => p.status === 'PAID').reduce((a, p) => a + Number(p.amount || 0), 0);
  return {
    ...publicUser(u),
    totalDeposit: psum,
    totalWithdraw: wds.filter((w) => w.status === 'DONE').reduce((a, w) => a + Number(w.amount || 0), 0),
    pendingWithdraw: wds.filter((w) => w.status === 'PENDING').length,
  };
}

function _me(u) {
  return publicUser(u);
}

function isAllowed(page, role) {
  if (!page) return false;
  if (role === 'owner' && OWNER_PAGES.has(page)) return true;
  if (USER_PAGES.has(page)) return true;
  return false;
}

function resolvePage(page, role, qry) {
  let p = page && isAllowed(page, role) ? page : '';
  if (!p) p = role === 'owner' ? 'o-overview' : 'overview';
  if (role === 'owner' && qry.setup) p = 'o-setup';
  if (qry.pay) p = 'pay';
  return p;
}

module.exports = { loadPage, isAllowed, resolvePage, publicUser, sanitizeWd, aggregateUser, ownerEmail };
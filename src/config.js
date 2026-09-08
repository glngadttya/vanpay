const n = (v, d) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};
const raw = (k, d = '') => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};

const config = {
  port: n(process.env.PORT, 3000),
  publicUrl: raw('PUBLIC_URL', '').replace(/\/+$/, ''),

  dbFile: raw('DB_FILE', 'data/vanpay.db'),
  databaseUrl: raw('DATABASE_URL', ''),

  qrisString: raw('QRIS_STRING', ''),

  feePct: n(process.env.FEE_PCT, 0.7),
  minFee: n(process.env.MIN_FEE, 0),
  minQrisAmount: n(process.env.MIN_QRIS_AMOUNT, 1000),
  maxQrisAmount: n(process.env.MAX_QRIS_AMOUNT, 100000000),
  minWithdraw: n(process.env.MIN_WITHDRAW, 5000),
  maxWithdraw: n(process.env.MAX_WITHDRAW, 50000000),

  uniqueCodeMax: n(process.env.UNIQUE_CODE_MAX, 99),
  expireMinutes: n(process.env.EXPIRE_MINUTES, 15),

  ownerEmail: raw('OWNER_EMAIL', ''),
  sessionTtlDays: n(process.env.SESSION_TTL_DAYS, 7),

  github: {
    clientId: raw('GITHUB_CLIENT_ID', ''),
    clientSecret: raw('GITHUB_CLIENT_SECRET', ''),
  },
  google: {
    clientId: raw('GOOGLE_CLIENT_ID', ''),
    clientSecret: raw('GOOGLE_CLIENT_SECRET', ''),
  },

  goPay: {
    phone: raw('GOPAY_PHONE', ''),
    countryCode: raw('GOPAY_COUNTRY_CODE', '+62'),
    email: raw('GOPAY_EMAIL', ''),
    password: raw('GOPAY_PASSWORD', ''),
    accessToken: raw('GOPAY_ACCESS_TOKEN', ''),
  },

  telegram: {
    botToken: raw('TELEGRAM_BOT_TOKEN', ''),
    chatId: raw('TELEGRAM_CHAT_ID', ''),
  },

  pollMinIntervalMs: n(process.env.POLL_MIN_INTERVAL_MS, 7000),
  pollSecret: raw('POLL_SECRET', ''),
  webhookSecret: raw('WEBHOOK_SECRET', ''),
};

function checkConfig() {
  const out = [];
  if (!config.qrisString) {
    out.push({ fatal: true, msg: 'QRIS_STRING wajib diisi (QRIS statis GoBiz merchant lu).' });
  } else {
    if (n(process.env.QRIS_CRC_OK, 1) !== 0) {
      try { require('../lib/qris').qrToPayload(config.qrisString); } catch (e) { out.push({ fatal: true, msg: 'QRIS_STRING tidak valid: ' + e.message }); }
    }
  }
  if (!config.github.clientId || !config.github.clientSecret) {
    out.push({ msg: 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET belum diisi — login GitHub nonaktif.' });
  }
  if (!config.google.clientId || !config.google.clientSecret) {
    out.push({ msg: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum diisi — login Google nonaktif.' });
  }
  if (!config.telegram.botToken || !config.telegram.chatId) {
    out.push({ msg: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diisi — notif Telegram nonaktif.' });
  }
  if (!config.goPay.phone && !config.goPay.accessToken) {
    out.push({ msg: 'Kredensial GoBiz belum diisi — polling pembayaran nonaktif sampai login GoBiz.' });
  }
  if (config.webhookSecret === 'change-me') {
    out.push({ fatal: true, msg: 'WEBHOOK_SECRET default tidak boleh dipakai di production.' });
  }
  return out;
}

module.exports = { config, checkConfig };
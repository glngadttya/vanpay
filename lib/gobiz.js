const crypto = require('crypto');
const logger = require('./logger');

const mkid = () => crypto.randomUUID();

// Path yang umum dipakai scraper GoBiz/GoPay Merchant.
// Semua bisa dioverride via env kalau program/API merchant berubah.
const GOB = {
  host: process.env.GOBIZ_HOST || 'https://blockchain.gobiz.co.id',
  appVersion: process.env.GOBIZ_APP_VERSION || '5.7.0',
  appId: process.env.GOBIZ_APP_ID || 'co.gobiz.flutter',
  deviceId: process.env.GOBIZ_DEVICE_ID || '',
};

function headers(extra = {}) {
  return {
    'x-appversion': GOB.appVersion,
    'x-appid': GOB.appId,
    'x-uniquedeviceid': GOB.deviceId || mkid(),
    'x-phoneserialnumber': mkid().replace(/-/g, ''),
    'x-user-type': 'customer',
    'x-location': '-6.200000,106.816666',
    'Content-Type': 'application/json; charset=UTF-8',
    Accept: 'application/json',
    ...extra,
  };
}

async function net(path, { method = 'GET', body, token } = {}) {
  const h = headers(token ? { Authorization: `Bearer ${token}` } : {});
  const res = await fetch(GOB.host + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { }
  if (!res.ok) {
    const err = data && (data.message || data.error || data.errors) ? JSON.stringify(data.message || data.error || data.errors) : `HTTP ${res.status}`;
    throw new Error(`GoBiz ${method} ${path} => ${err}`);
  }
  const tokenData = data && data.data;
  return { raw: data, data: tokenData || {} };
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

// requestOtp(phone, cc) -> mengirim OTP SMS
async function requestOtp(phone, countryCode = '+62') {
  logger.info(`[gobiz] request OTP ke ${countryCode}${phone}`);
  const r = await net('/v3/customers/login_with_phone', {
    method: 'POST',
    body: { phone: countryCode + phone, behavior: 'POST_REG_OTP', device_info: { webView: false, hasNotch: false, hasFingerprint: true, platform: 'Android', os_version: '10', manufacturer: 'samsung', model: 'SM-G975F' } },
  });
  return r;
}

// verifyOtp(phone, countryCode, otpCode) -> get access_token + refresh_token
async function verifyOtp(phone, countryCode, otpCode) {
  logger.info('[gobiz] verify OTP');
  const r = await net('/v3/customers/login_with_phone_otp', {
    method: 'POST',
    body: { phone: countryCode + phone, otp_code: String(otpCode), behavior: 'POST_REG_OTP' },
  });
  return extractAuth(r.raw);
}

// loginWithPassword(email, password) -> get access_token + refresh_token
async function loginWithPassword(email, password) {
  logger.info('[gobiz] login with password');
  const r = await net('/v1/customers/login_with_password', {
    method: 'POST',
    body: { email, password, job_number: 'GOMERCHANT-1514855', helper: true },
  });
  return extractAuth(r.raw);
}

function extractAuth(raw) {
  const d = raw && raw.data ? raw.data : raw || {};
  const accessToken = pick(d, ['access_token', 'accessToken', 'token']) || (d.auth && d.auth.access_token) || '';
  const refreshToken = pick(d, ['refresh_token', 'refreshToken']) || (d.auth && d.auth.refresh_token) || '';
  const merchantId = pick(d, ['merchant_id', 'merchantId']) || (d.merchant && (d.merchant.id || d.merchant.merchant_id)) || (d.user && d.user.merchant_id) || '';
  return { accessToken, refreshToken, merchantId, raw: d };
}

async function refresh(refreshToken) {
  if (!refreshToken) throw new Error('refresh_token kosong');
  const r = await net('/v1/customers/refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });
  return extractAuth(r.raw);
}

// getHistory(token, merchantId, {fromIso, toIso}) -> daftar pembayaran masuk
async function getHistory(token, merchantId, { fromIso, toIso } = {}) {
  const to = toIso || new Date().toISOString();
  const from = fromIso || new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const rows = [];
  try {
    rows.push(...(await analytics(token, merchantId, from, to)));
  } catch (e) {
    logger.warn('[gobiz] analytics gagal, fallback journal: ' + e.message);
    rows.push(...(await journals(token, merchantId, from, to)));
  }
  return normalize(rows);
}

async function analytics(token, merchantId, fromIso, toIso) {
  const r = await net(`/api/v1/analytics/journals?start_date=${encodeURIComponent(fromIso)}&end_date=${encodeURIComponent(toIso)}&size=100`, { token });
  return r.raw && (r.raw.data || r.raw.result) ? (r.raw.data || r.raw.result) : [];
}

async function journals(token, merchantId, fromIso, toIso) {
  const r = await net(`/api/v2/analytics/transactions?merchant_id=${merchantId}&start_date=${encodeURIComponent(fromIso)}&end_date=${encodeURIComponent(toIso)}&type=PAY&status=DONE`, { token });
  return r.raw && (r.raw.data || r.raw.result) ? (r.raw.data || r.raw.result) : [];
}

function normalize(rows) {
  const out = [];
  for (const r of rows ? rows : []) {
    const amount = Number(pick(r, ['amount', 'total_amount', 'gross_sales', 'nominal']));
    const ts = pick(r, ['created_at', 'createdAt', 'transaction_time', 'paid_at', 'datetime', 'created_date_time']);
    if (!amount || amount <= 0) continue;
    out.push({
      amount,
      ts: ts || new Date().toISOString(),
      trxId: String(pick(r, ['trx_id', 'transaction_id', 'order_id', 'id', 'ref_no', 'reference_no']) || ''),
      note: String(pick(r, ['payment_description', 'note', 'description', 'customer_name']) || ''),
      direction: String(pick(r, ['type', 'transaction_type', 'flow']) || ''),
    });
  }
  return out;
}

async function detectMerchantId(token) {
  try {
    const r = await net('/v3/customers/user_info', { token });
    const id = extractAuth({ data: r.data }).merchantId || pick(r.data, ['merchant_id', 'merchantId']) || (r.data.merchant && r.data.merchant.id);
    if (id) return String(id);
  } catch (e) {
    logger.warn('[gobiz] user_info gagal: ' + e.message);
  }
  try {
    const r = await net('/v2/merchant/info', { token });
    const id = pick(r.data, ['merchant_id', 'merchantId', 'id']);
    if (id) return String(id);
  } catch (e) {
    logger.warn('[gobiz] merchant info gagal: ' + e.message);
  }
  return '';
}

module.exports = { requestOtp, verifyOtp, loginWithPassword, refresh, getHistory, detectMerchantId, normalize, extractAuth, GOB };
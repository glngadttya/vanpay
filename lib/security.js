const crypto = require('crypto');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function signBody(body, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(typeof body === 'string' ? body : JSON.stringify(body))
    .digest('hex');
}

function randToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function makeRl(getKey, opts = {}) {
  const map = new Map();
  const { windowMs = 60000, max = 30 } = opts;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.start > windowMs) map.delete(k);
  }, 30000).unref();
  return function rateLimit(req, res, next) {
    const key = getKey(req);
    const now = Date.now();
    const rec = map.get(key);
    if (!rec || now - rec.start > windowMs) {
      map.set(key, { start: now, count: 1 });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      res.set('Retry-After', String(Math.ceil((rec.start + windowMs - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan, coba lagi nanti.' });
    }
    next();
  };
}

function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
}

function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  if (f) return String(f).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || '';
}

module.exports = { safeEqual, signBody, randToken, makeRl, securityHeaders, clientIp };
const { config } = require('../config');

const KEYS = {
  at: 'gobiz.at',
  rt: 'gobiz.rt',
  mid: 'gobiz.mid',
  phone: 'gobiz.phone',
  name: 'gobiz.merchantName',
};

async function getAuth(db) {
  const [accessToken, refreshToken, merchantId, phone, name] = await Promise.all([
    db.settings.get(KEYS.at, ''), db.settings.get(KEYS.rt, ''), db.settings.get(KEYS.mid, ''),
    db.settings.get(KEYS.phone, ''), db.settings.get(KEYS.name, ''),
  ]);
  return { accessToken, refreshToken, merchantId: merchantId || '', phone, name };
}

async function saveAuth(db, tok) {
  if (tok.accessToken) await db.settings.set(KEYS.at, String(tok.accessToken));
  if (tok.refreshToken) await db.settings.set(KEYS.rt, String(tok.refreshToken));
  if (tok.merchantId) await db.settings.set(KEYS.mid, String(tok.merchantId));
  if (tok.phone) await db.settings.set(KEYS.phone, String(tok.phone));
  if (tok.name) await db.settings.set(KEYS.name, String(tok.name));
}

async function clearAuth(db) {
  for (const k of Object.values(KEYS)) await db.settings.delete(k);
}

async function hasAuth(db) {
  const a = await getAuth(db);
  return !!(a.accessToken && a.merchantId);
}

module.exports = { getAuth, saveAuth, clearAuth, hasAuth };
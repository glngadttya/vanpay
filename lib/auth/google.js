const { config } = require('../../src/config');

function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.publicUrl + '/auth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function exchange(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.publicUrl + '/auth/google/callback',
      grant_type: 'authorization_code',
    }).toString(),
  });
  const j = await res.json();
  if (j.error) throw new Error('Google OAuth: ' + (j.error_description || j.error));
  return j.access_token;
}

async function userInfo(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  if (!j.id) throw new Error('Google userInfo gagal');
  return {
    provider: 'google',
    providerId: String(j.id),
    email: j.email,
    name: j.name,
    avatar: j.picture,
  };
}

module.exports = { authorizeUrl, exchange, userInfo };
const { config } = require('../../src/config');

function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: config.publicUrl + '/auth/github/callback',
    scope: 'read:user user:email',
    state,
  });
  return 'https://github.com/login/oauth/authorize?' + p.toString();
}

async function exchange(code) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: config.publicUrl + '/auth/github/callback',
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error('GitHub OAuth: ' + (j.error_description || j.error));
  return j.access_token;
}

async function userInfo(token) {
  const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  const j = await res.json();
  if (j.id === undefined) throw new Error('GitHub userInfo gagal');
  let email = j.email;
  if (!email) {
    const re = await fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
    const emails = await re.json();
    const primary = (Array.isArray(emails) ? emails : []).find((e) => e.primary && e.verified);
    email = primary ? primary.email : (Array.isArray(emails) && emails[0] ? emails[0].email : `${j.login}@users.noreply.github.com`);
  }
  return {
    provider: 'github',
    providerId: String(j.id),
    email,
    name: j.name || j.login,
    avatar: j.avatar_url,
  };
}

module.exports = { authorizeUrl, exchange, userInfo };
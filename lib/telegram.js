const { config } = require('../src/config');
const settings = require('../src/settings');
const logger = require('./logger');

const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

function tgCreds() {
  return {
    botToken: settings.get('tg.bot_token', '') || config.telegram.botToken,
    chatId: settings.get('tg.chat_id', '') || config.telegram.chatId,
  };
}

async function sendText(text) {
  const { botToken, chatId } = tgCreds();
  if (!botToken || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      logger.warn('[telegram] gagal: ' + JSON.stringify(j).slice(0, 300));
    }
  } catch (e) {
    logger.warn('[telegram] error: ' + e.message);
  }
}

async function testSend() {
  const { botToken, chatId } = tgCreds();
  if (!botToken || !chatId) return { sent: false, error: 'Token/chat id belum diisi' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: 'Notifikasi VanPay aktif dan terhubung.', parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) return { sent: false, error: (j && (j.description || j.error)) || 'HTTP ' + res.status };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));

function deposit(user, amount, txn) {
  return sendText(
    `<b>DEPOSIT MASUK</b>\n\n` +
    `<b>Nominal</b>: ${rupiah(amount)}\n` +
    `<b>Pengguna</b>: ${esc(user.name || user.email)} (${esc(user.email)})\n` +
    `<b>TXN</b>: <code>${txn.id}</code>\n` +
    `<b>Waktu</b>: ${new Date().toLocaleString('id-ID')}\n\n` +
    `Saldo otomatis dikreditkan.`
  );
}

function withdrawRequest(user, wd, balance) {
  return sendText(
    `<b>WITHDRAW BARU</b>\n\n` +
    `<b>Nominal</b>: ${rupiah(wd.amount)}\n` +
    `<b>Metode</b>: ${esc(wd.method)}\n` +
    `<b>Akun</b>: ${esc(wd.account_name || '-')} (${esc(wd.account_number || '-')})\n` +
    `<b>Pengguna</b>: ${esc(user.name || user.email)} (${esc(user.email)})\n` +
    `<b>Saldo tersisa</b>: ${rupiah(balance)}\n` +
    `<b>ID</b>: <code>${wd.id}</code>\n\n` +
    `Proses manual melalui dashboard owner (maksimal 1-24 jam)`
  );
}

function withdrawProcessed(wd, status, note) {
  const tag = status === 'DONE' ? 'SELESAI' : 'DITOLAK';
  return sendText(
    `<b>WITHDRAW ${tag}</b>\n\n` +
    `<b>Nominal</b>: ${rupiah(wd.amount)}\n` +
    `<b>Metode</b>: ${esc(wd.method)} (${esc(wd.account_number || '-')})\n` +
    `<b>ID</b>: <code>${wd.id}</code>\n` +
    (note ? `<b>Catatan</b>: ${esc(note)}\n` : '')
  );
}

module.exports = { sendText, testSend, deposit, withdrawRequest, withdrawProcessed, rupiah };
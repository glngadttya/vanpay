const { config } = require('../src/config');
const logger = require('./logger');

const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

async function sendText(text) {
  const { botToken, chatId } = config.telegram;
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

const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));

function deposit(user, amount, txn) {
  return sendText(
    `\u{1F514} <b>DEPOSIT MASUK</b>\n\n` +
    `<b>Nominal</b>: ${rupiah(amount)}\n` +
    `<b>Pengguna</b>: ${esc(user.name || user.email)} (${esc(user.email)})\n` +
    `<b>TXN</b>: <code>${txn.id}</code>\n` +
    `<b>Waktu</b>: ${new Date().toLocaleString('id-ID')}\n\n` +
    `Saldo otomatis ter-credit \u2705`
  );
}

function withdrawRequest(user, wd, balance) {
  return sendText(
    `\u{1F6B4} <b>WITHDRAW BARU</b>\n\n` +
    `<b>Nominal</b>: ${rupiah(wd.amount)}\n` +
    `<b>Metode</b>: ${esc(wd.method)}\n` +
    `<b>Akun</b>: ${esc(wd.account_name || '-')} (${esc(wd.account_number || '-')})\n` +
    `<b>Pengguna</b>: ${esc(user.name || user.email)} (${esc(user.email)})\n` +
    `<b>Saldo tersisa</b>: ${rupiah(balance)}\n` +
    `<b>ID</b>: <code>${wd.id}</code>\n\n` +
    `Proses manual via dashboard owner (max 1-24 jam) \u23F3`
  );
}

function withdrawProcessed(wd, status, note) {
  const emoji = status === 'DONE' ? '\u2705' : '\u274C';
  return sendText(
    `${emoji} <b>WITHDRAW ${status}</b>\n\n` +
    `<b>Nominal</b>: ${rupiah(wd.amount)}\n` +
    `<b>Metode</b>: ${esc(wd.method)} (${esc(wd.account_number || '-')})\n` +
    `<b>ID</b>: <code>${wd.id}</code>\n` +
    (note ? `<b>Catatan</b>: ${esc(note)}\n` : '')
  );
}

module.exports = { sendText, deposit, withdrawRequest, withdrawProcessed, rupiah };
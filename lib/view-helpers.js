const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

const badgeMap = {
  PENDING: 'pending', PAID: 'paid', EXPIRED: 'expired',
  DONE: 'done', REJECTED: 'rejected', owner: 'owner', user: 'user',
};

function badge(state) {
  const key = badgeMap[state] || badgeMap[String(state).toUpperCase()] || '';
  return `<span class="badge ${key}">${esc(state)}</span>`;
}

function chartBars(daily) {
  const max = Math.max(...daily.map((d) => d.amount), 1);
  const bars = daily.map((d) => {
    const h = Math.max(4, Math.round((Number(d.amount) / max) * 130));
    return `<div class="bar" style="height:${h}px" title="${rupiah(d.amount)}"><span>${esc(String(d.d).slice(5))}</span></div>`;
  });
  return '<div class="chart-bars">' + bars.join('') + '</div>';
}

const ledgerTypes = {
  deposit: 'Deposit QRIS',
  withdraw_hold: 'Kuncian penarikan',
  withdraw_refund: 'Refund penarikan',
};

function a(str, hidden) {
  return hidden ? 'style="display:none"' : '';
}

module.exports = { esc, rupiah, fmt, badge, chartBars, ledgerTypes, a };
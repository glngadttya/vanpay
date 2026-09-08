(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }); };

  const state = { me: null, pollTimer: null };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    return j.data;
  }

  function badges(status) {
    const map = { PENDING: 'pending', PAID: 'paid', EXPIRED: 'expired', DONE: 'done', REJECTED: 'rejected', SUCCESS: 'done', FAILED: 'rejected', CANCELED: 'rejected' };
    return `<span class="badge ${map[status] || ''}">${status}</span>`;
  }

  function showMsg(id, type, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'msg ' + type;
    el.textContent = text;
  }

  function chartBars(daily) {
    const max = Math.max(...daily.map((d) => d.amount), 1);
    return `<div class="chart-bars">` + daily.map((d) => {
      const h = Math.max(3, Math.round((d.amount / max) * 140));
      return `<div class="bar" style="height:${h}px" title="${rupiah(d.amount)}"><span>${d.d.slice(5)}</span></div>`;
    }).join('') + `</div>`;
  }

  function setPage(id) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('on'));
    const pg = document.getElementById(id);
    if (pg) pg.classList.add('on');
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === id));
    window.scrollTo(0, 0);
  }

  function buildNav() {
    const nav = $('#nav');
    if (!state.me) return;
    const items = state.me.role === 'owner'
      ? [['o-overview', '◉ Ringkasan'], ['o-users', '👥 Pengguna'], ['o-payments', '▦ Pembayaran'], ['o-withdrawals', '↳ Penarikan']]
      : [['overview', '◉ Ringkasan'], ['pay', '▦ Buat QRIS'], ['payments', '◷ Riwayat QRIS'], ['withdraw', '↳ Tarik Dana'], ['ledger', '◪ Mutasi']];
    nav.innerHTML = items.map(([id, label]) => `<button data-page="${id}">${label}</button>`).join('');
    nav.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setPage(b.dataset.page); load(b.dataset.page); }));
  }

  // ---------- loaders ----------
  const loaders = {
    async overview() {
      const [st] = await Promise.all([api('/api/stats')]);
      $('#pg-overview').innerHTML = `
        <h2>Ringkasan ${esc(state.me.name || '')}</h2>
        <div class="grid g4">
          <div class="card"><div class="k">Saldo</div><div class="v">${rupiah(st.balance)}</div><div class="hov">Bisa ditarik kapan pun</div></div>
          <div class="card"><div class="k">Total deposit</div><div class="v">${rupiah(st.totalDeposit)}</div><div class="hov">${st.countPaid} transaksi sukses</div></div>
          <div class="card"><div class="k">Total tarik</div><div class="v">${rupiah(st.totalWithdraw)}</div><div class="hov">${st.pendingWithdraw ? 'Menunggu proses: ' + rupiah(st.pendingWithdraw) : 'Ga ada penarikan pending'}</div></div>
          <div class="card"><div class="k">QRIS aktif</div><div class="v">${st.pendingPayments}</div><div class="hov">Belum dibayar</div></div>
        </div>
        <div class="grid g2" style="margin-top:16px">
          <div class="card"><div class="k">Deposit 14 hari terakhir</div><div style="margin-top:10px">${chartBars(st.daily)}</div></div>
          <div class="card">
            <div class="k">Aksi cepat</div>
            <a class="btn grad" style="width:100%;margin-top:12px" onclick="setPage('pay');load('pay')">+ Buat QRIS baru</a>
            <a class="btn ghost" style="width:100%;margin-top:10px" onclick="setPage('withdraw');load('withdraw')">→ Tarik dana</a>
          </div>
        </div>`;
    },

    async pay() {
      const auto = new URLSearchParams(location.search).get('pay');
      $('#pg-pay').innerHTML = `
        <h2>Buat QRIS</h2>
        <div class="grid g2">
          <div class="card">
            <form id="frmPay">
              <div class="row"><label>Nominal (Rp)</label><input type="number" id="inAmt" min="1000" step="1000" placeholder="cth. 5000" required></div>
              <div class="row"><label>Catatan (opsional)</label><input type="text" id="inNote" maxlength="80" placeholder="cth. invoice #123"></div>
              <button class="btn grad" type="submit" id="btnPay">Buat QRIS →</button>
              <div class="msg" id="msgPay"></div>
            </form>
            <p style="font-size:12.5px;color:var(--muted);margin-top:12px">Pembeli bayar = nominal + fee + kode unik. Saldo yang masuk = nominal penuh.</p>
          </div>
          <div id="payResult" style="display:none"></div>
        </div>`;
      $('#frmPay').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#btnPay');
        btn.disabled = true;
        btn.textContent = 'Membuat…';
        try {
          const txn = await api('/api/qris/create', {
            method: 'POST',
            body: JSON.stringify({ amount: $('#inAmt').value, note: $('#inNote').value }),
          });
          showPayResult(txn);
          showMsg('msgPay', 'ok', 'QRIS dibuat! Minta pembeli scan dibawah.');
        } catch (err) {
          showMsg('msgPay', 'err', err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Buat QRIS →';
        }
      });
      if (auto) {
        try {
          const txn = await api('/api/payments').then((l) => l.find((p) => p.id === auto));
          if (txn) showPayResult(txn);
        } catch (_) {}
      }
    },

    async payments() {
      const list = await api('/api/payments');
      $('#pg-payments').innerHTML = `
        <h2>Riwayat QRIS</h2>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>Nominal</th><th>Fee</th><th>Total QR</th><th>Status</th><th>Waktu</th><th></th></tr></thead>
              <tbody>
                ${list.length ? list.map((p) => `
                  <tr>
                    <td><b>${esc(p.id)}</b></td>
                    <td>${rupiah(p.amount)}</td>
                    <td>${rupiah(p.fee)}</td>
                    <td>${rupiah(p.payAmount)} <span style="color:var(--muted);font-size:11px">(+${p.uniqueCode})</span></td>
                    <td>${badges(p.status)}</td>
                    <td>${fmt(p.createdAt)}</td>
                    <td><button class="btn ghost" style="padding:6px 10px;font-size:12px" data-open="${p.id}" ${p.status !== 'PENDING' ? 'disabled' : ''}>Lihat QR</button></td>
                  </tr>`).join('') : `<tr><td colspan="7" class="empty">Belum ada QRIS</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
      $('#pg-payments').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
        const list = await api('/api/payments');
        const txn = list.find((p) => p.id === b.dataset.open);
        if (txn) { setPage('pay'); load('pay').then(() => showPayResult(txn)); }
      }));
    },

    async withdraw() {
      const [list, me] = await Promise.all([api('/api/withdraws'), api('/auth/me')]);
      $('#pg-withdraw').innerHTML = `
        <h2>Tarik dana</h2>
        <div class="grid g2">
          <div class="card">
            <div class="row" style="display:flex;justify-content:space-between"><span class="k">Saldo tersedia</span><b style="font-size:20px">${rupiah(me.balance)}</b></div>
            <form id="frmWd" style="margin-top:8px">
              <div class="row"><label>Nominal (min 5.000)</label><input type="number" id="wdAmt" min="5000" required></div>
              <div class="row"><label>Metode</label>
                <select id="wdMethod">
                  <option>DANA</option><option>GoPay</option><option>ShopeePay</option>
                </select>
              </div>
              <div class="row"><label>Nomor / ID akun</label><input type="text" id="wdAcct" placeholder="08xxxxxxxxxx" required></div>
              <div class="row"><label>Nama pemilik (optional)</label><input type="text" id="wdName" maxlength="60"></div>
              <button class="btn green" type="submit" id="btnWd">Ajukan penarikan</button>
              <div class="msg" id="msgWd"></div>
            </form>
            <p style="font-size:12.5px;color:var(--muted);margin-top:12px">Diproses manual oleh admin, maksimal 1–24 jam. Saldo otomatis dikunci saat pengajuan.</p>
          </div>
          <div class="card">
            <div class="k">Riwayat penarikan</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>Nominal</th><th>Metode</th><th>Status</th><th>Waktu</th></tr></thead>
                <tbody>
                  ${list.length ? list.map((w) => `<tr><td><b>${esc(w.id)}</b></td><td>${rupiah(w.amount)}</td><td>${esc(w.method)}</td><td>${badges(w.status)}</td><td>${fmt(w.requestedAt)}</td></tr>`).join('') : `<tr><td colspan="5" class="empty">Belum ada penarikan</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
      $('#frmWd').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#btnWd');
        btn.disabled = true;
        btn.textContent = 'Mengajukan…';
        try {
          await api('/api/withdraw', {
            method: 'POST',
            body: JSON.stringify({ amount: $('#wdAmt').value, method: $('#wdMethod').value, accountNumber: $('#wdAcct').value, accountName: $('#wdName').value }),
          });
          showMsg('msgWd', 'ok', 'Penarikan diajukan! Admin akan proses max 1–24 jam.');
          load('withdraw');
        } catch (err) {
          showMsg('msgWd', 'err', err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Ajukan penarikan';
        }
      });
    },

    async ledger() {
      const rows = await api('/api/ledger');
      const types = { deposit: 'Deposit QRIS', withdraw_hold: 'Kuncian penarikan', withdraw_refund: 'Refund penarikan' };
      $('#pg-ledger').innerHTML = `
        <h2>Mutasi saldo</h2>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Waktu</th><th>Tipe</th><th>Nominal</th><th>Ref</th><th>Catatan</th></tr></thead>
              <tbody>
                ${rows.length ? rows.map((r) => `<tr>
                  <td>${fmt(r.created_at)}</td>
                  <td>${types[r.type] || r.type}</td>
                  <td style="color:${Number(r.amount) >= 0 ? 'var(--ok)' : 'var(--bad)'};font-weight:700">${Number(r.amount) >= 0 ? '+' : ''}${rupiah(Math.abs(r.amount))}</td>
                  <td>${esc(r.ref || '—')}</td>
                  <td>${esc(r.note || '')}</td>
                </tr>`).join('') : `<tr><td colspan="5" class="empty">Belum ada mutasi</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
    },

    // ---------- owner ----------
    async 'o-overview'() {
      const st = await api('/api/admin/stats');
      $('#pg-o-overview').innerHTML = `
        <h2>Ringkasan platform</h2>
        <div class="grid g4">
          <div class="card"><div class="k">Pengguna</div><div class="v">${st.users}</div></div>
          <div class="card"><div class="k">Total volume (gross)</div><div class="v">${rupiah(st.volume)}</div></div>
          <div class="card"><div class="k">Pendapatan fee</div><div class="v">${rupiah(st.feesEarned)}</div></div>
          <div class="card"><div class="k">Saldo terhutang user</div><div class="v">${rupiah(st.totalBalance)}</div></div>
          <div class="card"><div class="k">Transaksi</div><div class="v">${st.successCount}<small> / ${st.payments}</small></div><div class="hov">Sukses ${st.successRate}%</div></div>
          <div class="card"><div class="k">Pending QRIS</div><div class="v">${st.pendingPayments}</div></div>
          <div class="card"><div class="k">Tarik pending</div><div class="v">${st.pendingWithdraw}<small> · ${rupiah(st.pendingWithdrawSum)}</small></div></div>
          <div class="card"><div class="k">Total penarikan</div><div class="v">${rupiah(st.totalWithdraw)}</div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="k">Deposit 14 hari terakhir</div><div style="margin-top:10px">${chartBars(st.daily)}</div></div>`;
    },

    async 'o-users'() {
      const users = await api('/api/admin/users');
      $('#pg-o-users').innerHTML = `
        <h2>Pengguna</h2>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Akun</th><th>Email</th><th>Saldo</th><th>Total deposit</th><th>Total tarik</th><th>Menunggu</th><th>Gabung</th></tr></thead>
              <tbody>
                ${users.map((u) => `<tr>
                  <td style="display:flex;gap:8px;align-items:center"><img src="${esc(u.avatar)}" width="24" height="24" style="border-radius:50%"> <b>${esc(u.name || u.email)}</b> ${u.role === 'owner' ? badges('owner').replace('owner', 'owner') : ''}</td>
                  <td>${esc(u.email)}</td>
                  <td><b>${rupiah(u.balance)}</b></td>
                  <td>${rupiah(u.totalDeposit)}</td>
                  <td>${rupiah(u.totalWithdraw)}</td>
                  <td>${u.pendingWithdraw || '—'}</td>
                  <td>${fmt(u.createdAt)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    },

    async 'o-payments'() {
      const rows = await api('/api/admin/payments');
      $('#pg-o-payments').innerHTML = `
        <h2>Semua pembayaran</h2>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>User</th><th>Nominal</th><th>Fee</th><th>Total QR</th><th>Status</th><th>Dibuat</th><th>Dibayar</th></tr></thead>
              <tbody>
                ${rows.length ? rows.map((p) => `<tr>
                  <td><b>${esc(p.id)}</b></td>
                  <td>#${p.user_id}</td>
                  <td>${rupiah(p.amount)}</td>
                  <td>${rupiah(p.fee)}</td>
                  <td>${rupiah(p.pay_amount)} (+${p.unique_code})</td>
                  <td>${badges(p.status)}</td>
                  <td>${fmt(p.created_at)}</td>
                  <td>${fmt(p.paid_at)}</td>
                </tr>`).join('') : `<tr><td colspan="8" class="empty">Belum ada pembayaran</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
    },

    async 'o-withdrawals'() {
      const [pending, all] = await Promise.all([api('/api/admin/withdrawals?status=PENDING'), api('/api/admin/withdrawals')]);
      $('#pg-o-withdrawals').innerHTML = `
        <h2>Penarikan</h2>
        <div class="card" style="margin-bottom:16px">
          <div class="k">Menunggu proses (${pending.length})</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>User</th><th>Nominal</th><th>Metode</th><th>Akun</th><th>Aksi</th></tr></thead>
              <tbody>
                ${pending.length ? pending.map((w) => `<tr>
                  <td><b>${esc(w.id)}</b></td>
                  <td>${w.user ? esc(w.user.name || w.user.email) : '#' + w.user_id}</td>
                  <td><b>${rupiah(w.amount)}</b></td>
                  <td>${esc(w.method)}</td>
                  <td>${esc(w.account_name || '')} <span class="hov">${esc(w.account_number || '')}</span></td>
                  <td>
                    <button class="btn green" style="padding:6px 12px;font-size:12px" data-ok="${w.id}">✓ Sudah transfer</button>
                    <button class="btn danger" style="padding:6px 12px;font-size:12px" data-no="${w.id}">✗ Tolak</button>
                  </td>
                </tr>`).join('') : `<tr><td colspan="6" class="empty">Tidak ada penarikan menunggu</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="k">Riwayat semua</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>User</th><th>Nominal</th><th>Metode</th><th>Status</th><th>Catatan</th><th>Waktu</th></tr></thead>
              <tbody>
                ${all.map((w) => `<tr>
                  <td><b>${esc(w.id)}</b></td>
                  <td>${w.user ? esc(w.user.name || w.user.email) : '#' + w.user_id}</td>
                  <td>${rupiah(w.amount)}</td>
                  <td>${esc(w.method)}</td>
                  <td>${badges(w.status)}</td>
                  <td>${esc(w.admin_note || '')}</td>
                  <td>${fmt(w.requestedAt)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
      $('#pg-o-withdrawals').querySelectorAll('[data-ok],[data-no]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.ok || b.dataset.no;
        const ok = !!b.dataset.ok;
        if (!confirm((ok ? 'Tandai penarikan ' : 'Tolak penarikan ') + id + (ok ? ' sebagai SUDAH ditransfer?' : '? Saldo akan di-refund.'))) return;
        const note = ok ? '' : (prompt('Alasan tolak (opsional):') || '');
        try {
          await api('/api/admin/withdrawals/' + id + (ok ? '/approve' : '/reject'), { method: 'POST', body: JSON.stringify({ note }) });
          alert(ok ? 'Penarikan ditandai selesai.' : 'Penarikan ditolak & saldo direfund.');
          load('o-withdrawals');
        } catch (err) {
          alert('Gagal: ' + err.message);
        }
      }));
    },
  };

  function showPayResult(txn) {
    const box = $('#payResult');
    box.style.display = 'block';
    box.innerHTML = `
      <div class="pay-box">
        <div><img src="/api/qris/${esc(txn.id)}/qr.png" alt="QRIS" id="qrImg"></div>
        <div class="pay-info">
          <div class="amount">${rupiah(txn.payAmount)}</div>
          <div class="to">scan &amp; bayar pake aplikasi pembayaran QRIS apa aja</div>
          <div class="rowm"><span>Nominal</span><b>${rupiah(txn.amount)}</b></div>
          <div class="rowm"><span>Fee</span><b>${rupiah(txn.fee)}</b></div>
          <div class="rowm"><span>Kode unik</span><b>+${txn.uniqueCode}</b></div>
          <div class="rowm"><span>Status</span><b id="qrSt">${badges(txn.status)}</b></div>
          <div class="rowm"><span>Berlaku sampai</span><b>${fmt(txn.expiresAt)}</b></div>
        </div>
      </div>`;
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const st = await api('/api/qris/' + txn.id + '/status');
        const el = $('#qrSt');
        if (el) el.innerHTML = badges(st.status);
        if (st.status === 'PAID') {
          clearInterval(state.pollTimer);
          el.innerHTML = badges('PAID') + ' <span class="badge done">Saldo masuk!</span>';
          setTimeout(() => { load('overview'); setPage('overview'); }, 2500);
        } else if (st.status === 'EXPIRED') {
          clearInterval(state.pollTimer);
        }
      } catch (_) {}
    }, 3000);
  }

  const load = (page) => {
    const fn = loaders[page];
    if (fn) return fn().catch((e) => {
      const holder = document.getElementById('pg-' + page);
      if (holder) holder.innerHTML = `<div class="card"><div class="msg err">${esc(e.message)}</div></div>`;
    });
    return Promise.resolve();
  };

  window.setPage = setPage;
  window.load = load;

  async function boot() {
    try {
      state.me = await api('/auth/me');
    } catch (e) {
      const msg = e.message;
      location.href = '/login' + (msg && msg !== 'Belum login' ? '?err=' + encodeURIComponent(msg) : '');
      return;
    }
    const me = state.me;
    $('#pName').textContent = me.name || me.email;
    $('#pEmail').textContent = me.email;
    $('#pAv').src = me.avatar || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40"%3E%3Crect fill="%23cbd5e1" width="40" height="40"/%3E%3C/svg%3E';
    $('#pBadge').innerHTML = me.role === 'owner' ? badges('owner').replace('owner', 'owner') + ' owner' : 'member';
    buildNav();
    const target = me.role === 'owner' ? 'o-overview' : 'overview';
    setPage(target);
    load(target);
    if (new URLSearchParams(location.search).get('pay')) {
      setPage('pay');
      load('pay');
    }
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
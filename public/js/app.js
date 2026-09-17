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
    const pg = document.getElementById(id) || document.getElementById('pg-' + id);
    if (pg) pg.classList.add('on');
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === id));
    window.scrollTo(0, 0);
  }

  function buildNav() {
    const nav = $('#nav');
    if (!state.me) return;
    const items = state.me.role === 'owner'
      ? [['o-overview', '◉ Ringkasan'], ['o-users', '👥 Pengguna'], ['o-payments', '▦ Pembayaran'], ['o-withdrawals', '↳ Penarikan'], ['o-setup', '⚙ Pengaturan']]
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

    async 'o-setup'() {
      const s = await api('/api/admin/settings');
      const origin = location.origin;
      $('#pg-o-setup').innerHTML = `
        <h2>Pengaturan</h2>
        <div class="cwrap">
          <div class="card">
            <div class="k">Status layanan</div>
            <div class="rowm"><span>QRIS utama</span><b>${s.qr.qris_string ? '<span class="badge done">OK</span>' : '<span class="badge">BELUM DISET</span>'}</b></div>
            <div class="rowm"><span>Mode QR</span><b>${esc(s.qr.mode)}</b></div>
            <div class="rowm"><span>GoBiz (scanner pembayaran)</span><b>${s.gobiz.linked ? '<span class="badge done">Terhubung</span>' : '<span class="badge">BELUM LOGIN</span>'}</b></div>
            <div class="rowm"><span>Merchant</span><b>${esc(s.gobiz.merchantName || s.gobiz.merchantId || '-')}</b></div>
            <div class="rowm"><span>Telegram</span><b>${s.tg.bot_token ? '<span class="badge done">Terpasang</span>' : '<span class="badge">Nonaktif</span>'}</b></div>
            <div class="rowm"><span>Login web</span><b>${s.oauth.github_client_id || s.oauth.google_client_id ? '<span class="badge done">Aktif</span>' : '<span class="badge">Hanya melalui /bootstrap</span>'}</b></div>
            <div class="rowm"><span>Polling terakhir</span><b>${esc(s.sys.lastPollMsg || '-')} ${s.sys.lastPollAt ? '(' + fmt(new Date(s.sys.lastPollAt)) + ')' : ''}</b></div>
          </div>

          <form class="card" id="fQris">
            <div class="k">QRIS utama &amp; mode</div>
            <label class="rowlr"><span>Mode QR</span>
              <select name="qr.mode">
                <option value="dynamic">Dinamis (nominal otomatis + kode unik)</option>
                <option value="static">Statis (QR tetap + nominal besar)</option>
              </select>
            </label>
            <label><span>String QRIS statis merchant</span>
              <textarea name="qr.qris_string" rows="4" placeholder="Tempel string 000201010211266... hasil scan BUKAN kode QR statis kamu">${esc(s.qr.qris_string)}</textarea>
            </label>
            <p class="hint">Scan QR statis GoBiz/GoPay dengan aplikasi scan apa pun → salin isinya (mulai 000201…). QRIS ini dipakai sebagai induk semua pembayaran. Mode dinamis menyisipkan nominal & kode unik otomatis; mode statis menampilkan QR induk + nominal.</p>
            <button class="btn primary" type="submit">Simpan QRIS</button>
          </form>

          <form class="card" id="fBilling">
            <div class="k">Biaya &amp; limit</div>
            <label><span>Fee deposit (%)</span><input name="billing.fee_pct" type="number" step="0.1" min="0" value="${s.billing.fee_pct}"></label>
            <label><span>Fee minimum (Rp)</span><input name="billing.min_fee" type="number" min="0" value="${s.billing.min_fee}"></label>
            <label><span>Min nominal QRIS</span><input name="billing.min_qris" type="number" min="0" value="${s.billing.min_qris}"></label>
            <label><span>Max nominal QRIS</span><input name="billing.max_qris" type="number" min="0" value="${s.billing.max_qris}"></label>
            <label><span>Min penarikan</span><input name="billing.min_wd" type="number" min="0" value="${s.billing.min_wd}"></label>
            <label><span>Max penarikan</span><input name="billing.max_wd" type="number" min="0" value="${s.billing.max_wd}"></label>
            <button class="btn primary" type="submit">Simpan Biaya</button>
          </form>

          <form class="card" id="fOauth">
            <div class="k">Login web (Google/GitHub)</div>
            <label><span>GitHub Client ID</span><input name="oauth.github_client_id" value="${esc(s.oauth.github_client_id)}"></label>
            <label><span>GitHub Client Secret</span><input name="oauth.github_client_secret" type="password" placeholder="Kosongkan jika tidak diubah" autocomplete="new-password"></label>
            <label><span>Google Client ID</span><input name="oauth.google_client_id" value="${esc(s.oauth.google_client_id)}"></label>
            <label><span>Google Client Secret</span><input name="oauth.google_client_secret" type="password" placeholder="Kosongkan jika tidak diubah" autocomplete="new-password"></label>
            <label><span>Email owner (auto-owner saat login)</span><input name="oauth.owner_email" value="${esc(s.oauth.owner_email)}"></label>
            <p class="hint">Callback GitHub: <b>${esc(origin)}/auth/github/callback</b><br>Callback Google: <b>${esc(origin)}/auth/google/callback</b></p>
            <button class="btn primary" type="submit">Simpan OAuth</button>
          </form>

          <form class="card" id="fTg">
            <div class="k">Notifikasi Telegram</div>
            <label><span>Bot token</span><input name="tg.bot_token" type="password" value="${esc(s.tg.bot_token)}" autocomplete="new-password"></label>
            <label><span>Chat ID</span><input name="tg.chat_id" value="${esc(s.tg.chat_id)}"></label>
            <p class="hint">Bikin bot via @BotFather, obrolan pesan ke bot sekali, lalu panggil getUpdates untuk ambil chat_id.</p>
            <div class="rowlr">
              <button class="btn" type="button" id="tgTest">Kirim pesan uji</button>
              <button class="btn primary" type="submit">Simpan Telegram</button>
            </div>
          </form>

          <div class="card" id="gobizCard">
            <div class="k">Login GoBiz (scanner pembayaran otomatis)</div>
            ${s.gobiz.linked ? `
              <div class="rowm"><span>Merchant</span><b>${esc(s.gobiz.merchantName || s.gobiz.merchantId || '-')}</b></div>
              <div class="rowm"><span>Nomor</span><b>${esc(s.gobiz.phone || '-')}</b></div>
              <div class="rowm"><span>Refresh token</span><b>${s.gobiz.hasRefreshToken ? '<span class="badge done">ada</span>' : '<span class="badge">tidak</span>'}</b></div>
              <div class="rowlr">
                <button class="btn" type="button" id="gobizRefresh">Perbarui token</button>
                <button class="btn danger" type="button" id="gobizLogout">Logout GoBiz</button>
              </div>` : `
              <label><span>Nomor (cara OTP)</span>
                <div class="rowlr"><input name="gobiz.phone" placeholder="81234567890" style="flex:1"><select name="gobiz.cc" style="width:110px"><option value="+62">+62</option><option value="+60">+60</option><option value="+65">+65</option></select></div>
              </label>
              <div class="rowlr">
                <button class="btn" type="button" id="gobizOtp">Kirim OTP</button>
                <input name="gobiz.otp" placeholder="Kode OTP" style="flex:1">
                <button class="btn primary" type="button" id="gobizVerify">Verifikasi &amp; simpan</button>
              </div>
              <div class="sep">atau</div>
              <label><span>Email GoBiz</span><input name="gobiz.email" placeholder="email@merchant.id"></label>
              <label><span>Password</span><input name="gobiz.password" type="password" placeholder="••••••••"></label>
              <button class="btn primary" type="button" id="gobizPw">Login password</button>
              <p class="hint">Login minim 1x supaya polling pembayaran jalan. Token disimpan aman; kapan pun bisa refresh/logout dari sini.</p>`}
          </div>
        </div>`;

      const cards = [['fQris', ['qr.qris_string', 'qr.mode']], ['fBilling', ['billing.fee_pct', 'billing.min_fee', 'billing.min_qris', 'billing.max_qris', 'billing.min_wd', 'billing.max_wd']], ['fOauth', ['oauth.github_client_id', 'oauth.github_client_secret', 'oauth.google_client_id', 'oauth.google_client_secret', 'oauth.owner_email']], ['fTg', ['tg.bot_token', 'tg.chat_id']]];
      cards.forEach(([id, keys]) => {
        const f = document.getElementById(id);
        if (!f) return;
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          const entries = {};
          keys.forEach((k) => {
            const inp = f.elements[k];
            if (!inp) return;
            const v = inp.value.trim();
            if ((k.includes('secret') || k === 'tg.bot_token') && v === '') return;
            entries[k] = k.startsWith('oauth') && k.includes('secret') ? v : (k.startsWith('qq') || k.startsWith('qr') || k.startsWith('oauth') || k.startsWith('tg') ? v : (isNaN(Number(v)) ? v : Number(v)));
          });
          try {
            const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ entries }) });
            alert('Tersimpan (' + r.saved.length + ' setelan).');
            load('o-setup');
          } catch (err) {
            alert('Gagal simpan: ' + err.message);
          }
        });
      });

      const bt = (id) => document.getElementById(id);
      if (bt('tgTest')) {
        bt('tgTest').addEventListener('click', async () => {
          const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ entries: { 'tg.bot_token': bt('fTg').elements['tg.bot_token'].value.trim(), 'tg.chat_id': bt('fTg').elements['tg.chat_id'].value.trim() } }) }).catch((err) => alert('Gagal: ' + err.message));
          if (!r) return;
          try {
            const t = await api('/api/admin/telegram/test', { method: 'POST' });
            alert(t.sent ? 'Pesan uji terkirim ✅ cek Telegram kamu.' : 'Gagal kirim: ' + (t.error || '?'));
          } catch (err) { alert('Gagal: ' + err.message); }
        });
      }

      if (bt('gobizOtp')) {
        bt('gobizOtp').addEventListener('click', async () => {
          const phone = bt('gobizCard').elements['gobiz.phone'].value.trim();
          const cc = bt('gobizCard').elements['gobiz.cc'].value;
          if (!phone) return alert('Isi nomor dulu.');
          try {
            await api('/api/admin/gobiz/otp', { method: 'POST', body: JSON.stringify({ phone, cc }) });
            alert('OTP terkirim ke ' + cc + phone + '. Masukkan kodenya lalu klik Verifikasi.');
          } catch (err) { alert('Gagal: ' + err.message); }
        });
        bt('gobizVerify').addEventListener('click', async () => {
          const phone = bt('gobizCard').elements['gobiz.phone'].value.trim();
          const cc = bt('gobizCard').elements['gobiz.cc'].value;
          const otp = bt('gobizCard').elements['gobiz.otp'].value.trim();
          if (!otp) return alert('Isi kode OTP.');
          try {
            const r = await api('/api/admin/gobiz/verify', { method: 'POST', body: JSON.stringify({ phone, cc, otp }) });
            alert('GoBiz terhubung' + (r.merchantId ? ' (merchant ' + r.merchantId + ')' : '') + '. Polling otomatis aktif.');
            load('o-setup');
          } catch (err) { alert('Gagal: ' + err.message); }
        });
        bt('gobizPw').addEventListener('click', async () => {
          const email = bt('gobizCard').elements['gobiz.email'].value.trim();
          const password = bt('gobizCard').elements['gobiz.password'].value;
          if (!email || !password) return alert('Isi email & password.');
          try {
            const r = await api('/api/admin/gobiz/password', { method: 'POST', body: JSON.stringify({ email, password }) });
            alert('GoBiz terhubung' + (r.merchantId ? ' (merchant ' + r.merchantId + ')' : '') + '. Polling otomatis aktif.');
            load('o-setup');
          } catch (err) { alert('Gagal: ' + err.message); }
        });
      }
      if (bt('gobizRefresh')) {
        bt('gobizRefresh').addEventListener('click', async () => {
          try { await api('/api/admin/gobiz/refresh', { method: 'POST' }); alert('Token diperbarui.'); load('o-setup'); }
          catch (err) { alert('Gagal: ' + err.message); }
        });
        bt('gobizLogout').addEventListener('click', async () => {
          if (!confirm('Logout GoBiz? Polling pembayaran akan berhenti.')) return;
          try { await api('/api/admin/gobiz/logout', { method: 'POST' }); alert('Logout OK.'); load('o-setup'); }
          catch (err) { alert('Gagal: ' + err.message); }
        });
      }
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
    const qp = new URLSearchParams(location.search);
    if (me.role === 'owner' && qp.get('setup')) {
      setPage('o-setup');
      load('o-setup');
      return;
    }
    const target = me.role === 'owner' ? 'o-overview' : 'overview';
    setPage(target);
    load(target);
    if (qp.get('pay')) {
      setPage('pay');
      load('pay');
    }
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
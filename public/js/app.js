(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function fs(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  async function api(url, opts) {
    const r = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || j.ok === false) throw new Error((j && j.error) || 'HTTP ' + r.status);
    return j.data;
  }

  function flash(el, type, text, ms) {
    if (!el) return;
    el.className = 'msg ' + type;
    el.innerHTML = (type === 'ok' ? '<i class="fa-solid fa-circle-check"></i>&nbsp;' : '<i class="fa-solid fa-circle-exclamation"></i>&nbsp;') + String(text);
    if (ms) setTimeout(function () { el.className = 'msg'; }, ms);
  }

  fs('#flashMsg').forEach(function (el) {
    setTimeout(function () {
      el.style.transition = 'opacity .4s';
      el.style.opacity = '0';
      setTimeout(function () { el.style.display = 'none'; }, 420);
    }, 4500);
  });

  var frmPay = $('frmPay');
  if (frmPay) frmPay.addEventListener('submit', async function (e) {
    e.preventDefault();
    var box = $('msgPay');
    var btn = $('btnPay');
    btn.disabled = true;
    btn.innerHTML = 'Membuat&hellip;';
    try {
      var t = await api('/api/qris/create', { method: 'POST', body: JSON.stringify({ amount: $('inAmt').value, note: $('inNote').value }) });
      location.href = '/dashboard/pay?ref=' + encodeURIComponent(t.id);
    } catch (err) {
      flash(box, 'err', err.message);
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-qrcode"></i>&nbsp;Buat QRIS';
    }
  });

  var frmWd = $('frmWd');
  if (frmWd) frmWd.addEventListener('submit', async function (e) {
    e.preventDefault();
    var box = $('msgWd');
    var btn = $('btnWd');
    btn.disabled = true;
    try {
      await api('/api/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount: $('wdAmt').value, method: $('wdMethod').value, accountNumber: $('wdAcct').value, accountName: $('wdName').value }),
      });
      flash(box, 'ok', 'Penarikan berhasil diajukan. Admin akan memproses dalam maksimal 1–24 jam.', 1200);
      setTimeout(function () { location.reload(); }, 1400);
    } catch (err) {
      flash(box, 'err', err.message);
      btn.disabled = false;
    }
  });

  fs('form[data-settings]').forEach(function (f) {
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var msg = f.querySelector('.msg');
      var btn = f.querySelector('button[type=submit]');
      if (btn) btn.disabled = true;
      var entries = {};
      fs('[name]', f).forEach(function (inp) {
        var k = inp.name;
        var v = inp.value.trim();
        if ((k.indexOf('secret') !== -1 || k === 'tg.bot_token') && v === '') return;
        if (k.indexOf('billing') === 0 && /^[+-]?[0-9]*\.?[0-9]+$/.test(v)) v = v === '' ? v : Number(v);
        entries[k] = v;
      });
      try {
        await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ entries }) });
        flash(msg, 'ok', 'Setelan tersimpan.', 900);
        setTimeout(function () { location.reload(); }, 1100);
      } catch (err) {
        flash(msg, 'err', 'Gagal menyimpan: ' + err.message);
        if (btn) btn.disabled = false;
      }
    });
  });

  fs('[data-gobiz]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var act = b.dataset.gobiz;
      var card = $('gobizCard');
      var msg = card ? card.querySelector('.msg') : null;
      var val = function (n) { var el = card && card.querySelector('[name="' + n + '"]'); return el ? el.value : ''; };
      b.disabled = true;
      try {
        if (act === 'otp') {
          var phone = val('gobiz.phone').trim();
          var cc = val('gobiz.cc');
          if (!phone) throw new Error('Isi nomor telepon terlebih dahulu.');
          await api('/api/admin/gobiz/otp', { method: 'POST', body: JSON.stringify({ phone: phone, cc: cc }) });
          flash(msg, 'ok', 'Kode OTP terkirim ke ' + cc + phone + '.');
        } else if (act === 'verify') {
          var res = await api('/api/admin/gobiz/verify', { method: 'POST', body: JSON.stringify({ phone: val('gobiz.phone').trim(), cc: val('gobiz.cc'), otp: val('gobiz.otp').trim() }) });
          flash(msg, 'ok', 'GoBiz terhubung' + (res.merchantId ? ' (merchant ' + res.merchantId + ')' : '') + '.', 900);
          setTimeout(function () { location.reload(); }, 1100);
        } else if (act === 'password') {
          var email = val('gobiz.email').trim();
          var password = val('gobiz.password');
          if (!email || !password) throw new Error('Isi email dan password.');
          var r2 = await api('/api/admin/gobiz/password', { method: 'POST', body: JSON.stringify({ email: email, password: password }) });
          flash(msg, 'ok', 'GoBiz terhubung' + (r2.merchantId ? ' (merchant ' + r2.merchantId + ')' : '') + '.', 900);
          setTimeout(function () { location.reload(); }, 1100);
        } else if (act === 'refresh') {
          await api('/api/admin/gobiz/refresh', { method: 'POST' });
          flash(msg, 'ok', 'Token diperbarui.', 900);
          setTimeout(function () { location.reload(); }, 1100);
        } else if (act === 'logout') {
          if (!confirm('Keluar dari GoBiz? Polling pembayaran akan berhenti.')) return;
          await api('/api/admin/gobiz/logout', { method: 'POST' });
          flash(msg, 'ok', 'Berhasil keluar.', 900);
          setTimeout(function () { location.reload(); }, 1100);
        }
      } catch (err) {
        flash(msg, 'err', 'Gagal: ' + err.message);
      } finally {
        b.disabled = false;
      }
    });
  });

  fs('[data-tgtest]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var f = $('fTg');
      var msg = f ? f.querySelector('.msg') : null;
      b.disabled = true;
      try {
        var entries = {
          'tg.bot_token': f.querySelector('[name="tg.bot_token"]').value.trim(),
          'tg.chat_id': f.querySelector('[name="tg.chat_id"]').value.trim(),
        };
        await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ entries: entries }) });
        var t = await api('/api/admin/telegram/test', { method: 'POST' });
        if (t.sent) flash(msg, 'ok', 'Pesan uji terkirim.', 1500);
        else throw new Error(t.error || 'Pesan gagal terkirim');
      } catch (err) {
        flash(msg, 'err', 'Gagal: ' + err.message);
      } finally {
        b.disabled = false;
      }
    });
  });

  fs('[data-wd]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.dataset.wd;
      var approve = b.dataset.act === 'approve';
      var note = '';
      if (!approve) {
        if (!confirm('Tolak penarikan ' + id + '? Saldo akan dikembalikan ke pengguna.')) return;
        note = prompt('Alasan penolakan (opsional):') || '';
      } else {
        if (!confirm('Tandai penarikan ' + id + ' sebagai telah ditransfer?')) return;
      }
      b.disabled = true;
      try {
        await api('/api/admin/withdrawals/' + id + (approve ? '/approve' : '/reject'), { method: 'POST', body: JSON.stringify({ note: note }) });
        location.reload();
      } catch (err) {
        alert('Gagal: ' + err.message);
        b.disabled = false;
      }
    });
  });

  window.vanpayPoll = function (txnId, statusUrl) {
    var stopped = false;
    var countEl = $('qrCount');
    var stEl = $('qrSt');

    function tickCount() {
      if (!countEl) return;
      var exp = new Date(countEl.dataset.expires || '').getTime();
      if (Number.isNaN(exp)) return;
      var ms = exp - Date.now();
      if (ms <= 0) { countEl.textContent = 'kedaluwarsa'; return; }
      var m = Math.floor(ms / 60000);
      var s = Math.floor((ms % 60000) / 1000);
      countEl.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    tickCount();
    var countTimer = setInterval(tickCount, 1000);

    async function poll() {
      try {
        if (stopped) return;
        var st = await api(statusUrl);
        if (!st) return;
        if (st.status === 'EXPIRED') {
          stopped = true;
          clearInterval(countTimer);
          if (stEl) stEl.innerHTML = '<span class="badge expired">EXPIRED</span>';
          return;
        }
        if (st.status === 'PAID') {
          stopped = true;
          clearInterval(countTimer);
          if (stEl) stEl.innerHTML = '<span class="badge paid">PAID</span> <span class="badge done">Saldo telah masuk</span>';
          setTimeout(function () { location.href = '/dashboard/overview'; }, 2200);
        }
      } catch (_) {}
    }
    poll();
    setInterval(poll, 3000);
  };
})();
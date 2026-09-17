# VanPay Gateway

Payment gateway QRIS mandiri. User bikin QRIS dari dashboard, dibayar orang → saldo otomatis masuk, tarik tunai ke **DANA / GoPay / ShopeePay** (manual oleh admin, max 1–24 jam).

- **Payment**: scrape akun GoBiz/GoPay Merchant milik owner (QRIS dinamis dari QRIS statis merchant).
- **Login web**: Google & GitHub OAuth (opsional; owner cukup via link bootstrap).
- **Peran**: dashboard **user** (buat QRIS, riwayat, tarik, mutasi, statistik) & dashboard **owner** (statistik platform, kelola pengguna, proses penolakan/penyetujuan penarikan, dan **semua pengaturan**).
- **Setup 100% lewat web**: QRIS utama, mode QR, fee/limit, OAuth, Telegram, dan login GoBiz semuanya di `/dashboard` → **⚙ Pengaturan** (tanpa ngeribetin env & `PUBLIC_URL`).
- **Notifikasi**: bot Telegram untuk setiap deposit masuk dan penarikan.
- **Stack**: Node ≥ 22, Express, CommonJS, SQLite `node:sqlite` (bawaan).

## Flow bisnis

1. User login (Google/GitHub) — atau owner login lewat link bootstrap.
2. User bikin QRIS nominal `Rp 5.000` → sistem generate QRIS **Rp 5.000 + fee + kode unik (1–99)** (mode dinamis) atau tampilkan QR statis + nominal besar (mode statis).
3. Pembeli scan & bayar → dana masuk ke **merchant GoBiz owner**.
4. Poller deteksi nominal masuk → **saldo user +5000**, fee jadi milik owner. Notif Telegram.
5. User tarik dana (min 5rb) → saldo dikunci. Owner manual transfer & klik approve → selesai. Tolak → saldo di-refund.

## Setup (VPS / Pterodactyl / lokal)

```bash
node -v                # butuh >= 22
npm install
npm start
```

Boot log akan mencetak link setup owner:

```
GET  /bootstrap/<token>
```

Buka link itu sekali → akun jadi **owner**. Setelah itu **semua** pengaturan lewat web: dashboard → **⚙ Pengaturan**:

- **Status layanan** — ringkasan apakah QRIS/GoBiz/Telegram/OAuth sudah aktif.
- **QRIS utama & mode** — tempel string EMVCo (`000201…`) hasil scan QR statis GoBiz; pilih mode **dinamis** (default, nominal+kode unik otomatis) atau **statis** (QR tetap + nominal besar).
- **Biaya & limit** — fee %, fee minimum, min/max nominal QRIS, min/max penarikan.
- **Login web** — Client ID/Secret GitHub & Google + email owner (callback otomatis pakai domain kamu, tanpa `PUBLIC_URL`).
- **Notifikasi Telegram** — token bot + chat id, ada tombol kirim pesan uji.
- **Login GoBiz** — login OTP (nomor → kode) atau email+password, tombol refresh token & logout; status polling tercantum di kartu Status.

`.env` **tidak wajib**. Dipakai cuma sebagai fallback nilai awal (lihat `.env.example`).

## Cara ambil string QRIS utama

Buka aplikasi GoBiz / GoPay Merchant lu → menu QRIS → pilih QRIS statis → download/share gambar. Scan gambar QR itu pake aplikasi yang bisa baca raw payload (mis. pencet tombol "text" di scanner QR apa pun / tool EMVCo online). Hasilnya string panjang mulai `000201...`. Tempel ke Pengaturan → QRIS utama.

> Jangan masukkan URL/link; butuh payload EMVCo asli.

## Login GoBiz (poller)

Primer: `/dashboard` → ⚙ Pengaturan → Login GoBiz (kirim OTP → verifikasi, atau email+password). Sekunder: `node login.js` CLI. Token tersimpan aman di DB (`settings`), bisa di-refresh/logout dari web.

> Kecepatan polling dijaga `POLL_MIN_INTERVAL_MS >= 7000`. Lebih cepat = risiko akun strike.

## Deploy Vercel

Proyek sudah siap (`vercel.json`, `api/index.js`):

- **Butuh Postgres**: SQLite tidak persisten di Vercel. Set `DATABASE_URL` (Neon/Supabase) → otomatis pakai Postgres.
- **Secret**: `POLL_SECRET` diisi, lalu cron memanggil `/api/cron/poll?secret=...` tiap 5 menit (sudah ada di `vercel.json`).
- Self-host (Pterodactyl/VPS) disarankan biar polling jalan terus dari dalam proses (tanpa cron).

## Endpoint utama

```
GET  /bootstrap/:token                  → sekali pakai, bikin akun OWNER
GET  /auth/google  /auth/github        → login OAuth
GET  /dashboard                         → dashboard (user/owner)
POST /api/qris/create { amount, note }  → buat QRIS
GET  /api/qris/:id/qr.png               → gambar QR
GET  /api/qris/:id/status               → status PENDING/PAID/EXPIRED
POST /api/withdraw { amount, method, accountNumber, accountName }
GET  /api/stats                         → statistik user
GET  /api/admin/settings                → baca semua setelan (owner)
POST /api/admin/settings { entries }    → simpan setelan (owner)
POST /api/admin/gobiz/otp|verify|password|refresh|logout
POST /api/admin/telegram/test
POST /api/cron/poll?secret=...          → trigger polling manual
```

Metode tarik yang diterima: `DANA`, `GOPAY`, `SHOPEEPAY`. Minimal `MIN_WITHDRAW` (default 5.000).

## Keamanan

- Fee & kode unik dibebankan pembeli; download QR hanya pemilik/owner.
- Rate-limit create/tarik/OTP, session HttpOnly + SameSite=Lax, perbandingan token timing-safe.
- Nominal dicocokkan dengan `pay_amount` (unique) sehingga cocok & tidak dobel credit.
- Link bootstrap random & sekali jalan; bisa dipakai ulang sampai owner pertama dibuat.

---

⚠️ Proyek ini mengintegrasikan akun GoBiz/GoPay Merchant pribadi. Path endpoint GoBiz bisa berubah kapan aja; tersedia env `GOBIZ_HOST` dkk untuk penyesuaian. Gunakan dengan bijak & patuh aturan penyedia layanan.
# VanPay Gateway

Payment gateway QRIS mandiri. User bikin QRIS dari dashboard, dibayar orang → saldo otomatis masuk, tarik tunai ke **DANA / GoPay / ShopeePay** (manual oleh admin, max 1–24 jam).

- **Payment**: scrape akun GoBiz/GoPay Merchant milik owner (QRIS dinamis dari QRIS statis merchant).
- **Login web**: Google & GitHub OAuth.
- **Peran**: dashboard **user** (buat QRIS, riwayat, tarik, mutasi, statistik) & dashboard **owner** (statistik platform, kelola pengguna, proses penolakan/penyetujuan penarikan).
- **Notifikasi**: bot Telegram untuk setiap deposit masuk dan penarikan.
- **Stack**: Node ≥ 22, Express, CommonJS, SQLite `node:sqlite` (bawaan).

## Flow bisnis

1. User login (Google/GitHub).
2. User bikin QRIS nominal `Rp 5.000` → sistem generate QRIS dinamis **Rp 5.000 + fee + kode unik (1–99)**.
3. Pembeli scan & bayar → dana masuk ke **merchant GoBiz owner**.
4. Poller deteksi nominal masuk → **saldo user +5000**, fee jadi milik owner. Notif Telegram.
5. User tarik dana (min 5rb) → saldo dikunci. Owner manual transfer & klik approve → selesai. Tolak → saldo di-refund.

## Setup (VPS / Pterodactyl / lokal)

```bash
node -v                # butuh >= 22
npm install
cp .env.example .env   # lalu isi
node login.js          # login GoBiz (nomor HP + OTP) - token tersimpan di DB
npm start
```

Isi `.env` (wajib):

| Variabel | Keterangan |
| --- | --- |
| `PUBLIC_URL` | URL publik (redirect OAuth, mis. `https://vanpay.vercel.app`) |
| `QRIS_STRING` | **String EMVCo** QRIS statis GoBiz lu (dimulai `000201…`), bukan URL. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth app di GitHub → Settings → Developer settings → OAuth Apps (callback: `{PUBLIC_URL}/auth/github/callback`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth app Google (callback: `{PUBLIC_URL}/auth/google/callback`) |
| `OWNER_EMAIL` | Email yang login-nya otomatis jadi **owner**. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Notifikasi deposit & withdraw. |
| `FEE_PCT` | Fee QRIS (standar nasional, dibayar pembeli). |

Yang wajib diisi untuk jalan: `QRIS_STRING`, `PUBLIC_URL`. Tanpa OAuth/Telegram tetap jalan, fitur itu nonaktif (ada warning di log).

## Cara ambil `QRIS_STRING`

Buka aplikasi GoBiz / GoPay Merchant lu → menu QRIS → pilih QRIS statis → **download/share gambar**. Scan gambar QR itu pake aplikasi apa aja yang bisa baca raw payload (mis. `freedcam`, QR scanner yang menampilkan "text", atau tool online EMVCo). Hasilnya string panjang mulai `000201...`. Masukkan ke `.env`.

> Jangan masukkan URL/link; butuh payload EMVCo asli.

## Login GoBiz (poller)

```bash
node login.js
```

Pilih `o` (OTP): isi nomor (tanpa +62), lalu OTP yang masuk. Atau `p` (email+password). Token disimpan aman di DB (`settings`). Poller otomatis pakai & refresh (bila refresh_token tersedia).

> Kecepatan polling dijaga `POLL_MIN_INTERVAL_MS >= 7000`. Lebih cepat = risiko akun strike.

## Deploy Vercel

Proyek sudah siap (`vercel.json`, `api/index.js`):

- **Butuh Postgres**: SQLite tidak persisten di Vercel. Set `DATABASE_URL` (Neon/Supabase) → otomatis pakai Postgres.
- **Requires secret**: `POLL_SECRET` diisi, lalu cron akan memanggil `/api/cron/poll?secret=...` (vercel.json sudah didefinisikan tiap 5 menit). Google/GitHub callback pakai domain Vercel di `PUBLIC_URL`.
- Self-host (Pterodactyl/VPS) tetap disarankan buat volume tinggi & biar polling jalan terus dari dalam proses.

## Endpoint utama

```
GET  /auth/google  /auth/github        → login OAuth
GET  /dashboard                         → dashboard (user/owner)
POST /api/qris/create { amount, note }  → buat QRIS
GET  /api/qris/:id/qr.png               → gambar QR
GET  /api/qris/:id/status               → status PENDING/PAID/EXPIRED
POST /api/withdraw { amount, method, accountNumber, accountName }
GET  /api/stats                         → statistik user
GET  /api/admin/*                       → dashboard owner (role=owner)
POST /api/cron/poll?secret=...          → trigger polling manual
```

Metode tarik yang diterima: `DANA`, `GOPAY`, `SHOPEEPAY`. Minimal `MIN_WITHDRAW` (default 5.000).

## Keamanan

- Fee & kode unik dibebankan pembeli; download QR hanya pemilik/owner.
- Rate-limit create/tarik, session HttpOnly + SameSite=Lax, pemilik cek token timing-safe.
- Nominal dicocokkan dengan `pay_amount` (unique) sehingga cocok & tidak dobel credit.
- Ganti `WEBHOOK_SECRET` default sebelum production.

## Rekomendasi notifikasi

Bot Telegram: buat bot via @BotFather, dapatkan `TELEGRAM_BOT_TOKEN`. Cari chat id dengan @userinfobot → `TELEGRAM_CHAT_ID`. Notif otomatis untuk deposit & withdraw.

---

⚠️ Proyek ini mengintegrasikan akun GoBiz/GoPay Merchant pribadi. Path endpoint GoBiz bisa berubah kapan aja; tersedia env `GOBIZ_HOST` dkk untuk penyesuaian. Gunakan dengan bijak & patuh aturan penyedia layanan.
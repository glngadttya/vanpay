#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo -e "${RED}Butuh Node >= 22 (kamu pakai $(node -v)).${NC}"
  echo "Install dulu: https://nodejs.org (atau curl -fsSL https://deb.nodesource.com/setup_22.x | bash -)"
  exit 1
fi
echo -e "${GREEN}Node $(node -v) OK${NC}"

if [ ! -f package.json ]; then echo "Jalankan dari folder project."; exit 1; fi

echo "Install dependencies..."
npm install --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${GREEN}.env dibuat dari contoh. Isi sekarang.${NC}"
else
  echo ".env sudah ada - dilewati."
fi

echo ""
echo "=== Langkah berikutnya ==="
echo "1) Isi .env: QRIS_STRING (string QRIS statis GoBiz lu), GITHUB_CLIENT_ID/SECRET, GOOGLE_CLIENT_ID/SECRET, OWNER_EMAIL, PUBLIC_URL"
echo "2) Login GoBiz:   node login.js   (pilih mode otp, isi nomor + kode OTP)"
echo "3) Jalankan:      npm start"
echo "4) Buka:          http://localhost:3000"
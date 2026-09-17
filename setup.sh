#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo -e "${RED}Diperlukan Node >= 22 (saat ini $(node -v)).${NC}"
  echo "Instal terlebih dahulu: https://nodejs.org (atau curl -fsSL https://deb.nodesource.com/setup_22.x | bash -)"
  exit 1
fi
echo -e "${GREEN}Node $(node -v) OK${NC}"

if [ ! -f package.json ]; then echo "Jalankan dari folder utama project."; exit 1; fi

echo "Memasang dependencies..."
npm install --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${GREEN}.env dibuat dari contoh. Nilai dapat diubah nanti melalui Dashboard > Pengaturan.${NC}"
else
  echo ".env sudah ada - dilewati."
fi

echo ""
echo "=== Langkah berikutnya ==="
echo "1) Jalankan:      npm start"
echo "2) Buka:          http://localhost:3000"
echo "3) Owner:         Buka /bootstrap/<token> yang tercetak pada log saat boot pertama."
echo "4) Setup lengkap: Dashboard > Pengaturan (QRIS, GoBiz, Telegram, OAuth web)."
echo "   Atau gunakan .env sebagai nilai awal/fallback sebelum start."
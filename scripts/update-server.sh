#!/usr/bin/env bash
# Sunucuda güncelleme: git pull + npm ci + PM2 yeniden başlatma.
# Kullanım: twstats-whatsapp-bot klasöründen veya PATH'ten: bash scripts/update-server.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -d "$BOT_DIR/.git" ]; then
  REPO_ROOT="$BOT_DIR"
  INSTALL_DIR="$BOT_DIR"
elif [ -d "$(cd "$BOT_DIR/.." && pwd)/.git" ]; then
  REPO_ROOT="$(cd "$BOT_DIR/.." && pwd)"
  INSTALL_DIR="$BOT_DIR"
else
  echo "Hata: Üst dizinlerde .git bulunamadı. Bu script twstats-whatsapp-bot içinde olmalı." >&2
  exit 1
fi

echo "Repo: $REPO_ROOT"
cd "$REPO_ROOT"
git pull --ff-only

echo "Bağımlılıklar: $INSTALL_DIR"
cd "$INSTALL_DIR"
npm ci --omit=dev

if command -v pm2 >/dev/null 2>&1; then
  if [ -f "$INSTALL_DIR/ecosystem.config.cjs" ]; then
    pm2 restart "$INSTALL_DIR/ecosystem.config.cjs" --only twstats-bot
  else
    pm2 restart twstats-bot
  fi
  echo "PM2 yeniden başlatıldı."
else
  echo "Uyarı: pm2 bulunamadı; süreci elle yeniden başlatın (systemd veya node)." >&2
fi

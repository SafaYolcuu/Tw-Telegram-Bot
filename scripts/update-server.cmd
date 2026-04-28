@echo off
REM Tw-Telegram-Bot — Windows sunucuda güncelleme (CMD)
cd /d "%~dp0.."
git pull --ff-only
call npm ci --omit=dev
pm2 restart ecosystem.config.cjs

# Windows sunucuda: git pull + npm ci + PM2 yeniden başlatma
# Kullanım: powershell -ExecutionPolicy Bypass -File scripts/update-server.ps1
$ErrorActionPreference = 'Stop'
$BotDir = Split-Path -Parent $PSScriptRoot
$RepoRoot = $BotDir

if (Test-Path (Join-Path (Join-Path $BotDir '..') '.git')) {
    $RepoRoot = (Resolve-Path (Join-Path $BotDir '..')).Path
}

Write-Host "Repo: $RepoRoot"
Set-Location $RepoRoot
git pull --ff-only

Write-Host "Bağımlılıklar: $BotDir"
Set-Location $BotDir
npm ci --omit=dev

$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if ($pm2) {
    $eco = Join-Path $BotDir 'ecosystem.config.cjs'
    if (Test-Path $eco) {
        pm2 restart $eco --only twstats-bot
    } else {
        pm2 restart twstats-bot
    }
    Write-Host 'PM2 yeniden başlatıldı.'
} else {
    Write-Warning 'pm2 bulunamadı; npm start veya node index.js ile elle başlatın.'
}

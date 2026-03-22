# Sunucu kurulumu ve GitHub ile güncelleme

Manuel dosya kopyalamak yerine repoyu sunucuda `git clone` / `git pull` ile güncelleyin. **Repoyu private tutun**; `.env` ve Telegram token asla commit etmeyin ([`.gitignore`](.gitignore) `.env` dışlar).

## 1) GitHub

- Repoyu **private** oluşturun veya mevcut repoda **Settings → General → Danger Zone** ile private yapın.
- Sunucudan `git pull` için:
  - **Deploy key** (önerilen): Repo → **Settings → Deploy keys** → sunucunun `~/.ssh/id_ed25519.pub` içeriğini ekleyin (read-only yeterli).
  - Ya da kişisel **PAT** ile HTTPS (daha az tercih).

## 2) Sunucuda tek seferlik kurulum (Linux örneği)

Tüm monorepo (`yyeni`) klonlanıyorsa:

```bash
cd /opt   # veya $HOME
git clone git@github.com:KULLANICI/yyeni.git
cd yyeni/twstats-whatsapp-bot
chmod +x scripts/update-server.sh
npm ci --omit=dev
cp .env.example .env
nano .env   # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# config.json yoksa: cp config.example.json config.json && nano config.json
```

PM2:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # çıktıdaki komutu root olarak bir kez çalıştırın
```

### systemd (PM2 kullanmak istemezseniz)

`/etc/systemd/system/twstats-bot.service`:

```ini
[Unit]
Description=TW Stats Telegram bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/yyeni/twstats-whatsapp-bot
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` ve `User` kendi yolunuzla değiştirin:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now twstats-bot
```

## 3) Her kod güncellemesinde

Sunucuda:

```bash
cd /opt/yyeni/twstats-whatsapp-bot
bash scripts/update-server.sh
```

Veya tek satır (PM2 + monorepo kökü `/opt/yyeni` ise script bunu algılar):

```bash
bash /opt/yyeni/twstats-whatsapp-bot/scripts/update-server.sh
```

Yerel npm script (Linux/macOS, sunucuda):

```bash
npm run update:server
```

## 4) İsteğe bağlı: GitHub Actions ile otomatik deploy

`main` branch’e push olunca SSH ile sunucuda güncelleme için [.github/workflows/deploy.yml](.github/workflows/deploy.yml) kullanılır (ayrı repo: [Tw-Telegram-Bot](https://github.com/SafaYolcuu/Tw-Telegram-Bot)).

**Repository secrets** (GitHub → Settings → Secrets and variables → Actions):

| Secret | Örnek |
|--------|--------|
| `DEPLOY_HOST` | `203.0.113.10` |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | Sunucuya giriş için private key tam metni |
| `DEPLOY_PATH` | Bu botun klon kökü (içinde `package.json`), örn. `/opt/Tw-Telegram-Bot` |

Sunucuda Actions için ayrı bir SSH public key veya mevcut kullanıcı anahtarı tanımlayın; `DEPLOY_SSH_KEY` buna karşılık gelen **private** key olmalı.

**Monorepo** (`yyeni` içinde `twstats-whatsapp-bot` alt klasörü) kullanıyorsanız üst dizindeki workflow farklıdır; bu dosya **yalnızca ayrı bot reposu** içindir.

## Özet

| Adım | Ne |
|------|-----|
| Gizlilik | Private repo + `.env` commit yok |
| İlk kurulum | `git clone` → `npm ci` → `.env` + `config.json` → PM2 veya systemd |
| Güncelleme | `bash scripts/update-server.sh` veya `npm run update:server` |
| Otomatik | GitHub Actions + SSH secrets |

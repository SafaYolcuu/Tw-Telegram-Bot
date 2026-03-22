# TW Stats → Telegram

[tr.twstats.com](https://tr.twstats.com) tablolarını çeker, belirlediğiniz saatlerde Telegram’a özet gönderir.

**Sunucuda GitHub’dan çalıştırma / `git pull` ile güncelleme:** [DEPLOY.md](DEPLOY.md) (PM2, systemd, isteğe bağlı GitHub Actions).

---

## A) Projeyi hazırlama (bilgisayar / VPS)

1. [Node.js 18+](https://nodejs.org/) kurulu olsun.
2. Proje klasöründe: `npm install`
3. `config.example.json` dosyasını **`config.json`** olarak kopyalayın (zaten varsa atlayın).
4. `.env.example` dosyasını **`.env`** olarak kopyalayın veya `.env` oluşturun.

---

## B) Telegram botu (BotFather)

1. Telegram’da [@BotFather](https://t.me/BotFather) açın.
2. `/newbot` → isim ve kullanıcı adı verin.
3. BotFather’ın verdiği **HTTP API token** metnini kopyalayın.
4. `.env` içine yazın:
   ```env
   TELEGRAM_BOT_TOKEN=buraya_yapistirin
   ```

### Gizlilik modu (grupta çok önemli)

Varsayılan olarak bot, grupta **yalnızca** şu mesajları görür: `/komut`, bota yanıt, `@bot_mention`.

**chat_id almak ve botun grupta rahat çalışması için** BotFather’da:

- `/setprivacy` → botunuzu seçin → **Disable**

Böylece gruptaki normal mesajlar da `getUpdates` ile gelir; `telegram-updates` çıktısından `chat.id` okumak kolaylaşır.

---

## C) Grup ve chat_id

1. Hedef **grubu** açın → **Üyeler** → botu ekleyin.
2. İsterseniz bota **mesaj gönderme** izni verin (çoğu grupta yeterli; bazen yönetici gerekir).
3. Grupta kısa bir mesaj yazın (gizlilik açıksa `/start` veya `@BotAdınız merhaba` deneyin).
4. Proje klasöründe:
   ```bash
   npm run telegram-updates
   ```
5. Çıktıdaki **`chat.id`** değerini (çoğu grup `-100...` ile başlar) `.env` içine yazın:
   ```env
   TELEGRAM_CHAT_ID=-100xxxxxxxxxx
   ```
6. Doğrulama:
   ```bash
   npm run check-config
   npm run send-test
   ```
   Gruba “Kurulum testi” ile bir özet düşmeli.

7. Sürekli çalıştırma:
   ```bash
   npm start
   ```

8. **Telegram komutları** (`npm start` açıkken, yalnızca **`TELEGRAM_CHAT_ID` sohbeti**):  
   - **`/info`** — O an tam özet (takvim **bugünü**; gece yarısı otomatik rapordaki “dün” mantığı yok).  
   - **`/info` + GGAŞ** — Örn. **`/info2203`** = **22 Mart** gününün fetih sayıları (`config` `timezone` yılına göre; bu yılın tarihi henüz gelmediyse bir önceki yıl). Klan sıra/puan tablosu yine **şu anki** TW verisidir.  
   - **`/info.` + takma ad veya nick** — Örn. **`/info.safa`** → her gün için kaç köy + **toplam**. `telegramPlayerAliases` ile TW nick; haritada yoksa metin doğrudan aranır. **Son N gün** (varsayılan 3, `playerConquerStatsDays`) — TW «New owner» = oyuncu ve «Old owner» ≠ oyuncu. İsteğe bağlı: `maxPlayerConquerPages`.  
   - **TW saat dilimi:** TWStats tarih/saatleri Türkiye’den genelde **~2 saat geri** (kışın CET ≈ UTC+1, TR sabit UTC+3). Günlük sayımı `timezone` (örn. `Europe/Istanbul`) takvimine oturtmak için `twStatsDisplayedUtcOffsetMinutes` kullanılır: kış **60**, Avrupa yaz saati (CEST) döneminde çoğu zaman **120**. Verilmezse eski davranış: sadece TW’deki tarih satırı (saat yok sayılır).  
   - **`/gunsonu`** veya **`/günsonu`** — **Dünün** fetih özeti (manuel Z raporu; TW ağır istek).  
   - **`/plan`** veya **`/zaman`** — `config.json` içindeki `schedule` + `timezone` metni.  
   - **`/ping`** — Bot ayakta mı.  
   - **`/komutlar`**, **`/help`**, **`/yardim`**, **`/commands`** — Aynı metin: mevcut komutların listesi.  

   `/info` ve `/gunsonu` zamanlanmış gönderim kaydını **değiştirmez**. Bu ikisi için ortak kural: yaklaşık **45 sn** bekleme; biri çalışırken diğeri kuyrukta bekler uyarısı. Yeni komut eklemek için `index.js` içindeki `startTelegramPolling({ commands: [...] })` dizisine nesne eklemeniz yeterli (`src/telegramPoll.js` yönlendirir).  

   İsteğe bağlı BotFather → `/setcommands` örneği:  
   `info - Tam özet` / `gunsonu - Dünün özeti` / `plan - Gönderim saatleri` / `ping - Test` / `help - Komutlar`

   **Dikkat:** Bot çalışırken `npm run telegram-updates` çalıştırmayın; ikisi de Telegram’dan `getUpdates` bekler, güncellemeler tek akışta olduğu için biri diğerinin mesajlarını “çalar”.

---

## Komutlar

| Komut | Ne işe yarar |
|--------|----------------|
| `npm run check-config` | `config.json` + `.env` temel kontrol |
| `npm run telegram-updates` | `getUpdates` — `chat_id` bulma |
| `npm run send-test` | Tek seferlik test mesajı (gruba) |
| `npm run dry-run` | Metni terminale yazdırır (Telegram yok) |
| `npm start` | Zamanlayıcı + gönderim |

---

## D) Scripti özelleştirme (`config.json`)

| Alan | Ne yaparsınız |
|------|----------------|
| `worldLabel` | Mesaj başlığında görünen dünya adı (örn. `TR101`) |
| `schedule` | Gönderim saatleri `["12:00","00:00"]` — `timezone` ile birlikte. Tam **`00:00`** slotu: fetih sayıları **biten gün** için (Z raporu / gün sonu); diğer saatler **o günün** o ana kadar ki verisi |
| `timezone` | Örn. `Europe/Istanbul` |
| `sources` | Her satır: farklı **URL** + `matchHeaders` (tablodaki `th` metinleri) + `maxRows` |
| `requestDelayMs` | Ardışık sayfa istekleri arası bekleme |

Örnek: başka dünya → `url` içinde `tr101` yerine `tr85` vb. kullanın; tablo başlıkları aynı kalıyorsa `matchHeaders` değişmez.

Yeni bir tablo eklemek için `sources` dizisine yeni bir nesne eklemeniz yeterli (URL + o sayfadaki widget başlıkları).

### `type: tribe_top_villages_and_today_conquers`

İlk N klan için köy sayısı + **aynı klanların bugünkü** ( `timezone` takvimine göre ) ele geçirme adedi.

- **`gameGuestRankingUrl` (isteğe bağlı):** TW Stats bazen toplam **puan** ve **köy** sayısını gecikmeli günceller. Bu alanı doldurursanız (örn. [TR101 misafir klan sıralaması](https://tr101.klanlar.org/guest.php?screen=ranking&mode=ally)), listedeki **puan ve köy** değerleri oyun sitesinden okunur; **sıra ve klan kimliği** yine TW Stats’tan gelir, **bugün alınan köy** sayımı yine TW Stats klan fetih sayfalarındandır (değişmez).
- Sıralama: `rankingUrl` genelde `.../index.php?page=rankings&amp;mode=tribes`
- Bugünkü sayım: varsayılan **`todayConquerMethod`: `tribe_pages`** — TW Stats’taki klan sayfasıyla aynı mantık:  
  `index.php?page=tribe&amp;mode=conquers&amp;id=KLAN_ID&amp;type=&amp;pn=1` (site `pn=-1` ile tümünü gösterir; bot sayfa sayfa okur, `maxTribeConquerPages` ile sınırlı)
- Daha az istek isterseniz: `"todayConquerMethod": "world_ennoblements"` (dünya «Latest Ennoblements» taraması)
- **`trackTribeTransfers`: `true`** (varsayılan): İlk N klanın **üye listeleri** `tribe-transfer-snapshot.json` ile karşılaştırılır. Oyuncu **izlenen klanlar arasında** yer değiştirdiyse veya klanı hâlâ ilk N’deyken üye listesinde görünmüyorsa **Telegram bildirimi** gider. Bir klan sıralamada ilk N’nin dışına düşerse üyeleri artık taranmaz; bu durumda toplu “klandan ayrıldı” uyarısı **verilmez** (yanlış alarm önlenir). **Tarama her saat başı** (`Europe/Istanbul` vb. `timezone` ile) çalışır; özet mesajları yalnızca `schedule` saatlerinde gider. Bot açılır açılmaz bir kez de tarama yapılır (referans oluşsun diye). İlk kayıtta bildirim olmaz.

---

## E) Linux sunucuya kurulum (VPS)

Özet: projeyi sunucuya kopyalayın, Node 18+ kurun, `npm install`, `.env` + `config.json`, ardından süreç yöneticisi ile `npm start` sürekli çalışsın.

### 1) Sunucuda Node.js 18+

Ubuntu örneği (NodeSource — sürümü [nodejs.org](https://nodejs.org/) ile uyumlu seçin):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

### 2) Projeyi sunucuya alma

- **Git:** `git clone ...` veya kendi repomuz yoksa yerel klasörü **ZIP** / **scp** ile yükleyin.
- **scp (Windows PowerShell’den örnek):**  
  `scp -r "C:\Users\...\yyeni\twstats-whatsapp-bot" kullanici@SUNUCU_IP:/home/kullanici/`

Sunucuda:

```bash
cd ~/twstats-whatsapp-bot
npm install
cp config.example.json config.json   # veya bilgisayarınızdaki config.json’ı kopyalayın
nano .env
```

`.env` içinde en az: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

```bash
npm run check-config
npm run send-test
```

### 3) Sürekli çalıştırma — PM2 (önerilen)

```bash
sudo npm install -g pm2
cd ~/twstats-whatsapp-bot
pm2 start npm --name twstats-telegram -- start
pm2 save
pm2 startup
# Çıkan `sudo env PATH=...` komutunu bir kez çalıştırın
```

Log: `pm2 logs twstats-telegram` — yeniden başlatma: `pm2 restart twstats-telegram`

### 4) Güvenlik

- **SSH:** parola yerine anahtar, `PermitRootLogin no` önerilir.
- Bot **sadece dışarı HTTPS** isteği atar; gelen bağlantı portu açmanız gerekmez.
- `.env` ve snapshot dosyalarını başkalarıyla paylaşmayın; sunucuda `chmod 600 .env` kullanabilirsiniz.

### 5) Saat dilimi

Zamanlama `config.json` içindeki **`timezone`** (örn. `Europe/Istanbul`) ile yapılır; sunucunun `timedatectl` ayarı farklı olsa da bot İstanbul saatini kullanır.

---

## F) Windows sunucuda kurulum (Windows Server / kalıcı çalışma)

Özet: Node.js LTS kurun, projeyi bir klasöre kopyalayın, `npm install`, `.env` + `config.json`, ardından **Windows hizmeti** veya **Görev Zamanlayıcısı** ile `node index.js` sürekli çalışsın. `.env` dosyası varsayılan olarak **çalışma dizininden** okunur; hizmet/görevde **“Başlangıç konumu”** mutlaka proje klasörü olmalı.

### 1) Node.js 18+

1. [nodejs.org](https://nodejs.org/) üzerinden **LTS** `.msi` indirip kurun (PATH’e eklensin).
2. Yeni bir **PowerShell** veya **cmd** penceresinde: `node -v` (v18 veya üzeri).

### 2) Proje ve yapılandırma

1. Projeyi örneğin `C:\Apps\twstats-telegram-bot` gibi sabit bir yere kopyalayın (RDP, ZIP, paylaşım veya `git clone`).
2. O klasörde:
   ```powershell
   cd C:\Apps\twstats-telegram-bot
   npm install
   ```
3. `config.example.json` → `config.json`; `.env` içinde en az `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID`.
4. Doğrulama:
   ```powershell
   npm run check-config
   npm run send-test
   ```

### 3) Sürekli çalıştırma — NSSM (önerilen, Windows hizmeti)

[NSSM](https://nssm.cc/) ile `node.exe` + `index.js` bir **hizmet** olarak tanımlanır; sunucu yeniden başlasa da bot kalkar.

1. NSSM’yi indirip uygun mimariye göre (`win64` / `win32`) açın; örnek: `nssm.exe` ile **GUI** kullanın veya komut satırından:
   ```powershell
   nssm install TwStatsTelegram
   ```
2. NSSM penceresinde tipik değerler:
   - **Path (Application):** `C:\Program Files\nodejs\node.exe` (kurulum yolunuz farklıysa `where node` ile bakın)
   - **Startup directory:** `C:\Apps\twstats-telegram-bot` (proje klasörünüz)
   - **Arguments:** `index.js`
3. **I/O** sekmesinde stdout/stderr için bir log klasörü verebilirsiniz (hata ayıklama kolaylaşır).
4. Hizmeti başlatın: `services.msc` → **TwStatsTelegram** → Başlat veya:
   ```powershell
   nssm start TwStatsTelegram
   ```

Durdurma / yeniden başlatma: Hizmetler’den veya `nssm restart TwStatsTelegram`.

### 4) Alternatif — Görev Zamanlayıcısı

1. **Görev Zamanlayıcı** → **Basit görev oluştur** (veya normal görev).
2. **Tetikleyici:** Bilgisayar başladığında (ve gerekirse oturum açıldığında ikinci bir görev).
3. **Eylem:** Program başlat  
   - Program: `C:\Program Files\nodejs\node.exe`  
   - Bağımsız değişkenler: `index.js`  
   - **Başlat (çalışma dizini):** `C:\Apps\twstats-telegram-bot`
4. Oturum kapalıyken de çalışsın istiyorsanız: “Kullanıcı oturum açık olsun veya olmasın” seçeneği ve bir Windows kullanıcı parolası gerekir.

### 5) PM2 (isteğe bağlı)

```powershell
npm install -g pm2
cd C:\Apps\twstats-telegram-bot
pm2 start index.js --name twstats-telegram
pm2 save
pm2 startup
```

`pm2 startup` ekranda verdiği komutu **yönetici** PowerShell’de bir kez çalıştırın. Windows’ta kalıcı başlatma bazen NSSM’ye göre daha kırılgan olabilir; üretimde çoğu ekip **NSSM** veya **Görev Zamanlayıcısı** tercih eder.

### 6) Güvenlik ve notlar

- Bot yalnızca **dışarıya** HTTPS isteği atar; gelen bağlantı için port açmanız gerekmez.
- `.env` ve snapshot dosyalarına NTFS ile yalnızca hizmetin çalıştığı kullanıcı erişsin (gereksiz okuma yazmayı kapatın).
- Zamanlama yine `config.json` içindeki **`timezone`** ile yapılır; Windows bölge/saat ayarı farklı olsa da bot belirttiğiniz IANA saat dilimini kullanır.

---

## Güvenlik

`.env`, `last-sent.json` ve `tribe-transfer-snapshot.json` repoya eklenmez (`.gitignore`).

Klasör adı `twstats-whatsapp-bot` olabilir; paket adı `twstats-telegram-bot`’tur.

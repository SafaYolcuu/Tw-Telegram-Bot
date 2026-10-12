import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { diagnoseTwStatsHtml, fetchHtml } from './src/scrape.js';

const root = path.dirname(fileURLToPath(import.meta.url));
let failed = false;

function bad(msg) {
  console.error('✗', msg);
  failed = true;
}
function good(msg) {
  console.log('✓', msg);
}

const cfgPath = path.join(root, 'config.json');
if (!fs.existsSync(cfgPath)) {
  bad('config.json yok — config.example.json dosyasını config.json olarak kopyalayın.');
} else {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!Array.isArray(c.schedule) || c.schedule.length === 0) bad('config.json: schedule dizi ve boş olmamalı.');
    else good(`config.json schedule: ${c.schedule.join(', ')}`);
    if (!Array.isArray(c.sources) || c.sources.length === 0) bad('config.json: sources boş.');
    else good(`config.json: ${c.sources.length} kaynak`);
    if (!c.timezone) bad('config.json: timezone önerilir (örn. Europe/Istanbul).');
    else good(`timezone: ${c.timezone}`);
  } catch (e) {
    bad(`config.json okunamadı: ${e.message}`);
  }
}

const tok = process.env.TELEGRAM_BOT_TOKEN?.trim();
const barbarTok = process.env.TELEGRAM_BARBAR_BOT_TOKEN?.trim();
const cid = process.env.TELEGRAM_CHAT_ID?.trim();
const barbarCid = process.env.TELEGRAM_BARBAR_CHAT_ID?.trim();
if (!tok) bad('.env: TELEGRAM_BOT_TOKEN boş (Vegas bot token).');
else good('TELEGRAM_BOT_TOKEN dolu (Vegas)');
if (!cid) bad('.env: TELEGRAM_CHAT_ID boş (npm run telegram-updates ile bulun).');
else good('TELEGRAM_CHAT_ID dolu');

const cfgJson = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null;
if (cfgJson?.barbarMonitor?.enabled) {
  if (!barbarTok) {
    bad('.env: TELEGRAM_BARBAR_BOT_TOKEN boş (barbarMonitor açık — ayrı barbar bot token).');
  } else if (barbarTok === tok) {
    bad('.env: TELEGRAM_BARBAR_BOT_TOKEN, TELEGRAM_BOT_TOKEN ile aynı — iki ayrı bot kullanın.');
  } else good('TELEGRAM_BARBAR_BOT_TOKEN dolu (barbar bot)');
  if (!barbarCid) bad('.env: TELEGRAM_BARBAR_CHAT_ID boş (npm run telegram-updates -- --barbar).');
  else if (cid && barbarCid === cid) {
    bad('.env: TELEGRAM_BARBAR_CHAT_ID, TELEGRAM_CHAT_ID ile aynı — ayrı grup kullanın.');
  } else good('TELEGRAM_BARBAR_CHAT_ID dolu (barbar grubu)');
  if (cfgJson.barbarMonitor.server) good(`barbarMonitor.server: ${cfgJson.barbarMonitor.server}`);
} else if (barbarCid || barbarTok) {
  good('Barbar token/chat_id dolu (barbarMonitor kapalı — kullanılmaz)');
}

const tribeSrc = cfgJson?.sources?.find((s) => s.type === 'tribe_top_villages_and_today_conquers');
if (tribeSrc?.rankingUrl) {
  try {
    const html = await fetchHtml(tribeSrc.rankingUrl, { userAgent: cfgJson.userAgent });
    const diag = diagnoseTwStatsHtml(html);
    if (diag.ok) good(`TWStats erişilebilir (${html.length} byte)`);
    else bad(`TWStats: ${diag.reason}`);
  } catch (e) {
    bad(`TWStats isteği: ${e instanceof Error ? e.message : e}`);
  }
}

process.exit(failed ? 1 : 0);

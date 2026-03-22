import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const cid = process.env.TELEGRAM_CHAT_ID?.trim();
if (!tok) bad('.env: TELEGRAM_BOT_TOKEN boş (BotFather token).');
else good('TELEGRAM_BOT_TOKEN dolu');
if (!cid) bad('.env: TELEGRAM_CHAT_ID boş (npm run telegram-updates ile bulun).');
else good('TELEGRAM_CHAT_ID dolu');

process.exit(failed ? 1 : 0);

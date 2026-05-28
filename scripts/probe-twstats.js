import 'dotenv/config';
import { loadJsonConfig } from '../src/loadConfig.js';
import { diagnoseTwStatsHtml, fetchHtml } from '../src/scrape.js';

const cfg = loadJsonConfig();
const src = cfg.sources?.find((s) => s.type === 'tribe_top_villages_and_today_conquers');
if (!src?.rankingUrl) {
  console.error('config.json: tribe_top_villages_and_today_conquers rankingUrl gerekli.');
  process.exit(1);
}

const userAgent = cfg.userAgent;
const base = new URL(src.rankingUrl);
const urls = [
  { label: 'Klan sıralaması', url: src.rankingUrl },
  {
    label: 'Örnek fetih (THLK id=183)',
    url: `${base.origin}${base.pathname}?page=tribe&mode=conquers&id=183&pn=1`,
  },
];

let failed = false;
for (const { label, url } of urls) {
  console.log(`${label}`);
  console.log(`  ${url}`);
  try {
    const html = await fetchHtml(url, { userAgent });
    const diag = diagnoseTwStatsHtml(html);
    console.log(`  HTTP OK, ${html.length} byte`);
    if (diag.ok) {
      console.log('  Tablo okunabilir görünüyor.');
    } else {
      console.error(`  SORUN: ${diag.reason}`);
      failed = true;
    }
  } catch (e) {
    console.error(`  HATA: ${e instanceof Error ? e.message : e}`);
    failed = true;
  }
  console.log('');
}

process.exit(failed ? 1 : 0);

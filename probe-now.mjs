/**
 * TWStats erişim testi (sunucuda hemen çalıştırın).
 * Kullanım: node probe-now.mjs
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const ua =
  cfg.userAgent ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const urls = [
  ['Klan sıralaması', cfg.sources?.[0]?.rankingUrl || 'https://tr.twstats.com/tr101/index.php?page=rankings&mode=tribes'],
  ['THLK fetih', 'https://tr.twstats.com/tr101/index.php?page=tribe&mode=conquers&id=183&pn=1'],
];

function hasConquerTable(html) {
  const $ = cheerio.load(html);
  let found = false;
  $('table').each((_, el) => {
    const ths = $(el)
      .find('th')
      .map((_, th) => $(th).text().replace(/\s+/g, ' ').trim())
      .get();
    if (ths.some((t) => /^village$/i.test(t)) && ths.some((t) => /date/i.test(t) && /time/i.test(t))) {
      found = true;
      return false;
    }
  });
  return found;
}

function hasRankTable(html) {
  const $ = cheerio.load(html);
  return $('a[href*="page=tribe"]').length > 0;
}

let failed = false;
for (const [label, url] of urls) {
  console.log(`\n${label}`);
  console.log(`  ${url}`);
  try {
    const res = await axios.get(url, {
      timeout: 25000,
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
      },
      validateStatus: () => true,
    });
    const html = String(res.data || '');
    console.log(`  HTTP ${res.status}, ${html.length} byte`);
    if (res.status >= 400) {
      console.log('  SORUN: HTTP hata kodu');
      failed = true;
      continue;
    }
    if (/502 bad gateway|bad gateway/i.test(html)) {
      console.log('  SORUN: TWStats 502 (site kapalı)');
      failed = true;
      continue;
    }
    const okTable = label.includes('fetih') ? hasConquerTable(html) : hasRankTable(html);
    if (okTable) {
      console.log('  OK: Tablo bulundu');
    } else if (/Just a moment|challenge-platform|Enable JavaScript and cookies/i.test(html)) {
      console.log('  SORUN: Cloudflare — sunucu IP engellenmiş (bot tablo alamaz)');
      failed = true;
    } else {
      console.log('  SORUN: Tablo yok (HTML farklı veya eski bot kodu)');
      failed = true;
    }
  } catch (e) {
    console.log(`  HATA: ${e.message}`);
    failed = true;
  }
}

console.log(failed ? '\nSonuç: TWStats sunucudan düzgün okunamıyor.' : '\nSonuç: TWStats OK — güncel bot kodunu kopyalayın.');
process.exit(failed ? 1 : 0);

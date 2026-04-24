import axios from 'axios';
import * as cheerio from 'cheerio';

function normalizeCellText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Oyuncu adlarındaki * karakteri WhatsApp kalın yazımını bozmaması için */
function sanitizeForWhatsAppLine(text) {
  return text.replace(/\*/g, '\u2217');
}

function rowCells($, tr) {
  const cells = [];
  $(tr)
    .find('th, td')
    .each((_, el) => {
      const $el = $(el);
      if ($el.hasClass('foot')) return;
      const link = $el.find('a').first();
      const t = link.length ? normalizeCellText(link.text()) : normalizeCellText($el.text());
      cells.push(t);
    });
  return cells;
}

function headerTexts($, tr) {
  const h = [];
  $(tr)
    .find('th')
    .each((_, el) => {
      h.push(normalizeCellText($(el).text()));
    });
  return h;
}

function headersMatch(found, expected) {
  if (found.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (found[i].toLowerCase() !== expected[i].toLowerCase()) return false;
  }
  return true;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {string[]} matchHeaders
 */
function findWidgetTable($, matchHeaders) {
  const tables = $('table.widget').toArray();
  for (const table of tables) {
    const $table = $(table);
    const firstRow = $table.find('tr').first();
    const h = headerTexts($, firstRow);
    if (headersMatch(h, matchHeaders)) return $table;
  }
  return null;
}

/** `table.widget` veya `table.vis` içinde başlık eşleşeni bulur (tam sıralama sayfası için). */
function findWidgetOrVisTable($, matchHeaders) {
  for (const sel of ['table.widget', 'table.vis']) {
    for (const table of $(sel).toArray()) {
      const $table = $(table);
      const firstRow = $table.find('tr').first();
      const h = headerTexts($, firstRow);
      if (headersMatch(h, matchHeaders)) return $table;
    }
  }
  return null;
}

function tribeColumnIndices(matchHeaders) {
  if (matchHeaders.some((x) => /^tag$/i.test(x.trim()))) {
    return { tribeCol: 1, villagesCol: 6, totalPointsCol: 3 };
  }
  return { tribeCol: 1, villagesCol: 3, totalPointsCol: 2 };
}

/**
 * @param {import('cheerio').CheerioAPI} $table
 * @param {number} maxRows
 */
function extractDataRows($, $table, maxRows) {
  const rows = [];
  const trs = $table.find('tr').toArray();
  if (!trs.length) return rows;
  let start = 0;
  const firstCells = rowCells($, trs[0]);
  const isHeaderRow = $table.find('tr').first().find('th').length > 0;
  if (isHeaderRow) start = 1;

  for (let i = start; i < trs.length && rows.length < maxRows; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const cells = rowCells($, tr);
    if (!cells.length) continue;
    if (cells.every((c) => !c)) continue;
    rows.push(cells);
  }
  return rows;
}

export async function fetchHtml(url, options = {}) {
  const { userAgent, timeoutMs = 25000 } = options;
  const res = await axios.get(url, {
    timeout: timeoutMs,
    headers: {
      'User-Agent': userAgent || 'twstats-telegram-bot/1.0',
      Accept: 'text/html,application/xhtml+xml',
    },
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return res.data;
}

/**
 * @param {object} source
 * @param {string} source.url
 * @param {string} source.title
 * @param {string[]} source.matchHeaders
 * @param {number} [source.maxRows]
 */
export function ymdInTimeZone(timeZone, when = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(when);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

/**
 * TWStats fetih «Date/Time» hücresinin takvim günü: ilk `YYYY-MM-DD` parçası (sitedeki CEST/CET günü).
 * Klan fetih (`tribe_pages`) sayımı bunu kullanır; İstanbul’a çevirmek 24↔25 gibi sapmalara yol açar.
 */
export function twStatsConquerCellLocalYmd(dateRaw) {
  const trimmed = String(dateRaw).replace(/\s+/g, ' ').trim();
  const datePart = trimmed.split(/\s+/).filter(Boolean)[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  return datePart;
}

/**
 * TWStats «Date / Time» hücresini `reportTimeZone` takvim gününe çevirir (oyuncu fetihleri, dünya ennoblements).
 * `twStatsDisplayedUtcOffsetMinutes`: TW’de görünen saatin UTC’den farkı (dakika, doğuya pozitif). Örn. kış CET = 60, yaz CEST = 120.
 * Verilmezse yalnızca YYYY-MM-DD ilk parça kullanılır.
 */
export function conquerReportYmdFromTwCell(dateRaw, reportTimeZone, twStatsDisplayedUtcOffsetMinutes) {
  const trimmed = String(dateRaw).replace(/\s+/g, ' ').trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const datePart = parts[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  if (twStatsDisplayedUtcOffsetMinutes == null || Number.isNaN(Number(twStatsDisplayedUtcOffsetMinutes))) {
    return datePart;
  }
  const timePart = parts[1] || '00:00:00';
  const tp = timePart.split(':');
  const h = parseInt(tp[0], 10);
  const mins = parseInt(tp[1] ?? '0', 10);
  const sec = parseInt(tp[2] ?? '0', 10);
  if (![h, mins, sec].every((n) => Number.isFinite(n))) return datePart;
  const [Y, M, D] = datePart.split('-').map((x) => parseInt(x, 10));
  const off = Number(twStatsDisplayedUtcOffsetMinutes);
  const utcMs = Date.UTC(Y, M - 1, D, h, mins, sec) - off * 60 * 1000;
  const inst = new Date(utcMs);
  if (Number.isNaN(inst.getTime())) return datePart;
  return ymdInTimeZone(reportTimeZone, inst);
}

/**
 * TWStats HTML alt damgası (CEST/CET) → «Date/Time» sütununun UTC offset’i (dakika, doğuya pozitif).
 * Sayfa yaz saatinde CEST iken config’te 60 (CET) kalmışsa gece yarısı civarı fetihler yanlış güne kayar.
 */
export function twStatsUtcOffsetMinutesFromHtml(html) {
  const s = String(html);
  if (/\bCEST\b/i.test(s)) return 120;
  if (/\bCET\b/i.test(s)) return 60;
  return null;
}

/**
 * Önce sayfadaki CEST/CET; yoksa `configured` (null ise ham YYYY-MM-DD).
 */
export function resolveTwStatsUtcOffsetMinutes(html, configured) {
  const fromPage = twStatsUtcOffsetMinutesFromHtml(html);
  if (fromPage != null) return fromPage;
  if (configured == null || Number.isNaN(Number(configured))) return null;
  return Number(configured);
}

function isValidGregorianYmd(year, month, day) {
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCFullYear() === year && t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
}

/**
 * GGAŞ → YYYY-MM-DD (ay iki hane, gün iki hane). Örn. 2203 → 22 Mart.
 * Yıl: `timeZone` içindeki bugüne göre seçilir; seçilen gün henüz bu yıl gelmediyse bir önceki yıl.
 */
/** Takvim günü olarak YYYY-MM-DD + delta (Gregorian). */
export function ymdAddCalendarDays(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

export function conquerYmdFromDdMm(ddmm, timeZone) {
  if (!/^\d{4}$/.test(ddmm)) {
    throw new Error('Tarih GGAŞ olmalı (örn. 2203 = 22 Mart).');
  }
  const day = parseInt(ddmm.slice(0, 2), 10);
  const month = parseInt(ddmm.slice(2, 4), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('Geçersiz ay veya gün.');
  }
  const todayYmd = ymdInTimeZone(timeZone);
  let year = parseInt(todayYmd.slice(0, 4), 10);
  let ymd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!isValidGregorianYmd(year, month, day)) {
    throw new Error('Bu tarih takvimde yok (örn. 31 Haziran).');
  }
  if (ymd > todayYmd) {
    year -= 1;
    ymd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!isValidGregorianYmd(year, month, day)) {
      throw new Error('Geçersiz tarih.');
    }
  }
  return ymd;
}

/** Belirtilen saat diliminde bir önceki takvim günü (YYYY-MM-DD). Gece yarısı Z raporu için. */
export function ymdYesterdayInTimeZone(timeZone) {
  const today = ymdInTimeZone(timeZone);
  for (let h = 1; h <= 72; h++) {
    const y = ymdInTimeZone(timeZone, new Date(Date.now() - h * 3600000));
    if (y !== today) return y;
  }
  return today;
}

/**
 * Klan sıralamasından tribe id + isim + köy + toplam puan.
 * @returns {{ error: string | null, tribes: Array<{ tribeId: string, name: string, villages: string, totalPoints: string }> }}
 */
export function parseTribeTopWithIds(html, matchHeaders, maxRows) {
  const $ = cheerio.load(html);
  const $table = findWidgetOrVisTable($, matchHeaders);
  if (!$table) {
    return { error: 'Klan sıralama tablosu bulunamadı.', tribes: [] };
  }
  const { tribeCol, villagesCol, totalPointsCol } = tribeColumnIndices(matchHeaders);
  const trs = $table.find('tr').toArray();
  const tribes = [];
  for (let i = 1; i < trs.length && tribes.length < maxRows; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const $tr = $(tr);
    const $tribeA = $tr.find('td').eq(tribeCol).find('a[href*="page=tribe"]').first();
    if (!$tribeA.length) continue;
    const href = $tribeA.attr('href') || '';
    const idMatch = href.match(/[?&]id=(\d+)/);
    const tribeId = idMatch ? idMatch[1] : '';
    if (!tribeId) continue;
    const name = sanitizeForWhatsAppLine(normalizeCellText($tribeA.text()));
    const villages = sanitizeForWhatsAppLine(normalizeCellText($tr.find('td').eq(villagesCol).text()));
    const totalPoints = sanitizeForWhatsAppLine(
      normalizeCellText($tr.find('td').eq(totalPointsCol).text())
    );
    tribes.push({ tribeId, name, villages, totalPoints });
  }
  if (!tribes.length) return { error: 'Klan satırı çıkarılamadı.', tribes: [] };
  return { error: null, tribes };
}

export function normTribeTagKey(name) {
  return normalizeCellText(name).toLocaleLowerCase('tr-TR');
}

function tribeIdFromOwnerTribeCell($, td) {
  const $a = $(td).find('a.tribelink').first();
  if (!$a.length) return null;
  const href = $a.attr('href') || '';
  const m = href.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

/**
 * Dünya ennoblements: `targetYmd` gününde eski sahibi `victimTribeId` olan fetihlerde,
 * yeni sahibi `winnerTribeIdSet` içinde olan satırları klan id → adet olarak sayar.
 * Tarih: TWStats hücresindeki YYYY-MM-DD (klan fetihleriyle aynı mantık).
 */
function parseEnnoblementsPageVictimLossesAmongWinners(
  html,
  targetYmd,
  victimTribeId,
  winnerTribeIdSet
) {
  const $ = cheerio.load(html);
  const $table = findWidgetTable($, ['Village', 'Points', 'Old Owner', 'New Owner', 'Date/Time']);
  /** @type {Map<string, number>} */
  const counts = new Map();
  if (!$table) return { counts, hitOlderDay: true };

  const trs = $table.find('tr').toArray();
  if (trs.length <= 1) return { counts, hitOlderDay: true };

  let hitOlderDay = false;
  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const tds = $(tr).find('td').toArray();
    if (tds.length < 5) continue;
    const dateRaw = normalizeCellText($(tds[4]).text());
    const rowYmd = twStatsConquerCellLocalYmd(dateRaw);
    if (!rowYmd) continue;
    if (rowYmd < targetYmd) {
      hitOlderDay = true;
      break;
    }
    if (rowYmd > targetYmd) continue;

    const oldId = tribeIdFromOwnerTribeCell($, tds[2]);
    const newId = tribeIdFromOwnerTribeCell($, tds[3]);
    if (!oldId || oldId !== victimTribeId) continue;
    if (!newId || newId === victimTribeId) continue;
    if (!winnerTribeIdSet.has(newId)) continue;
    counts.set(newId, (counts.get(newId) || 0) + 1);
  }
  return { counts, hitOlderDay };
}

/**
 * Sıralama tablosundan klan etiketi → tribe id (ilk `maxScanRows` satırda arar).
 */
export function findTribeInRankingByTag(html, matchHeaders, tagQuery, maxScanRows = 500) {
  const want = normTribeTagKey(tagQuery);
  const { error, tribes } = parseTribeTopWithIds(html, matchHeaders, maxScanRows);
  if (error) return { error, tribe: null };
  const hit = tribes.find((t) => normTribeTagKey(t.name) === want);
  if (!hit) return { error: `Klan bulunamadı (ilk ${maxScanRows} sıra içinde): ${tagQuery}`, tribe: null };
  return { error: null, tribe: hit };
}

/**
 * `targetYmd` gününde `victimTribeId` klanından köy alan, sıralamada ilk `topTribeRows` içindeki klanların adetleri.
 * `rankingHtml` verilirse sıralama sayfası bir kez daha çekilmez.
 */
export async function countTakesFromVictimAmongTopTribes(rankingUrl, matchHeaders, options) {
  const {
    targetYmd,
    victimTribeId,
    victimName: victimNameOpt,
    topTribeRows,
    maxEnnPages = 40,
    userAgent,
    delayMs = 0,
    rankingHtml,
  } = options;

  const rankHtml = rankingHtml ?? (await fetchHtml(rankingUrl, { userAgent }));
  const { error, tribes } = parseTribeTopWithIds(rankHtml, matchHeaders, topTribeRows);
  if (error || !tribes.length) {
    return { error: error || 'Sıralama boş.', lines: [], victimName: victimNameOpt || '' };
  }

  const winnerIdSet = new Set(tribes.map((t) => String(t.tribeId)));
  winnerIdSet.delete(String(victimTribeId));

  const victimMeta = tribes.find((t) => String(t.tribeId) === String(victimTribeId));
  const victimName = victimNameOpt || victimMeta?.name || `#${victimTribeId}`;

  /** @type {Map<string, number>} */
  const totals = new Map();
  let stop = false;
  for (let pn = 1; pn <= maxEnnPages && !stop; pn++) {
    try {
      const url = ennoblementsListUrl(rankingUrl, pn);
      const html = await fetchHtml(url, { userAgent });
      const { counts, hitOlderDay } = parseEnnoblementsPageVictimLossesAmongWinners(
        html,
        targetYmd,
        String(victimTribeId),
        winnerIdSet
      );
      for (const [id, n] of counts) totals.set(id, (totals.get(id) || 0) + n);
      if (hitOlderDay) stop = true;
    } catch {
      stop = true;
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  const idToName = new Map(tribes.map((t) => [String(t.tribeId), t.name]));
  const lines = [...totals.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => {
      const tag = idToName.get(String(id)) || `#${id}`;
      return `${sanitizeForWhatsAppLine(tag)} — ${n} köy`;
    });

  return { error: null, lines, victimName };
}

/**
 * Oyun dünyası misafir sıralaması (örn. tr101.klanlar.org guest.php?screen=ranking&mode=ally).
 * TW Stats’taki kısaltmayla eşleştirmek için klan adı + köy + toplam puan döner.
 * @returns {Array<{ tag: string, villages: string, totalPoints: string }>}
 */
export function parseGameGuestAllyRanking(html, maxRows = 30) {
  const $ = cheerio.load(html);
  /** @type {import('cheerio').Cheerio | null} */
  let $rankTable = null;
  let nameIdx = -1;
  let pointsIdx = -1;
  let villagesIdx = -1;

  $('table').each((_, tbl) => {
    const $tbl = $(tbl);
    const ths = $tbl
      .find('tr')
      .first()
      .find('th')
      .map((_, th) => normalizeCellText($(th).text()))
      .get();
    if (ths.length < 4) return;
    const lower = ths.map((h) => h.toLocaleLowerCase('tr-TR'));
    const ni = lower.findIndex((h) => h.includes('klan'));
    const pi = lower.findIndex((h) => h.includes('toplam') && h.includes('puan'));
    const vi = lower.findIndex((h) => h.includes('köyler'));
    if (ni >= 0 && pi >= 0 && vi >= 0) {
      $rankTable = $tbl;
      nameIdx = ni;
      pointsIdx = pi;
      villagesIdx = vi;
      return false;
    }
  });

  if (!$rankTable || !$rankTable.length) return [];

  /** @type {Array<{ tag: string, villages: string, totalPoints: string }>} */
  const out = [];
  const trs = $rankTable.find('tr').toArray();
  for (let i = 1; i < trs.length && out.length < maxRows; i++) {
    const $tr = $(trs[i]);
    if ($tr.find('td.foot').length) continue;
    const tds = $tr.find('td').toArray();
    if (tds.length <= Math.max(nameIdx, pointsIdx, villagesIdx)) continue;
    const $nameTd = $(tds[nameIdx]);
    const $a = $nameTd.find('a[href*="info_ally"], a[href*="info%5Fally"]').first();
    if (!$a.length) continue;
    const tag = sanitizeForWhatsAppLine(normalizeCellText($a.text()));
    const totalPoints = sanitizeForWhatsAppLine(normalizeCellText($(tds[pointsIdx]).text()));
    const villages = sanitizeForWhatsAppLine(normalizeCellText($(tds[villagesIdx]).text()));
    if (!tag) continue;
    out.push({ tag, totalPoints, villages });
  }
  return out;
}

/**
 * @param {Array<{ tribeId: string, name: string, villages: string, totalPoints: string }>} tribes
 * @param {Array<{ tag: string, villages: string, totalPoints: string }>} guestRows
 */
function overlayTribePointsAndVillagesFromGuest(tribes, guestRows) {
  const byKey = new Map(guestRows.map((g) => [normTribeTagKey(g.tag), g]));
  for (const t of tribes) {
    const g = byKey.get(normTribeTagKey(t.name));
    if (g) {
      t.villages = g.villages;
      t.totalPoints = g.totalPoints;
    }
  }
}

/**
 * Bir ennoblements sayfası; bugün (todayYmd) olan satırları sayar, ilk eski güne gelince durur.
 */
function parseEnnoblementsPageForToday(html, targetYmd, reportTimeZone, twStatsDisplayedUtcOffsetMinutes) {
  const twOff = resolveTwStatsUtcOffsetMinutes(html, twStatsDisplayedUtcOffsetMinutes);
  const $ = cheerio.load(html);
  const $table = findWidgetTable($, ['Village', 'Points', 'Old Owner', 'New Owner', 'Date/Time']);
  const counts = new Map();
  if (!$table) return { counts, hitOlderDay: true };

  const trs = $table.find('tr').toArray();
  if (trs.length <= 1) return { counts, hitOlderDay: true };

  let hitOlderDay = false;
  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const $tr = $(tr);
    const tds = $tr.find('td').toArray();
    if (tds.length < 5) continue;
    const dateRaw = normalizeCellText($(tds[4]).text());
    const reportYmd = conquerReportYmdFromTwCell(dateRaw, reportTimeZone, twOff);
    if (!reportYmd) continue;
    if (reportYmd < targetYmd) {
      hitOlderDay = true;
      break;
    }
    if (reportYmd > targetYmd) continue;
    const $tribeA = $(tds[3]).find('a.tribelink').first();
    if (!$tribeA.length) continue;
    const href = $tribeA.attr('href') || '';
    const idMatch = href.match(/[?&]id=(\d+)/);
    const tribeId = idMatch ? idMatch[1] : '';
    if (!tribeId) continue;
    counts.set(tribeId, (counts.get(tribeId) || 0) + 1);
  }
  return { counts, hitOlderDay };
}

function ennoblementsListUrl(rankingUrl, pageNum) {
  const u = new URL(rankingUrl);
  const q = new URLSearchParams();
  q.set('page', 'ennoblements');
  q.set('pn', String(pageNum));
  return `${u.origin}${u.pathname}?${q.toString()}`;
}

/** Örnek: .../index.php?page=tribe&amp;mode=conquers&amp;id=183&amp;type=&amp;pn=1 */
function tribeConquersListUrl(rankingUrl, tribeId, pageNum) {
  const u = new URL(rankingUrl);
  const q = new URLSearchParams();
  q.set('page', 'tribe');
  q.set('mode', 'conquers');
  q.set('id', String(tribeId));
  q.set('type', '');
  q.set('pn', String(pageNum));
  return `${u.origin}${u.pathname}?${q.toString()}`;
}

/**
 * TWStats klan fetih tablosunda ilk hücredeki ikon: yeşil = klanın aldığı köy, kırmızı = kayıp, sarı = iç transfer vb.
 * «Alınan köy» sayımı yalnızca yeşil satırlarla uyumlu olmalı (aksi halde kırmızılar da eklenir).
 */
function tribeConquerRowIsGreenGain($, tds) {
  if (!tds.length) return false;
  const src = ($(tds[0]).find('img').first().attr('src') || '').toLowerCase();
  return src.includes('green.png');
}

/**
 * Klan «conquers» sayfasındaki tablo (Village … Date/Time); hedef güne denk gelen **yeşil (alım)** satırlarını sayar.
 * Gün eşlemesi: hücredeki `YYYY-MM-DD` (TWStats’ın CEST/CET takvimi); `conquerReportYmdFromTwCell` kullanılmaz.
 */
function parseTribeConquersWidgetForToday(html, targetYmd) {
  const $ = cheerio.load(html);
  let $table = null;
  $('table.widget').each((_, el) => {
    const $t = $(el);
    const ths = $t
      .find('tr')
      .first()
      .find('th')
      .map((_, th) => normalizeCellText($(th).text()))
      .get();
    const hasV = ths.some((x) => /^village$/i.test(x));
    const hasDt = ths.some((x) => /date/i.test(x) && /time/i.test(x));
    const hasOld = ths.some((x) => /^old owner$/i.test(x));
    const hasNew = ths.some((x) => /^new owner$/i.test(x));
    if (hasV && hasDt && hasOld && hasNew) {
      $table = $t;
      return false;
    }
  });
  if (!$table || !$table.length) return { added: 0, hitOlderDay: true };

  const ths = $table
    .find('tr')
    .first()
    .find('th')
    .map((_, th) => normalizeCellText($(th).text()))
    .get();
  const dateIdx = ths.findIndex((t) => /date/i.test(t) && /time/i.test(t));
  if (dateIdx < 0) return { added: 0, hitOlderDay: true };

  const trs = $table.find('tr').toArray();
  if (trs.length <= 1) return { added: 0, hitOlderDay: true };

  let added = 0;
  let hitOlderDay = false;
  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const tds = $(tr).find('td').toArray();
    if (tds.length <= dateIdx) continue;
    const dateRaw = normalizeCellText($(tds[dateIdx]).text());
    const rowYmd = twStatsConquerCellLocalYmd(dateRaw);
    if (!rowYmd) continue;
    if (rowYmd < targetYmd) {
      hitOlderDay = true;
      break;
    }
    if (rowYmd > targetYmd) continue;
    if (rowYmd === targetYmd && tribeConquerRowIsGreenGain($, tds)) added++;
  }
  return { added, hitOlderDay };
}

async function countTodayConquersViaTribePages(rankingUrl, tribeId, targetYmd, options, maxPages) {
  let total = 0;
  for (let pn = 1; pn <= maxPages; pn++) {
    try {
      const url = tribeConquersListUrl(rankingUrl, tribeId, pn);
      const html = await fetchHtml(url, { userAgent: options.userAgent });
      const { added, hitOlderDay } = parseTribeConquersWidgetForToday(html, targetYmd);
      total += added;
      if (hitOlderDay) break;
    } catch {
      break;
    }
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
  }
  return total;
}

/**
 * @param {object} src
 * @param {{ userAgent?: string, delayMs?: number, timezone?: string, conquerDayYmd?: string, twStatsDisplayedUtcOffsetMinutes?: number }} options
 * `conquerDayYmd`: TW Stats tarihine göre sayılacak gün (YYYY-MM-DD). Verilmezse takvimdeki bugün.
 */
async function collectTribeTopVillagesAndTodayConquers(src, options) {
  const tz = src.timezone || options.timezone || 'Europe/Istanbul';
  const maxRows = src.maxRows ?? 10;
  const maxEnnPages = src.maxEnnoblementPages ?? 40;
  const maxTribeConqPages = src.maxTribeConquerPages ?? 25;
  const todayMethod = src.todayConquerMethod || 'tribe_pages';
  const rankingUrl = src.rankingUrl || src.url;
  const matchHeaders = src.matchHeaders || [
    'Rank',
    'Tag',
    'Points of best 40',
    'Total Points',
    'Members',
    'Average points per member',
    'Villages',
    'Average points per village',
  ];
  const calendarTodayYmd = ymdInTimeZone(tz);
  const conquerYmd = options.conquerDayYmd ?? calendarTodayYmd;
  const twOff = options.twStatsDisplayedUtcOffsetMinutes;
  const topTitle = src.titleTopVillages || `İlk ${maxRows} klan — puan ve köy`;
  const defaultConqTitle =
    conquerYmd === calendarTodayYmd
      ? `İlk ${maxRows} klan — bugün alınan köy (${conquerYmd})`
      : `İlk ${maxRows} klan — ${conquerYmd} günü alınan köy (gün sonu)`;
  const conqTitle = src.titleTodayConquers || defaultConqTitle;
  const conqColLabel = conquerYmd === calendarTodayYmd ? 'Bugün' : 'Alınan';

  try {
    const rankHtml = await fetchHtml(rankingUrl, { userAgent: options.userAgent });
    const { error, tribes } = parseTribeTopWithIds(rankHtml, matchHeaders, maxRows);
    if (error) {
      return [
        { title: topTitle, url: rankingUrl, error, lines: [] },
        {
          title: conqTitle,
          url: tribes[0]
            ? tribeConquersListUrl(rankingUrl, tribes[0].tribeId, 1)
            : ennoblementsListUrl(rankingUrl, 1),
          error,
          lines: [],
        },
      ];
    }

    const guestUrl = src.gameGuestRankingUrl?.trim();
    if (guestUrl) {
      try {
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        const guestHtml = await fetchHtml(guestUrl, { userAgent: options.userAgent });
        const guestRows = parseGameGuestAllyRanking(guestHtml, Math.max(maxRows, 30));
        overlayTribePointsAndVillagesFromGuest(tribes, guestRows);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[gameGuestRankingUrl] Puan/köy güncellenemedi (TW Stats değerleri kullanılıyor): ${msg}`);
      }
    }

    const linesVillages = tribes.map(
      (t) => `${t.name} — ${t.totalPoints} puan · ${t.villages} köy`
    );
    const headersVillages = ['#', 'Klan', 'Puan', 'Köy'];
    const rowsVillages = tribes.map((t, i) => [
      String(i + 1),
      t.name,
      t.totalPoints,
      t.villages,
    ]);

    const countsByTribe = new Map();
    if (todayMethod === 'world_ennoblements') {
      let stop = false;
      for (let pn = 1; pn <= maxEnnPages && !stop; pn++) {
        try {
          const url = ennoblementsListUrl(rankingUrl, pn);
          const html = await fetchHtml(url, { userAgent: options.userAgent });
          const { counts, hitOlderDay } = parseEnnoblementsPageForToday(
            html,
            conquerYmd,
            tz,
            twOff
          );
          for (const [id, n] of counts) countsByTribe.set(id, (countsByTribe.get(id) || 0) + n);
          if (hitOlderDay) stop = true;
        } catch {
          stop = true;
        }
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      }
    } else {
      for (const t of tribes) {
        const c = await countTodayConquersViaTribePages(rankingUrl, t.tribeId, conquerYmd, {
          ...options,
          timezone: tz,
          twStatsDisplayedUtcOffsetMinutes: twOff,
        }, maxTribeConqPages);
        countsByTribe.set(t.tribeId, c);
      }
    }

    const linesConquers = tribes.map((t) => {
      const c = countsByTribe.get(t.tribeId) || 0;
      return `${t.name} — ${c} köy`;
    });
    const headersConquers = ['#', 'Klan', conqColLabel];
    const rowsConquers = tribes.map((t, i) => {
      const c = countsByTribe.get(t.tribeId) || 0;
      return [String(i + 1), t.name, `${c} köy`];
    });

    const conqExampleUrl = tribeConquersListUrl(rankingUrl, tribes[0].tribeId, 1);

    return [
      {
        title: topTitle,
        url: rankingUrl,
        error: null,
        lines: linesVillages,
        headers: headersVillages,
        rows: rowsVillages,
      },
      {
        title: conqTitle,
        url: conqExampleUrl,
        error: null,
        lines: linesConquers,
        headers: headersConquers,
        rows: rowsConquers,
      },
    ];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      { title: topTitle, url: rankingUrl, error: msg, lines: [] },
      { title: conqTitle, url: ennoblementsListUrl(rankingUrl, 1), error: msg, lines: [] },
    ];
  }
}

export function parseWidgetTable(html, source) {
  const $ = cheerio.load(html);
  const maxRows = source.maxRows ?? 10;
  const $table = findWidgetTable($, source.matchHeaders);
  if (!$table) {
    return {
      title: source.title,
      url: source.url,
      error: `Tablo bulunamadı (başlıklar: ${source.matchHeaders.join(', ')})`,
      lines: [],
    };
  }
  const headerTr = $table.find('tr').first();
  const headers = headerTexts($, headerTr);
  const dataRows = extractDataRows($, $table, maxRows);
  const rows = dataRows.map((cells) => cells.map(sanitizeForWhatsAppLine));
  const lines = rows.map((cells) => cells.join(' · '));
  return {
    title: source.title,
    url: source.url,
    headers,
    lines,
    rows,
    error: null,
  };
}

export async function collectSources(sources, options = {}) {
  const { userAgent, delayMs = 0, timezone, conquerDayYmd, twStatsDisplayedUtcOffsetMinutes } = options;
  const results = [];
  for (const src of sources) {
    try {
      if (src.type === 'tribe_top_villages_and_today_conquers') {
        const parts = await collectTribeTopVillagesAndTodayConquers(src, {
          userAgent,
          delayMs,
          timezone,
          conquerDayYmd,
          twStatsDisplayedUtcOffsetMinutes,
        });
        results.push(...parts);
      } else {
        const html = await fetchHtml(src.url, { userAgent });
        results.push(parseWidgetTable(html, src));
      }
    } catch (e) {
      results.push({
        title: src.title || src.rankingUrl || 'Kaynak',
        url: src.url || src.rankingUrl,
        error: e instanceof Error ? e.message : String(e),
        lines: [],
      });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return results;
}

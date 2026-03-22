import * as cheerio from 'cheerio';
import { agentLog } from './debugAgentLog.js';
import {
  conquerReportYmdFromTwCell,
  fetchHtml,
  ymdAddCalendarDays,
  ymdInTimeZone,
} from './scrape.js';
import { escapeHtml } from './formatMessage.js';

function normalizeCellText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function normTr(s) {
  return normalizeCellText(s).toLocaleLowerCase('tr-TR');
}

/**
 * TWStats’te sık görülen baş/son yıldızlar (örn. **nick**); ara boşluk/zero-width ile birlikte kırpılır.
 */
function stripOuterAsterisks(s) {
  let t = normalizeCellText(String(s));
  let prev;
  do {
    prev = t;
    t = t
      .replace(/^[\s\u200b\u200c\u200d\*＊∗]+/u, '')
      .replace(/[\s\u200b\u200c\u200d\*＊∗]+$/u, '');
    t = normalizeCellText(t);
  } while (t !== prev);
  return t;
}

function normTrNickComparable(s) {
  return normTr(stripOuterAsterisks(s));
}

export function worldIndexBaseFromRankingUrl(rankingUrl) {
  const u = new URL(rankingUrl);
  return `${u.origin}${u.pathname}`;
}

function playerSearchUrl(worldBase, searchName) {
  const u = new URL(worldBase);
  u.search = '';
  const q = new URLSearchParams();
  q.set('page', 'rankings');
  q.set('mode', 'players');
  q.set('searchstring', searchName);
  return `${u.toString()}?${q.toString()}`;
}

function playerConquersPageUrl(worldBase, playerId, pageNum) {
  const u = new URL(worldBase);
  u.search = '';
  const q = new URLSearchParams();
  q.set('page', 'player');
  q.set('mode', 'conquers');
  q.set('id', String(playerId));
  q.set('pn', String(pageNum));
  return `${u.toString()}?${q.toString()}`;
}

/**
 * @param {string} worldBase
 * @param {string} ingameSearchName TW’de görünen tam nick (alias çözülmüş)
 * @returns {{ playerId: string, matchedName: string } | null}
 */
export async function searchPlayerByName(worldBase, ingameSearchName, options = {}) {
  const { userAgent } = options;
  const stripped = stripOuterAsterisks(ingameSearchName);
  const searchQuery = stripped.length ? stripped : ingameSearchName;
  const url = playerSearchUrl(worldBase, searchQuery);
  const html = await fetchHtml(url, { userAgent });
  const $ = cheerio.load(html);
  const targetNorm = normTrNickComparable(ingameSearchName);
  /** @type {Map<string, string>} */
  const byId = new Map();
  $('a[href*="page=player"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/[?&]id=(\d+)/);
    if (!m) return;
    const id = m[1];
    if (byId.has(id)) return;
    const name = normalizeCellText($(a).text());
    if (!name) return;
    byId.set(id, name);
  });
  const entries = [...byId.entries()];
  if (entries.length === 0) return null;
  const exact = entries.find(([, name]) => normTrNickComparable(name) === targetNorm);
  if (exact) return { playerId: exact[0], matchedName: exact[1] };
  // Tek satır olsa bile isim tam eşleşmiyorsa kabul etme (örn. arama "safa" → yanlışlıkla "safadinho").
  return null;
}

function ownerCellComparable($, td) {
  const $a = $(td).find('a.playerlink').first();
  let raw = $a.length ? normalizeCellText($a.text()) : normalizeCellText($(td).text());
  raw = raw.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  raw = stripOuterAsterisks(raw);
  return normTr(raw);
}

/**
 * @returns {{ byDay: Record<string, number>, stopPaging: boolean }}
 */
function parsePlayerConquersPage(
  html,
  ingameNorm,
  minYmd,
  maxYmd,
  reportTimeZone,
  twStatsDisplayedUtcOffsetMinutes
) {
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
    const hasNew = ths.some((x) => /^new owner$/i.test(x));
    if (hasV && hasDt && hasNew) {
      $table = $t;
      return false;
    }
  });
  if (!$table || !$table.length) return { byDay: {}, stopPaging: true };

  const ths = $table
    .find('tr')
    .first()
    .find('th')
    .map((_, th) => normalizeCellText($(th).text()))
    .get();
  const oldIdx = ths.findIndex((t) => /^old owner$/i.test(t));
  const newIdx = ths.findIndex((t) => /^new owner$/i.test(t));
  const dateIdx = ths.findIndex((t) => /date/i.test(t) && /time/i.test(t));
  if (oldIdx < 0 || newIdx < 0 || dateIdx < 0) return { byDay: {}, stopPaging: true };

  /** @type {Record<string, number>} */
  const byDay = {};
  let stopPaging = false;
  const trs = $table.find('tr').toArray();
  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const tds = $(tr).find('td').toArray();
    if (tds.length <= dateIdx) continue;
    const dateRaw = normalizeCellText($(tds[dateIdx]).text());
    const reportYmd = conquerReportYmdFromTwCell(dateRaw, reportTimeZone, twStatsDisplayedUtcOffsetMinutes);
    if (!reportYmd) continue;
    if (reportYmd < minYmd) {
      stopPaging = true;
      break;
    }
    if (reportYmd > maxYmd) continue;
    const oldN = ownerCellComparable($, tds[oldIdx]);
    const newN = ownerCellComparable($, tds[newIdx]);
    const gain = newN === ingameNorm && oldN !== ingameNorm;
    if (gain) byDay[reportYmd] = (byDay[reportYmd] || 0) + 1;
  }
  return { byDay, stopPaging };
}

/**
 * Oyuncunun son N takvim gününde (bugün dahil) günlük ve toplam köy alımı.
 */
export async function countPlayerConquersLastNDays({
  worldBase,
  playerId,
  ingameName,
  timeZone,
  days = 3,
  userAgent,
  delayMs = 0,
  maxPages = 35,
  twStatsDisplayedUtcOffsetMinutes,
}) {
  const todayYmd = ymdInTimeZone(timeZone);
  const minYmd = ymdAddCalendarDays(todayYmd, -(days - 1));
  const ingameNorm = normTrNickComparable(ingameName);
  /** @type {Record<string, number>} */
  const merged = {};
  for (let pn = 1; pn <= maxPages; pn++) {
    const url = playerConquersPageUrl(worldBase, playerId, pn);
    const html = await fetchHtml(url, { userAgent });
    const { byDay, stopPaging } = parsePlayerConquersPage(
      html,
      ingameNorm,
      minYmd,
      todayYmd,
      timeZone,
      twStatsDisplayedUtcOffsetMinutes
    );
    for (const [ymd, n] of Object.entries(byDay)) {
      merged[ymd] = (merged[ymd] || 0) + n;
    }
    if (stopPaging) break;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  const total = Object.values(merged).reduce((a, b) => a + b, 0);
  return { total, byDay: merged, minYmd, maxYmd: todayYmd, days };
}

export function resolveTelegramKeyToIngame(cfg, telegramKey) {
  const key = telegramKey.trim();
  const keyNorm = normTr(key);
  const aliases = cfg.telegramPlayerAliases;
  let resolved = key;
  let matchedKey = null;
  if (aliases && typeof aliases === 'object') {
    for (const [k, v] of Object.entries(aliases)) {
      if (normTr(k) === keyNorm && typeof v === 'string' && v.trim()) {
        matchedKey = k;
        resolved = v.trim();
        break;
      }
    }
  }
  // #region agent log
  agentLog({
    hypothesisId: 'H2',
    location: 'playerConquers.js:resolveTelegramKeyToIngame',
    message: 'alias resolve',
    data: {
      rawKeyLen: telegramKey.length,
      keyNorm,
      aliasObjectKeys: aliases && typeof aliases === 'object' ? Object.keys(aliases).length : 0,
      matchedAliasKey: matchedKey,
      resolvedIngame: resolved,
    },
  });
  // #endregion
  return resolved;
}

/**
 * @param {{ worldLabel?: string, timeZone: string, telegramKey: string, ingameName: string, matchedName: string, total: number, byDay: Record<string, number>, minYmd: string, maxYmd: string, days: number }} p
 */
export function formatPlayerConquersSummaryHtml(p) {
  const w = escapeHtml(p.worldLabel || 'TW');
  const nick = escapeHtml(p.ingameName);
  const shown = normTr(p.matchedName) !== normTr(p.ingameName) ? escapeHtml(p.matchedName) : null;
  const aliasLine =
    normTr(p.telegramKey) !== normTr(p.ingameName)
      ? `\n<i>Takma ad:</i> ${escapeHtml(p.telegramKey)}`
      : '';
  const matchLine = shown ? `\n<i>TW eşleşmesi:</i> ${shown}` : '';
  const nDays = p.days ?? 3;
  const head = `<b>Son ${nDays} gün — ${nick}</b> (${w})${aliasLine}${matchLine}`;
  const tz = escapeHtml(p.timeZone || 'Europe/Istanbul');
  const lines = [];
  for (let i = 0; i < nDays; i++) {
    const ymd = ymdAddCalendarDays(p.minYmd, i);
    const c = p.byDay[ymd] || 0;
    lines.push(`• ${escapeHtml(ymd)}: <b>${c}</b> köy`);
  }
  const body = `\n\n${lines.join('\n')}\n\n<b>Toplam: ${p.total} köy</b>\n<i>${tz} takvimi</i>`;
  return `${head}${body}`;
}

import * as cheerio from 'cheerio';
import {
  conquerReportYmdFromTwCell,
  ennoblementsListUrl,
  fetchHtml,
  findTribeInRankingByTag,
  normTribeTagKey,
  parseTribeTopWithIds,
  resolveTwStatsUtcOffsetMinutes,
  tribeConquersListUrl,
  ymdInTimeZone,
} from './scrape.js';
import { escapeHtml } from './formatMessage.js';

const DEFAULT_MATCH_HEADERS = [
  'Rank',
  'Tag',
  'Points of best 40',
  'Total Points',
  'Members',
  'Average points per member',
  'Villages',
  'Average points per village',
];

/**
 * @param {object} war
 * @returns {string}
 */
export function warCommandSlug(war) {
  if (war?.command) {
    return String(war.command)
      .toLocaleLowerCase('tr-TR')
      .replace(/[^a-z0-9]/gi, '');
  }
  return String(war?.name || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/gi, '');
}

/**
 * @param {object} cfg
 * @returns {object[]}
 */
export function normalizeWars(cfg) {
  if (Array.isArray(cfg?.wars) && cfg.wars.length) return cfg.wars;
  if (Array.isArray(cfg?.warSides) && cfg.warSides.length) {
    return [{ name: 'Savaş', command: 'savas', sides: cfg.warSides }];
  }
  return [];
}

/**
 * GGAAYYYY → YYYY-MM-DD (örn. 13102026 → 2026-10-13).
 * @param {string} ddmmyyyy
 * @returns {string}
 */
export function conquerYmdFromDdMmYyyy(ddmmyyyy) {
  if (!/^\d{8}$/.test(ddmmyyyy)) {
    throw new Error('Tarih GGAAYYYY olmalı (örn. 13102026 = 13 Ekim 2026).');
  }
  const day = parseInt(ddmmyyyy.slice(0, 2), 10);
  const month = parseInt(ddmmyyyy.slice(2, 4), 10);
  const year = parseInt(ddmmyyyy.slice(4, 8), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('Geçersiz ay veya gün.');
  }
  const t = new Date(Date.UTC(year, month - 1, day));
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) {
    throw new Error('Bu tarih takvimde yok.');
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeCellText(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function tableHeaderTexts($, $table) {
  return $table
    .find('tr')
    .first()
    .find('th')
    .map((_, th) => normalizeCellText($(th).text()))
    .get();
}

function findTribeConquerTable($) {
  for (const sel of ['table.widget', 'table.vis', 'table']) {
    for (const table of $(sel).toArray()) {
      const $t = $(table);
      const ths = tableHeaderTexts($, $t);
      const hasV = ths.some((x) => /^village$/i.test(x));
      const hasDt = ths.some((x) => /date/i.test(x) && /time/i.test(x));
      const hasOld = ths.some((x) => /^old owner$/i.test(x));
      const hasNew = ths.some((x) => /^new owner$/i.test(x));
      if (hasV && hasDt && hasOld && hasNew) return $t;
    }
  }
  return null;
}

function tribeIdFromOwnerTribeCell($, td) {
  const $a = $(td).find('a.tribelink').first();
  if (!$a.length) return null;
  const href = $a.attr('href') || '';
  const m = href.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

function tribeConquerIconKind($, tds) {
  if (!tds.length) return 'unknown';
  const src = ($(tds[0]).find('img').first().attr('src') || '').toLowerCase();
  if (src.includes('green.png')) return 'gain';
  if (src.includes('red.png')) return 'loss';
  return 'none';
}

function isGreenGainRow($, tds, tribeId, oldIdx, newIdx) {
  const kind = tribeConquerIconKind($, tds);
  if (kind === 'gain') return true;
  if (kind === 'loss') return false;
  if (tribeId == null || oldIdx == null || newIdx == null) return false;
  const tid = String(tribeId);
  const oldId = tribeIdFromOwnerTribeCell($, tds[oldIdx]);
  const newId = tribeIdFromOwnerTribeCell($, tds[newIdx]);
  if (newId === tid && oldId !== tid) return true;
  if (oldId !== tid && $(tds[newIdx]).find('a.playerlink').length > 0) return true;
  return false;
}

function findEnnoblementsTable($) {
  for (const sel of ['table.widget', 'table.vis', 'table']) {
    for (const table of $(sel).toArray()) {
      const $t = $(table);
      const ths = tableHeaderTexts($, $t);
      const hasV = ths.some((x) => /^village$/i.test(x));
      const hasOld = ths.some((x) => /^old owner$/i.test(x));
      const hasNew = ths.some((x) => /^new owner$/i.test(x));
      const hasDt = ths.some((x) => /date/i.test(x) && /time/i.test(x));
      if (hasV && hasOld && hasNew && hasDt) return $t;
    }
  }
  return null;
}

/**
 * Dünya ennoblements sayfası — belirli TR günü (hızlı günlük savaş skoru).
 * New owner taraf kazanır; old owner rakip taraftaysa cross.
 */
function parseWarEnnoblementsPage(
  html,
  { tribeIdToSideIdx, targetYmd, timeZone, twStatsDisplayedUtcOffsetMinutes }
) {
  const $ = cheerio.load(html);
  const $table = findEnnoblementsTable($);
  /** @type {Map<string, number>} */
  const cross = new Map();
  /** @type {Map<number, number>} */
  const sideGains = new Map();
  if (!$table?.length) return { cross, sideGains, hitOlderDay: true, tableFound: false };

  const ths = tableHeaderTexts($, $table);
  const dateIdx = ths.findIndex((t) => /date/i.test(t) && /time/i.test(t));
  const oldIdx = ths.findIndex((t) => /^old owner$/i.test(t));
  const newIdx = ths.findIndex((t) => /^new owner$/i.test(t));
  if (dateIdx < 0 || oldIdx < 0 || newIdx < 0) {
    return { cross, sideGains, hitOlderDay: true, tableFound: true };
  }

  const twOff = resolveTwStatsUtcOffsetMinutes(html, twStatsDisplayedUtcOffsetMinutes);
  const trs = $table.find('tr').toArray();
  let hitOlderDay = false;

  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const tds = $(tr).find('td').toArray();
    if (tds.length <= Math.max(dateIdx, oldIdx, newIdx)) continue;

    const dateRaw = normalizeCellText($(tds[dateIdx]).text());
    const reportYmd = conquerReportYmdFromTwCell(dateRaw, timeZone, twOff);
    if (!reportYmd) continue;
    if (reportYmd < targetYmd) {
      hitOlderDay = true;
      break;
    }
    if (reportYmd > targetYmd) continue;

    const newId = tribeIdFromOwnerTribeCell($, tds[newIdx]);
    if (!newId) continue;
    const winnerSide = tribeIdToSideIdx.get(String(newId));
    if (winnerSide == null) continue;

    sideGains.set(winnerSide, (sideGains.get(winnerSide) || 0) + 1);

    const oldId = tribeIdFromOwnerTribeCell($, tds[oldIdx]);
    if (!oldId) continue;
    const victimSide = tribeIdToSideIdx.get(String(oldId));
    if (victimSide == null || victimSide === winnerSide) continue;
    const key = `${winnerSide}->${victimSide}`;
    cross.set(key, (cross.get(key) || 0) + 1);
  }
  return { cross, sideGains, hitOlderDay, tableFound: true };
}

/**
 * Kazanan klanın fetih sayfası (toplam skor yolu).
 */
function parseCrossSideGainsFromPage(
  html,
  {
    winnerTribeId,
    winnerSideIdx,
    tribeIdToSideIdx,
    targetYmd,
    timeZone,
    twStatsDisplayedUtcOffsetMinutes,
  }
) {
  const $ = cheerio.load(html);
  const $table = findTribeConquerTable($);
  /** @type {Map<string, number>} */
  const cross = new Map();
  let sideGains = 0;
  if (!$table?.length) return { cross, sideGains, hitOlderDay: true, tableFound: false, empty: true };

  const ths = tableHeaderTexts($, $table);
  const dateIdx = ths.findIndex((t) => /date/i.test(t) && /time/i.test(t));
  const oldIdx = ths.findIndex((t) => /^old owner$/i.test(t));
  const newIdx = ths.findIndex((t) => /^new owner$/i.test(t));
  if (dateIdx < 0 || oldIdx < 0 || newIdx < 0) {
    return { cross, sideGains, hitOlderDay: true, tableFound: true, empty: true };
  }

  const twOff = resolveTwStatsUtcOffsetMinutes(html, twStatsDisplayedUtcOffsetMinutes);
  const trs = $table.find('tr').toArray();
  let hitOlderDay = false;
  let dataRows = 0;

  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const tds = $(tr).find('td').toArray();
    if (tds.length <= Math.max(dateIdx, oldIdx, newIdx)) continue;
    dataRows += 1;

    const dateRaw = normalizeCellText($(tds[dateIdx]).text());
    const reportYmd = conquerReportYmdFromTwCell(dateRaw, timeZone, twOff);
    if (!reportYmd) continue;

    if (targetYmd) {
      if (reportYmd < targetYmd) {
        hitOlderDay = true;
        break;
      }
      if (reportYmd > targetYmd) continue;
    }

    if (!isGreenGainRow($, tds, winnerTribeId, oldIdx, newIdx)) continue;

    sideGains += 1;

    const oldId = tribeIdFromOwnerTribeCell($, tds[oldIdx]);
    if (!oldId) continue;
    const victimSideIdx = tribeIdToSideIdx.get(String(oldId));
    if (victimSideIdx == null || victimSideIdx === winnerSideIdx) continue;

    const key = `${winnerSideIdx}->${victimSideIdx}`;
    cross.set(key, (cross.get(key) || 0) + 1);
  }

  return { cross, sideGains, hitOlderDay, tableFound: true, empty: dataRows <= 0 };
}

async function mapPool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * @param {object} cfg
 * @param {object} war
 * @param {{ conquerDayYmd?: string | null }} [opts]
 */
export async function computeWarStats(cfg, war, opts = {}) {
  const targetYmd = opts.conquerDayYmd ?? null;
  const tz = cfg.timezone || 'Europe/Istanbul';
  const tribeSrc = cfg.sources?.find((s) => s.type === 'tribe_top_villages_and_today_conquers');
  const rankingUrl = tribeSrc?.rankingUrl || tribeSrc?.url;
  const matchHeaders = tribeSrc?.matchHeaders || DEFAULT_MATCH_HEADERS;
  if (!rankingUrl) {
    return { error: 'config.json: rankingUrl gerekli.', warName: war.name, missingTags: [], sideGains: [], cross: [] };
  }

  const sides = Array.isArray(war.sides) ? war.sides : [];
  if (sides.length < 2) {
    return {
      error: 'Savaşta en az 2 taraf gerekli.',
      warName: war.name,
      missingTags: [],
      sideGains: [],
      cross: [],
    };
  }

  const rankHtml = await fetchHtml(rankingUrl, { userAgent: cfg.userAgent });
  const scanRows = cfg.warRankingScanRows ?? 300;
  const { tribes } = parseTribeTopWithIds(rankHtml, matchHeaders, scanRows);
  const byTag = new Map(tribes.map((t) => [normTribeTagKey(t.name), t]));

  /** @type {Array<{ name: string, tribes: Array<{ tribeId: string, name: string, tag: string }> }>} */
  const resolvedSides = [];
  /** @type {string[]} */
  const missingTags = [];
  /** @type {Map<string, number>} */
  const tribeIdToSideIdx = new Map();

  for (let si = 0; si < sides.length; si++) {
    const side = sides[si];
    const sideTribes = [];
    for (const tag of side.tags || []) {
      let hit = byTag.get(normTribeTagKey(tag));
      if (!hit) {
        const found = findTribeInRankingByTag(rankHtml, matchHeaders, tag, scanRows);
        hit = found.tribe;
      }
      if (!hit) {
        missingTags.push(tag);
        continue;
      }
      sideTribes.push({ tribeId: hit.tribeId, name: hit.name, tag });
      tribeIdToSideIdx.set(String(hit.tribeId), si);
    }
    resolvedSides.push({ name: side.name || `Taraf${si + 1}`, tribes: sideTribes });
  }

  const twConfigured = cfg.twStatsDisplayedUtcOffsetMinutes;
  /** @type {number[]} */
  const sideGainTotals = resolvedSides.map(() => 0);
  /** @type {Map<string, number>} */
  const crossTotals = new Map();

  // Günlük / tarihli: dünya ennoblements (birkaç sayfa) — hızlı
  // Toplam: klan sayfaları paralel, kısa gecikme
  if (targetYmd) {
    const maxEnn = cfg.maxWarEnnoblementPages ?? 40;
    const delayMs = cfg.warRequestDelayMs ?? 120;
    for (let pn = 1; pn <= maxEnn; pn++) {
      const url = ennoblementsListUrl(rankingUrl, pn);
      let html;
      try {
        html = await fetchHtml(url, { userAgent: cfg.userAgent });
      } catch (e) {
        console.warn(`[war ennoblements] pn=${pn}: ${e instanceof Error ? e.message : e}`);
        break;
      }
      const { cross, sideGains, hitOlderDay, tableFound } = parseWarEnnoblementsPage(html, {
        tribeIdToSideIdx,
        targetYmd,
        timeZone: tz,
        twStatsDisplayedUtcOffsetMinutes: twConfigured,
      });
      if (!tableFound) break;
      for (const [si, n] of sideGains) sideGainTotals[si] = (sideGainTotals[si] || 0) + n;
      for (const [k, n] of cross) crossTotals.set(k, (crossTotals.get(k) || 0) + n);
      if (hitOlderDay) break;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  } else {
    const maxPages = cfg.maxWarConquerPages ?? 25;
    const delayMs = cfg.warRequestDelayMs ?? 80;
    const concurrency = cfg.warTribeConcurrency ?? 4;
    const jobs = [];
    for (let si = 0; si < resolvedSides.length; si++) {
      for (const tr of resolvedSides[si].tribes) {
        jobs.push({ si, tr });
      }
    }
    await mapPool(jobs, concurrency, async ({ si, tr }) => {
      for (let pn = 1; pn <= maxPages; pn++) {
        const url = tribeConquersListUrl(rankingUrl, tr.tribeId, pn);
        let html;
        try {
          html = await fetchHtml(url, { userAgent: cfg.userAgent });
        } catch (e) {
          console.warn(`[war] ${tr.name} pn=${pn}: ${e instanceof Error ? e.message : e}`);
          break;
        }
        const { cross, sideGains, tableFound, empty } = parseCrossSideGainsFromPage(html, {
          winnerTribeId: tr.tribeId,
          winnerSideIdx: si,
          tribeIdToSideIdx,
          targetYmd: null,
          timeZone: tz,
          twStatsDisplayedUtcOffsetMinutes: twConfigured,
        });
        if (!tableFound || empty) break;
        sideGainTotals[si] += sideGains;
        for (const [k, n] of cross) crossTotals.set(k, (crossTotals.get(k) || 0) + n);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    });
  }

  const sideGains = resolvedSides.map((s, i) => ({ name: s.name, total: sideGainTotals[i] }));
  const cross = [];
  for (let a = 0; a < resolvedSides.length; a++) {
    for (let b = 0; b < resolvedSides.length; b++) {
      if (a === b) continue;
      const n = crossTotals.get(`${a}->${b}`) || 0;
      cross.push({ from: resolvedSides[a].name, to: resolvedSides[b].name, count: n });
    }
  }

  return {
    error: null,
    warName: war.name || warCommandSlug(war),
    targetYmd,
    missingTags,
    sideGains,
    cross,
    method: targetYmd ? 'ennoblements' : 'tribe_pages',
  };
}

/**
 * @param {ReturnType<typeof computeWarStats> extends Promise<infer R> ? R : never} stats
 * @param {{ worldLabel?: string }} [extra]
 */
export function formatWarStatsHtml(stats, extra = {}) {
  if (stats.error) {
    return `<b>${escapeHtml(stats.warName || 'Savaş')}</b>\n${escapeHtml(stats.error)}`;
  }
  const titleDay = stats.targetYmd
    ? `Gün: ${stats.targetYmd} (hızlı tarama)`
    : 'Toplam skor (daha uzun sürebilir)';
  const lines = [];
  lines.push(`<b>${escapeHtml(stats.warName)}</b> — ${escapeHtml(extra.worldLabel || 'TW')}`);
  lines.push(`<i>${escapeHtml(titleDay)}</i>`);
  lines.push('');
  lines.push('<b>Taraflar arası</b>');
  const crossLines = (stats.cross || []).filter((c) => c.count > 0);
  if (crossLines.length) {
    for (const c of crossLines.sort((a, b) => b.count - a.count)) {
      lines.push(`${escapeHtml(c.from)} → ${escapeHtml(c.to)}: <b>${c.count}</b>`);
    }
  } else {
    lines.push('<i>Karşılıklı fetih yok.</i>');
  }
  lines.push('');
  lines.push('<b>Taraf toplam alım</b> <i>(tüm kaynaklardan)</i>');
  for (const s of stats.sideGains || []) {
    lines.push(`${escapeHtml(s.name)}: <b>${s.total}</b>`);
  }
  if (stats.missingTags?.length) {
    lines.push('');
    lines.push(`<i>Bulunamayan tag: ${escapeHtml(stats.missingTags.join(', '))}</i>`);
  }
  return lines.join('\n');
}

/**
 * Digest için bloklar (formatDigestHtml results dizisine).
 * @param {object} cfg
 * @param {{ conquerDayYmd?: string }} [digestOpts]
 */
export async function collectWarDigestBlocks(cfg, digestOpts = {}) {
  const wars = normalizeWars(cfg);
  if (!wars.length) return [];

  const tz = cfg.timezone || 'Europe/Istanbul';
  const day = digestOpts.conquerDayYmd || ymdInTimeZone(tz);
  const blocks = [];

  for (const war of wars) {
    const stats = await computeWarStats(cfg, war, { conquerDayYmd: day });
    if (stats.error) {
      blocks.push({ title: `Savaş — ${war.name}`, error: stats.error, lines: [] });
      continue;
    }
    const crossLines = (stats.cross || [])
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((c) => `${c.from} → ${c.to} — ${c.count}`);
    blocks.push({
      title: `Savaş — ${stats.warName} — taraflar arası (${day})`,
      lines: crossLines.length ? crossLines : ['Karşılıklı fetih yok.'],
      error: null,
    });
    blocks.push({
      title: `Savaş — ${stats.warName} — taraf toplam alım (${day})`,
      headers: ['Taraf', 'Alınan'],
      rows: (stats.sideGains || []).map((s) => [s.name, String(s.total)]),
      lines: (stats.sideGains || []).map((s) => `${s.name} — ${s.total}`),
      error: null,
    });
    if (stats.missingTags?.length) {
      blocks.push({
        title: `Savaş — ${stats.warName} — eksik tag`,
        lines: stats.missingTags,
        error: null,
      });
    }
  }
  return blocks;
}

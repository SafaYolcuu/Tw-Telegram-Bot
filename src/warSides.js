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

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Element} td
 * @returns {{ player: string | null, ally: string | null }}
 */
function parseOwnerCell($, td) {
  const player = normalizeCellText($(td).find('a.playerlink').first().text()) || null;
  const ally = normalizeCellText($(td).find('a.tribelink').first().text()) || null;
  if (player || ally) return { player, ally };
  const raw = normalizeCellText($(td).text());
  return { player: raw || null, ally: null };
}

/** Forum BBCode: [player]X[/player] [[ally]TAG[/ally]] */
function formatOwnerBb({ player, ally }) {
  const p = player ? `[player]${player}[/player]` : '—';
  const a = ally ? ` [[ally]${ally}[/ally]]` : '';
  return `${p}${a}`;
}

/**
 * TWStats village hücresi → koordinat + kıta (köy adı gerekmez; [coord] forumda ismi de gösterir).
 * @returns {{ coord: string | null, continent: string | null }}
 */
function parseVillageCellText(raw) {
  const text = normalizeCellText(raw);
  const cm = text.match(/(\d+)\s*\|\s*(\d+)/);
  const km = text.match(/\bK\s*(\d{1,2})\b/i);
  return {
    coord: cm ? `${cm[1]}|${cm[2]}` : null,
    continent: km ? `K${km[1]}` : null,
  };
}

/** ([coord]x|y[/coord]) K46 */
function formatVillageBb({ coord, continent }) {
  const c = coord ? `([coord]${coord}[/coord])` : '(—)';
  const k = continent ? ` ${continent}` : '';
  return `${c}${k}`;
}

/** `2026-10-26 - 13:57:22` → epoch ms (sıralama). */
function parseConquerWhenMs(when) {
  const m = String(when || '').match(
    /(\d{4})-(\d{2})-(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) return Number.NaN;
  const ms = Date.UTC(
    +m[1],
    +m[2] - 1,
    +m[3],
    +m[4],
    +m[5],
    m[6] != null ? +m[6] : 0
  );
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function compareConquerWhen(a, b) {
  const ma = parseConquerWhenMs(a);
  const mb = parseConquerWhenMs(b);
  if (Number.isFinite(ma) && Number.isFinite(mb) && ma !== mb) return ma - mb;
  return String(a || '').localeCompare(String(b || ''), 'tr');
}

/**
 * Aynı coord için yalnızca son fetih yönü skor yazar; kronoloji son kazananın altında.
 * @param {Map<string, Array<object>>} crossDetailTotals key `${fromIdx}->${toIdx}`
 * @param {Array<{ name: string }>} resolvedSides
 * @returns {{ cross: Array<{ from: string, to: string, count: number }>, crossDetails: Array<{ from: string, to: string, count: number, villages: Array<object> }> }}
 */
function applyLastOwnerCrossRule(crossDetailTotals, resolvedSides) {
  /** @type {Array<object>} */
  const flat = [];
  for (const [key, rows] of crossDetailTotals) {
    const [aStr, bStr] = String(key).split('->');
    const fromIdx = parseInt(aStr, 10);
    const toIdx = parseInt(bStr, 10);
    if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) continue;
    const from = resolvedSides[fromIdx]?.name;
    const to = resolvedSides[toIdx]?.name;
    if (!from || !to) continue;
    for (const row of rows || []) {
      flat.push({ ...row, fromIdx, toIdx, from, to });
    }
  }

  /** @type {Map<string, typeof flat>} */
  const byVillage = new Map();
  let anon = 0;
  for (const ev of flat) {
    const ck = ev.coord ? `c:${ev.coord}` : `anon:${anon++}:${ev.when}:${ev.newPlayer || ''}`;
    const arr = byVillage.get(ck) || [];
    arr.push(ev);
    byVillage.set(ck, arr);
  }

  /** @type {Map<string, { from: string, to: string, fromIdx: number, toIdx: number, villages: Array<object> }>} */
  const buckets = new Map();

  for (const [, events] of byVillage) {
    events.sort((x, y) => compareConquerWhen(x.when, y.when));
    const last = events[events.length - 1];
    if (!last) continue;
    const dirKey = `${last.fromIdx}->${last.toIdx}`;
    let bucket = buckets.get(dirKey);
    if (!bucket) {
      bucket = {
        from: last.from,
        to: last.to,
        fromIdx: last.fromIdx,
        toIdx: last.toIdx,
        villages: [],
      };
      buckets.set(dirKey, bucket);
    }
    bucket.villages.push({
      coord: last.coord ?? events.find((e) => e.coord)?.coord ?? null,
      continent: last.continent ?? events.find((e) => e.continent)?.continent ?? null,
      lastWhen: last.when,
      events: events.map((e) => ({
        when: e.when,
        oldPlayer: e.oldPlayer,
        oldAlly: e.oldAlly,
        newPlayer: e.newPlayer,
        newAlly: e.newAlly,
        from: e.from,
        to: e.to,
      })),
    });
  }

  for (const bucket of buckets.values()) {
    bucket.villages.sort((a, b) => -compareConquerWhen(a.lastWhen, b.lastWhen));
  }

  const cross = [];
  const crossDetails = [];
  for (let a = 0; a < resolvedSides.length; a++) {
    for (let b = 0; b < resolvedSides.length; b++) {
      if (a === b) continue;
      const dirKey = `${a}->${b}`;
      const bucket = buckets.get(dirKey);
      const villages = bucket?.villages || [];
      const count = villages.length;
      cross.push({
        from: resolvedSides[a].name,
        to: resolvedSides[b].name,
        count,
      });
      if (count > 0) {
        crossDetails.push({
          from: resolvedSides[a].name,
          to: resolvedSides[b].name,
          count,
          villages,
        });
      }
    }
  }
  return { cross, crossDetails };
}

/**
 * @param {Map<string, Array<object>>} map
 * @param {string} key
 * @param {object} row
 */
function pushCrossDetail(map, key, row) {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(row);
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
  /** @type {Map<string, Array<{ coord: string | null, continent: string | null, when: string, oldPlayer: string | null, oldAlly: string | null, newPlayer: string | null, newAlly: string | null }>>} */
  const crossDetails = new Map();
  /** @type {Map<number, number>} */
  const sideGains = new Map();
  if (!$table?.length) {
    return { cross, crossDetails, sideGains, hitOlderDay: true, tableFound: false };
  }

  const ths = tableHeaderTexts($, $table);
  const villageIdx = ths.findIndex((t) => /^village$/i.test(t));
  const dateIdx = ths.findIndex((t) => /date/i.test(t) && /time/i.test(t));
  const oldIdx = ths.findIndex((t) => /^old owner$/i.test(t));
  const newIdx = ths.findIndex((t) => /^new owner$/i.test(t));
  if (dateIdx < 0 || oldIdx < 0 || newIdx < 0) {
    return { cross, crossDetails, sideGains, hitOlderDay: true, tableFound: true };
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
    const village =
      villageIdx >= 0 && tds[villageIdx]
        ? normalizeCellText($(tds[villageIdx]).text())
        : '—';
    const oldO = parseOwnerCell($, tds[oldIdx]);
    const newO = parseOwnerCell($, tds[newIdx]);
    const vInfo = parseVillageCellText(village);
    pushCrossDetail(crossDetails, key, {
      coord: vInfo.coord,
      continent: vInfo.continent,
      when: dateRaw,
      oldPlayer: oldO.player,
      oldAlly: oldO.ally,
      newPlayer: newO.player,
      newAlly: newO.ally,
    });
  }
  return { cross, crossDetails, sideGains, hitOlderDay, tableFound: true };
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
  /** @type {Map<string, Array<{ coord: string | null, continent: string | null, when: string, oldPlayer: string | null, oldAlly: string | null, newPlayer: string | null, newAlly: string | null }>>} */
  const crossDetails = new Map();
  let sideGains = 0;
  if (!$table?.length) {
    return { cross, crossDetails, sideGains, hitOlderDay: true, tableFound: false, empty: true };
  }

  const ths = tableHeaderTexts($, $table);
  const villageIdx = ths.findIndex((t) => /^village$/i.test(t));
  const dateIdx = ths.findIndex((t) => /date/i.test(t) && /time/i.test(t));
  const oldIdx = ths.findIndex((t) => /^old owner$/i.test(t));
  const newIdx = ths.findIndex((t) => /^new owner$/i.test(t));
  if (dateIdx < 0 || oldIdx < 0 || newIdx < 0) {
    return { cross, crossDetails, sideGains, hitOlderDay: true, tableFound: true, empty: true };
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
    const village =
      villageIdx >= 0 && tds[villageIdx]
        ? normalizeCellText($(tds[villageIdx]).text())
        : '—';
    const oldO = parseOwnerCell($, tds[oldIdx]);
    const newO = parseOwnerCell($, tds[newIdx]);
    const vInfo = parseVillageCellText(village);
    pushCrossDetail(crossDetails, key, {
      coord: vInfo.coord,
      continent: vInfo.continent,
      when: dateRaw,
      oldPlayer: oldO.player,
      oldAlly: oldO.ally,
      newPlayer: newO.player,
      newAlly: newO.ally,
    });
  }

  return { cross, crossDetails, sideGains, hitOlderDay, tableFound: true, empty: dataRows <= 0 };
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
  /** @type {Map<string, Array<{ coord: string | null, continent: string | null, when: string, oldPlayer: string | null, oldAlly: string | null, newPlayer: string | null, newAlly: string | null }>>} */
  const crossDetailTotals = new Map();

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
      const { crossDetails, sideGains, hitOlderDay, tableFound } = parseWarEnnoblementsPage(html, {
        tribeIdToSideIdx,
        targetYmd,
        timeZone: tz,
        twStatsDisplayedUtcOffsetMinutes: twConfigured,
      });
      if (!tableFound) break;
      for (const [si, n] of sideGains) sideGainTotals[si] = (sideGainTotals[si] || 0) + n;
      for (const [k, rows] of crossDetails) {
        const arr = crossDetailTotals.get(k) || [];
        arr.push(...rows);
        crossDetailTotals.set(k, arr);
      }
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
        const { crossDetails, sideGains, tableFound, empty } = parseCrossSideGainsFromPage(html, {
          winnerTribeId: tr.tribeId,
          winnerSideIdx: si,
          tribeIdToSideIdx,
          targetYmd: null,
          timeZone: tz,
          twStatsDisplayedUtcOffsetMinutes: twConfigured,
        });
        if (!tableFound || empty) break;
        sideGainTotals[si] += sideGains;
        for (const [k, rows] of crossDetails) {
          const arr = crossDetailTotals.get(k) || [];
          arr.push(...rows);
          crossDetailTotals.set(k, arr);
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    });
  }

  const sideGains = resolvedSides.map((s, i) => ({ name: s.name, total: sideGainTotals[i] }));
  const { cross, crossDetails: crossWithDetails } = applyLastOwnerCrossRule(
    crossDetailTotals,
    resolvedSides
  );

  return {
    error: null,
    warName: war.name || warCommandSlug(war),
    targetYmd,
    missingTags,
    sideGains,
    cross,
    crossDetails: crossWithDetails,
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
  if (stats.missingTags?.length) {
    lines.push('');
    lines.push(`<i>Bulunamayan tag: ${escapeHtml(stats.missingTags.join(', '))}</i>`);
  }
  if ((stats.crossDetails || []).some((c) => (c.villages || []).length)) {
    lines.push('');
    lines.push('<i>Taraflar arası köy listesi ayrı .txt dosyasında.</i>');
  }
  return lines.join('\n');
}

/** Aynı gün ise sadece saat; değilse tam zaman. */
function formatWhenShort(when, targetYmd) {
  const raw = String(when || '').trim();
  if (targetYmd && raw.startsWith(targetYmd)) {
    const m = raw.match(/\d{1,2}:\d{2}(?::\d{2})?/);
    if (m) return m[0];
  }
  return raw || '—';
}

/**
 * Taraflar arası fetih köyleri — oyun not defteri için [table] BBCode.
 * @param {object} stats
 * @param {{ worldLabel?: string }} [extra]
 * @returns {string | null}
 */
export function formatWarCrossDetailsTxt(stats, extra = {}) {
  if (stats.error) return null;
  const blocks = (stats.crossDetails || []).filter((c) => (c.villages || []).length);
  if (!blocks.length) return null;

  const title = `${stats.warName || 'Savaş'} — ${extra.worldLabel || 'TW'}`;
  const dayLine = stats.targetYmd ? `Gün: ${stats.targetYmd}` : 'Toplam skor';
  const lines = [
    `[b][color=#0000ff]${title}`,
    `${dayLine}[/color][/b]`,
    '',
  ];

  for (const c of blocks.sort((a, b) => b.count - a.count)) {
    lines.push(`[b][color=#ff0000]${c.from} → ${c.to}: ${c.count}[/color][/b]`);
    lines.push('[table]');
    // Not defterinde [br] yok → her fetih ayrı satır; aynı köyde devam satırları boş #/Köy/K
    // Dar sütunlar (#, K, el değiştirme): kısa ayırıcı — ----- sığmıyor, tablo bozuluyor
    lines.push('[**]#[||]Köy[||]K[||]el değiştirme[||]Saat[||]Kimden[||]Kime[/**]');
    let rowNum = 0;
    const villages = c.villages;
    for (let vi = 0; vi < villages.length; vi++) {
      const v = villages[vi];
      rowNum += 1;
      const events = Array.isArray(v.events) && v.events.length ? v.events : [v];
      const coordCell = v.coord ? `[coord]${v.coord}[/coord]` : '—';
      const kCell = v.continent || '—';
      events.forEach((ev, i) => {
        const t = `[color=#ff0000]${formatWhenShort(ev.when, stats.targetYmd)}[/color]`;
        const oldBb = formatOwnerBb({ player: ev.oldPlayer, ally: ev.oldAlly });
        const newBb = formatOwnerBb({ player: ev.newPlayer, ally: ev.newAlly });
        if (i === 0) {
          lines.push(
            `[*]${rowNum}[|]${coordCell}[|]${kCell}[|]${events.length}[|]${t}[|]${oldBb}[|]${newBb}`
          );
        } else {
          lines.push(`[*][|][|][|][|]${t}[|]${oldBb}[|]${newBb}`);
        }
      });
      if (vi < villages.length - 1) {
        lines.push('[*]-[|]-----[|]-[|]-[|]-----[|]-----[|]-----');
      }
    }
    lines.push('[/table]');
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
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

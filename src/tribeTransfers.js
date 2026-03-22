import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { fetchHtml, parseTribeTopWithIds } from './scrape.js';
import { escapeHtml } from './formatMessage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.join(__dirname, '..', 'tribe-transfer-snapshot.json');

function normalizeCellText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function tribeMembersListUrl(rankingUrl, tribeId) {
  const u = new URL(rankingUrl);
  const q = new URLSearchParams();
  q.set('page', 'tribe');
  q.set('mode', 'members');
  q.set('id', String(tribeId));
  return `${u.origin}${u.pathname}?${q.toString()}`;
}

/**
 * @returns {Array<{ playerId: string, name: string }>}
 */
function parseTribeMembersTable(html) {
  const $ = cheerio.load(html);
  const $table = $('table.widget#members').first();
  if (!$table.length) return [];
  const out = [];
  const trs = $table.find('tr').toArray();
  for (let i = 1; i < trs.length; i++) {
    const tr = trs[i];
    if ($(tr).find('td.foot').length) continue;
    const $tr = $(tr);
    const $a = $tr.find('td').eq(1).find('a.playerlink').first();
    if (!$a.length) continue;
    const href = $a.attr('href') || '';
    const m = href.match(/id=(\d+)/);
    const playerId = m ? m[1] : '';
    if (!playerId) continue;
    const name = normalizeCellText($a.text()).replace(/\*/g, '\u2217');
    out.push({ playerId, name });
  }
  return out;
}

function loadSnapshot() {
  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const j = JSON.parse(raw);
    return j.players && typeof j.players === 'object' ? j.players : {};
  } catch {
    return {};
  }
}

export function persistTribeTransferSnapshot(players) {
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({ players, updatedAt: new Date().toISOString() }, null, 0),
    'utf8'
  );
}

/**
 * İlk N klanın üye listelerini tarar; önceki kayıtla karşılaştırır (dosyaya yazmaz).
 * Sıralamada ilk N dışına düşen klanın üyeleri artık taranmadığı için "klandan ayrıldı" uyarısı üretilmez (yanlış pozitif önlenir).
 * @returns {{ alerts: string[], nextSnapshot: Record<string, { name: string, tribeId: string, tribeTag: string }> }}
 */
export async function computeTribeTransfers(cfg, options = {}) {
  const tribeSrc = cfg.sources?.find((s) => s.type === 'tribe_top_villages_and_today_conquers');
  if (!tribeSrc || tribeSrc.trackTribeTransfers === false) {
    return { alerts: [], nextSnapshot: null };
  }

  const rankingUrl = tribeSrc.rankingUrl || tribeSrc.url;
  if (!rankingUrl) return { alerts: [], nextSnapshot: null };

  const maxRows = tribeSrc.maxRows ?? 10;
  const matchHeaders = tribeSrc.matchHeaders || [
    'Rank',
    'Tag',
    'Points of best 40',
    'Total Points',
    'Members',
    'Average points per member',
    'Villages',
    'Average points per village',
  ];
  const { userAgent } = options;
  const delayMs = options.delayMs ?? 0;

  const rankHtml = await fetchHtml(rankingUrl, { userAgent });
  const { error, tribes } = parseTribeTopWithIds(rankHtml, matchHeaders, maxRows);
  if (error || !tribes.length) return { alerts: [], nextSnapshot: null };

  /** @type {Record<string, { name: string, tribeId: string, tribeTag: string }>} */
  const current = {};
  for (const t of tribes) {
    const url = tribeMembersListUrl(rankingUrl, t.tribeId);
    const html = await fetchHtml(url, { userAgent });
    const members = parseTribeMembersTable(html);
    for (const m of members) {
      current[m.playerId] = {
        name: m.name,
        tribeId: t.tribeId,
        tribeTag: t.name,
      };
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  /** Bu turda üye listesi çekilen klan id'leri (sıralamada ilk N). */
  const topTribeIds = new Set(tribes.map((t) => String(t.tribeId)));

  const previous = loadSnapshot();
  const alerts = [];

  for (const pid of Object.keys(previous)) {
    const prev = previous[pid];
    const cur = current[pid];
    if (!cur) {
      const prevTribeStillInTopN = topTribeIds.has(String(prev.tribeId));
      if (!prevTribeStillInTopN) {
        // Klan sıralamadan ilk N'nin dışına düştü; üyeleri artık taranmıyor — "hepsi ayrıldı" sayma.
        continue;
      }
      alerts.push(
        `${prev.name}: ${prev.tribeTag} klanından ayrıldı; şu an ilk ${maxRows} klanın üye listesinde yok.`
      );
    } else if (cur.tribeId !== prev.tribeId) {
      alerts.push(`${cur.name}: ${prev.tribeTag} klanından ayrılıp ${cur.tribeTag} klanına geçti.`);
    }
  }

  return { alerts, nextSnapshot: current };
}

/**
 * @param {string[]} alertLines
 */
export function formatTransferAlertsHtml(alertLines, worldLabel) {
  if (!alertLines.length) return '';
  const w = escapeHtml(worldLabel || 'TW');
  const head = `<b>${escapeHtml('Klan değişikliği')} — ${w}</b>`;
  const body = alertLines.map((l) => `• ${escapeHtml(l)}`).join('\n');
  return `${head}\n${body}`;
}

/**
 * Barbar Köy Monitörü
 * -------------------
 * Periyodik olarak yeni barbar köyleri tespit eder ve Telegram'a bildirir.
 *
 * Varsayılan kaynak (watchContinents doluyken): canlı TWMap
 *   GET /map.php?v=2&locale=tr_TR&e=…&{x}_{y}=0
 * Fallback / tüm harita: village.txt.gz (saatlik dump, gecikmeli).
 *
 * Konfigürasyon (config.json içinde):
 *   barbarMonitor: {
 *     enabled: true,
 *     server: "tr104.klanlar.org",
 *     dataSource: "map",          // "map" | "village_txt"
 *     intervalMinutes: 5,
 *     watchContinents: ["55"],   // boş → village.txt (tüm harita)
 *     minPoints: 0,
 *     maxPoints: 500
 *   }
 */

import axios from 'axios';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gunzip = promisify(zlib.gunzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'barbar-state.json');

const SECTOR_SIZE = 20;
const MAP_BATCH_SIZE = 25;

// ── Yardımcılar ────────────────────────────────────────────────────────────

/** TW map puanı: "495" veya "5.666" (binlik nokta) → number */
function parseMapPoints(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\./g, '');
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Kıta kodu → [x0, y0] (kıta sol-üst köşesi).
 * cont = `${Math.floor(y/100)}${Math.floor(x/100)}` (örn. "55" → x 500–599, y 500–599)
 * @param {string} cont
 * @returns {[number, number]|null}
 */
function continentOrigin(cont) {
  const s = String(cont).trim();
  if (!/^\d{2}$/.test(s)) return null;
  const yDigit = parseInt(s[0], 10);
  const xDigit = parseInt(s[1], 10);
  return [xDigit * 100, yDigit * 100];
}

/**
 * İzlenen kıtalar için 20×20 sektör id listesi (`"540_540"`).
 * @param {string[]} continents
 * @returns {string[]}
 */
function sectorIdsForContinents(continents) {
  const ids = [];
  const seen = new Set();
  for (const cont of continents) {
    const origin = continentOrigin(cont);
    if (!origin) continue;
    const [x0, y0] = origin;
    for (let y = y0; y < y0 + 100; y += SECTOR_SIZE) {
      for (let x = x0; x < x0 + 100; x += SECTOR_SIZE) {
        const id = `${x}_${y}`;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

// ── Köy verisi parse ───────────────────────────────────────────────────────

/**
 * village.txt.gz içeriğini parse eder.
 * Sadece barbar (player_id === 0) köyleri döner.
 * Format: id,name,x,y,player_id,points[,rank]
 * @param {string} text
 * @returns {Map<number, {id,coord,name,pts,cont}>}
 */
function parseBarbarVillages(text) {
  const villages = new Map();
  for (const line of text.trim().split('\n')) {
    const p = line.split(',');
    if (p.length < 6) continue;
    const id  = parseInt(p[0], 10);
    const x   = parseInt(p[2], 10);
    const y   = parseInt(p[3], 10);
    const pid = parseInt(p[4], 10); // player_id — index 4
    const pts = parseInt(p[5], 10) || 0; // points — index 5
    if (isNaN(id) || isNaN(x) || isNaN(y) || isNaN(pid)) continue;
    if (pid !== 0) continue; // yalnızca barbar köyler

    let name = p[1];
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* ham ad */ }

    const cont = `${Math.floor(y / 100)}${Math.floor(x / 100)}`;
    villages.set(id, { id, coord: `${x}|${y}`, name, pts, cont });
  }
  return villages;
}

/**
 * /map.php sektör JSON'undan barbar köyleri çıkarır.
 * Village array: [id, img, name, points, ownerId, …] — owner "0" = barbar.
 * @param {object[]} sectors
 * @returns {Map<number, {id,coord,name,pts,cont}>}
 */
function parseBarbarFromSectors(sectors) {
  const villages = new Map();
  for (const sec of sectors) {
    const sx = Number(sec?.x);
    const sy = Number(sec?.y);
    const rows = sec?.data?.villages;
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Array.isArray(rows)) continue;

    for (let yi = 0; yi < rows.length; yi++) {
      const row = rows[yi];
      if (!row || Array.isArray(row) || typeof row !== 'object') continue;
      for (const [xiStr, v] of Object.entries(row)) {
        if (!Array.isArray(v) || v.length < 5) continue;
        if (String(v[4]) !== '0') continue; // owner

        const id = parseInt(v[0], 10);
        const x = sx + parseInt(xiStr, 10);
        const y = sy + yi;
        if (!Number.isFinite(id) || !Number.isFinite(x) || !Number.isFinite(y)) continue;

        let name = v[2];
        if (name === 0 || name === '0' || name == null) name = 'Barbar köyü';
        else name = String(name);

        const pts = parseMapPoints(v[3]);
        const cont = `${Math.floor(y / 100)}${Math.floor(x / 100)}`;
        villages.set(id, { id, coord: `${x}|${y}`, name, pts, cont });
      }
    }
  }
  return villages;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/**
 * Sunucudan village.txt.gz'yi indirir, sıkıştırmayı açar ve parse eder.
 * @returns {Promise<Map<number, object>>}
 */
export async function fetchBarbarVillages(server, userAgent) {
  const url = `https://${server}/map/village.txt.gz`;
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    headers: { 'User-Agent': userAgent || 'Mozilla/5.0' },
  });
  const buf = await gunzip(Buffer.from(resp.data));
  return parseBarbarVillages(buf.toString('utf-8'));
}

/**
 * Canlı TWMap sektör verisi (/map.php?v=2) — watchContinents için.
 * @param {string} server
 * @param {string[]} continents
 * @param {string} [userAgent]
 * @returns {Promise<Map<number, object>>}
 */
export async function fetchBarbarVillagesFromMap(server, continents, userAgent) {
  const host = String(server || '').replace(/^https?:\/\//, '');
  const sectorIds = sectorIdsForContinents(continents);
  if (!sectorIds.length) {
    throw new Error('map kaynağı için geçerli watchContinents gerekli (örn. ["55","65"])');
  }

  const headers = { 'User-Agent': userAgent || 'Mozilla/5.0' };
  const e = Date.now();
  const allSectors = [];

  for (let i = 0; i < sectorIds.length; i += MAP_BATCH_SIZE) {
    const batch = sectorIds.slice(i, i + MAP_BATCH_SIZE);
    const qs = batch.map((id) => `${id}=0`).join('&');
    const url = `https://${host}/map.php?v=2&locale=tr_TR&e=${e}&${qs}`;
    const resp = await axios.get(url, {
      timeout: 30_000,
      headers,
      responseType: 'json',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const data = resp.data;
    if (!Array.isArray(data)) {
      throw new Error(`map.php beklenen dizi dönmedi (batch ${i / MAP_BATCH_SIZE + 1})`);
    }
    allSectors.push(...data);
  }

  return parseBarbarFromSectors(allSectors);
}

/**
 * dataSource'a göre barbar köylerini çeker.
 * map başarısız olursa village.txt.gz'ye düşer.
 * @returns {Promise<{ villages: Map<number, object>, source: string }>}
 */
async function loadBarbarVillages(bCfg, userAgent) {
  const server = bCfg.server ?? 'tr104.klanlar.org';
  const watchContinents = bCfg.watchContinents ?? [];
  const wantMap =
    (bCfg.dataSource ?? (watchContinents.length ? 'map' : 'village_txt')) === 'map';

  if (wantMap && watchContinents.length) {
    try {
      const t0 = Date.now();
      const villages = await fetchBarbarVillagesFromMap(server, watchContinents, userAgent);
      console.log(
        `[barbar] kaynak=map sektörler=${sectorIdsForContinents(watchContinents).length} ` +
          `barbar=${villages.size} ${Date.now() - t0}ms`
      );
      return { villages, source: 'map' };
    } catch (e) {
      console.error(`[barbar] map kaynağı başarısız, village.txt.gz: ${e.message}`);
    }
  }

  const t0 = Date.now();
  const villages = await fetchBarbarVillages(server, userAgent);
  console.log(`[barbar] kaynak=village_txt barbar=${villages.size} ${Date.now() - t0}ms`);
  return { villages, source: 'village_txt' };
}

// ── State yönetimi ─────────────────────────────────────────────────────────
//
// State koordinat bazlı ve kümülatif saklanır.
// Bir koordinat bir kez barbar olarak görüldükten sonra sonsuza kadar
// "bilinen" sayılır — köy el değiştirip tekrar barbarlaşsa bildirim gelmez.
//
// Dosya formatı: { "seenCoords": ["629|604", ...] }

/** Daha önce barbar olarak görülmüş koordinatları yükler. null → ilk çalıştırma. */
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    // Eski format (dizi of number ID'ler) varsa geç: ilk çalıştırma gibi davran
    if (!raw?.seenCoords) return null;
    return new Set(raw.seenCoords);
  } catch {
    return null;
  }
}

/**
 * Görülmüş koordinatlar kümesini diske kaydeder.
 * @param {Set<string>} seenCoords
 */
function saveState(seenCoords) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ seenCoords: [...seenCoords] }),
    'utf-8'
  );
}

// ── Mesaj formatlama ───────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** world host -> tribalwarsmap link */
function mapLinkForCoord(server, coord) {
  const host = String(server || '').replace(/^https?:\/\//, '');
  const world = host.split('.')[0] || 'tr';
  return `https://${world}.tribalwarsmap.com/tr/#${coord}`;
}

function buildMessage(newBarbs, worldLabel, server) {
  const contList = [...new Set(newBarbs.map((v) => `K${v.cont}`))].sort().join(', ');
  const header =
    `⚔ <b>${newBarbs.length} yeni barbar köy</b> — ${escHtml(worldLabel)}\n` +
    `<i>${contList}</i>\n\n`;

  const rows = [...newBarbs]
    .sort((a, b) => a.pts - b.pts)
    .map((v) => {
      const mapUrl = mapLinkForCoord(server, v.coord);
      return (
        `📍 <code>${v.coord}</code> — <b>${v.pts} puan</b> — K${v.cont}\n` +
        `   <a href="${mapUrl}">${escHtml(v.name)}</a>`
      );
    })
    .join('\n');

  return header + rows;
}

// ── Ana tarama fonksiyonu ──────────────────────────────────────────────────

/**
 * Tek bir tarama döngüsü. Yeni barbar köyler varsa `sendFn` ile bildirir.
 * @param {{ cfg: object, sendFn: (text: string) => Promise<void> }} opts
 */
export async function runBarbarScan({ cfg, sendFn }) {
  const bCfg = cfg.barbarMonitor;
  if (!bCfg?.enabled) return;

  const server          = bCfg.server          ?? 'tr104.klanlar.org';
  const watchContinents = bCfg.watchContinents  ?? [];
  const minPts          = bCfg.minPoints        ?? 0;
  const maxPts          = bCfg.maxPoints        ?? 500;
  const worldLabel      = cfg.worldLabel        ?? 'TW';

  let current;
  let source;
  try {
    ({ villages: current, source } = await loadBarbarVillages(bCfg, cfg.userAgent));
  } catch (e) {
    console.error(`[barbar ${new Date().toISOString()}] Köy verisi alınamadı: ${e.message}`);
    return;
  }

  // seenCoords: daha önce barbar olarak GÖRÜLMÜŞ koordinatlar kümesi (kümülatif)
  const seenCoords = loadState();

  if (seenCoords === null) {
    // İlk çalıştırma: mevcut barbarları "bilinen" olarak kaydet, bildirim gönderme
    const initial = new Set([...current.values()].map((v) => v.coord));
    saveState(initial);
    console.log(`[barbar] İlk çalıştırma: ${initial.size} barbar koordinat kaydedildi, bildirim gönderilmedi.`);
    return;
  }

  // Koordinatı daha önce hiç görülmemiş olan barbarları bul
  const newBarbs = [];
  for (const village of current.values()) {
    if (seenCoords.has(village.coord)) continue;           // zaten bilinen koordinat
    if (watchContinents.length && !watchContinents.includes(village.cont)) continue;
    if (village.pts < minPts || village.pts > maxPts) continue;
    newBarbs.push(village);
    seenCoords.add(village.coord);  // kümülatif kümeye ekle
  }

  const ts = new Date().toISOString();
  console.log(
    `[barbar ${ts}] kaynak=${source} Toplam barbar: ${current.size} | Yeni koordinat (filtreli): ${newBarbs.length}`
  );

  if (newBarbs.length > 0) {
    const msg = buildMessage(newBarbs, worldLabel, server);
    try {
      await sendFn(msg);
      console.log(`[barbar] ${newBarbs.length} yeni barbar bildirimi gönderildi.`);
    } catch (e) {
      console.error(`[barbar] Telegram gönderilemedi: ${e.message}`);
    }
  }

  // Güncel "görülmüş koordinatlar" kümesini kaydet
  saveState(seenCoords);
}

// ── Durum özeti (komut için) ───────────────────────────────────────────────

/**
 * /barbar komutu için mevcut durumu özetler.
 * @param {object} cfg
 * @returns {Promise<string>} HTML mesajı
 */
export async function getBarbarStatus(cfg) {
  const bCfg = cfg.barbarMonitor;
  if (!bCfg?.enabled) return '<i>Barbar monitörü kapalı.</i>';

  const server          = bCfg.server          ?? 'tr104.klanlar.org';
  const watchContinents = bCfg.watchContinents  ?? [];
  const minPts          = bCfg.minPoints        ?? 0;
  const maxPts          = bCfg.maxPoints        ?? 500;
  const configuredSource =
    bCfg.dataSource ?? (watchContinents.length ? 'map' : 'village_txt');

  let current;
  let source;
  try {
    ({ villages: current, source } = await loadBarbarVillages(bCfg, cfg.userAgent));
  } catch (e) {
    return `<i>Köy verisi alınamadı: ${escHtml(e.message)}</i>`;
  }

  const seenCoords = loadState();
  const tracked = [...current.values()].filter((v) => {
    if (watchContinents.length && !watchContinents.includes(v.cont)) return false;
    if (v.pts < minPts || v.pts > maxPts) return false;
    return true;
  });

  const contLabel = watchContinents.length
    ? watchContinents.map((c) => `K${c}`).join(', ')
    : 'Tümü';

  return (
    `⚔ <b>Barbar Monitörü</b> — aktif\n\n` +
    `🗺 Sunucu: <code>${escHtml(server)}</code>\n` +
    `📡 Kaynak: <code>${escHtml(source)}</code>` +
      (source !== configuredSource ? ` <i>(yapılandırma: ${escHtml(configuredSource)})</i>` : '') +
      `\n` +
    `📍 Kıtalar: ${escHtml(contLabel)}\n` +
    `📊 Puan aralığı: ${minPts}–${maxPts}\n` +
    `🔢 Takip edilen barbar: <b>${tracked.length}</b>\n` +
    `💾 Bilinen koordinat: <b>${seenCoords === null ? 'henüz kaydedilmedi' : `${seenCoords.size} koordinat`}</b>`
  );
}

/**
 * Barbar Köy Monitörü
 * -------------------
 * village.txt.gz'yi periyodik olarak indirir,
 * yeni oluşan barbar köyleri tespit eder ve Telegram'a bildirir.
 *
 * Konfigürasyon (config.json içinde):
 *   barbarMonitor: {
 *     enabled: true,
 *     server: "tr101.klanlar.org",
 *     intervalMinutes: 5,
 *     watchContinents: ["55"],   // boş → tüm harita
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

function buildMessage(newBarbs, worldLabel, server) {
  const host = server.replace(/^https?:\/\//, '');
  const contList = [...new Set(newBarbs.map((v) => `K${v.cont}`))].sort().join(', ');
  const header =
    `⚔ <b>${newBarbs.length} yeni barbar köy</b> — ${escHtml(worldLabel)}\n` +
    `<i>${contList}</i>\n\n`;

  const rows = [...newBarbs]
    .sort((a, b) => a.pts - b.pts)
    .map((v) => {
      const mapUrl = `https://${host.replace('klanlar.org', 'tribalwarsmap.com/tr')}#${v.coord}`;
      return (
        `📍 <code>${v.coord}</code> — <b>${v.pts} puan</b> — K${v.cont}\n` +
        `   <a href="https://tr101.tribalwarsmap.com/tr/#${v.coord}">${escHtml(v.name)}</a>`
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

  const server          = bCfg.server          ?? 'tr101.klanlar.org';
  const watchContinents = bCfg.watchContinents  ?? [];
  const minPts          = bCfg.minPoints        ?? 0;
  const maxPts          = bCfg.maxPoints        ?? 500;
  const worldLabel      = cfg.worldLabel        ?? 'TW';

  let current;
  try {
    current = await fetchBarbarVillages(server, cfg.userAgent);
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
  console.log(`[barbar ${ts}] Toplam barbar: ${current.size} | Yeni koordinat (filtreli): ${newBarbs.length}`);

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

  const server          = bCfg.server          ?? 'tr101.klanlar.org';
  const watchContinents = bCfg.watchContinents  ?? [];
  const minPts          = bCfg.minPoints        ?? 0;
  const maxPts          = bCfg.maxPoints        ?? 500;

  let current;
  try {
    current = await fetchBarbarVillages(server, cfg.userAgent);
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
    `📍 Kıtalar: ${escHtml(contLabel)}\n` +
    `📊 Puan aralığı: ${minPts}–${maxPts}\n` +
    `🔢 Takip edilen barbar: <b>${tracked.length}</b>\n` +
    `💾 Bilinen koordinat: <b>${seenCoords === null ? 'henüz kaydedilmedi' : `${seenCoords.size} koordinat`}</b>`
  );
}

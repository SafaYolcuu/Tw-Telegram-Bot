import 'dotenv/config';
import axios from 'axios';
import { loadJsonConfig } from './src/loadConfig.js';
import {
  collectSources,
  conquerYmdFromDdMm,
  countTakesFromVictimAmongTopTribes,
  fetchHtml,
  findTribeInRankingByTag,
  ymdInTimeZone,
  ymdYesterdayInTimeZone,
} from './src/scrape.js';
import { escapeHtml, formatDigest, formatDigestHtml } from './src/formatMessage.js';
import { scheduleDigestJobs, scheduleHourlyOnTheHour, scheduleEveryNMinutes } from './src/scheduler.js';
import { alreadySentToday, markSentToday } from './src/dedupe.js';
import { sendViaTelegram, sendViaTelegramDocument, setTelegramBotCommands } from './src/sendTelegram.js';
import { startTelegramPolling } from './src/telegramPoll.js';
import { computeTribeTransfers, persistTribeTransferSnapshot, formatTransferAlertsHtml } from './src/tribeTransfers.js';
import { agentLog } from './src/debugAgentLog.js';
import { runBarbarScan, getBarbarStatus } from './src/barbarMonitor.js';
import {
  countPlayerConquersLastNDays,
  formatPlayerConquersSummaryHtml,
  resolveTelegramKeyToIngame,
  searchPlayerByName,
  worldIndexBaseFromRankingUrl,
} from './src/playerConquers.js';
import {
  computeWarStats,
  conquerYmdFromDdMmYyyy,
  formatWarCrossDetailsTxt,
  formatWarStatsHtml,
  normalizeWars,
  warCommandSlug,
} from './src/warSides.js';

const argv = process.argv.slice(2);

async function collectAndFormat(markdown) {
  const cfg = loadJsonConfig();
  const results = await collectSources(cfg.sources, {
    userAgent: cfg.userAgent,
    delayMs: cfg.requestDelayMs ?? 0,
    timezone: cfg.timezone,
    twStatsDisplayedUtcOffsetMinutes: cfg.twStatsDisplayedUtcOffsetMinutes,
  });
  const worldLabel = cfg.worldLabel || 'TW';
  const tz = cfg.timezone || 'Europe/Istanbul';
  return markdown
    ? formatDigest({ worldLabel, results })
    : formatDigestHtml({ worldLabel, results, timezone: tz });
}

async function runDryRun() {
  const cfg = loadJsonConfig();
  const text = await collectAndFormat(true);
  console.log(text);
  const { alerts } = await computeTribeTransfers(cfg, {
    userAgent: cfg.userAgent,
    delayMs: cfg.requestDelayMs ?? 0,
  });
  if (alerts.length) {
    console.log('\n--- Klan değişikliği bildirimleri (bu çalıştırmada dosya güncellenmedi) ---');
    console.log(alerts.join('\n'));
  }
}

async function runTransferScan(cfg, sendFn) {
  const tribeSrc = cfg.sources?.find((s) => s.type === 'tribe_top_villages_and_today_conquers');
  if (!tribeSrc || tribeSrc.trackTribeTransfers === false) return;

  const { alerts, nextSnapshot } = await computeTribeTransfers(cfg, {
    userAgent: cfg.userAgent,
    delayMs: cfg.requestDelayMs ?? 0,
  });
  try {
    if (alerts.length) {
      await sendFn(formatTransferAlertsHtml(alerts, cfg.worldLabel || 'TW'));
      console.log(
        `[saatlik ${new Date().toISOString()}] Klan değişikliği: ${alerts.length} bildirim.`
      );
    }
  } finally {
    if (nextSnapshot != null) persistTribeTransferSnapshot(nextSnapshot);
  }
}

/** Gece yarısı (00:00) özetinde fetihler “biten gün”e göre sayılır (Z raporu). */
function tribeRankingUrlFromCfg(cfg) {
  const tribeSrc = cfg.sources?.find((s) => s.type === 'tribe_top_villages_and_today_conquers');
  return tribeSrc?.rankingUrl || tribeSrc?.url || null;
}

function conquerDayYmdForScheduledSlot(slot, timeZone) {
  const [hs, ms] = slot.split(':');
  const h = parseInt(hs, 10);
  const m = parseInt(ms ?? '0', 10);
  if (h === 0 && m === 0) return ymdYesterdayInTimeZone(timeZone);
  return undefined;
}

async function buildDigestHtml(cfg, digestOpts = {}) {
  const results = await collectSources(cfg.sources, {
    userAgent: cfg.userAgent,
    delayMs: cfg.requestDelayMs ?? 0,
    timezone: cfg.timezone,
    conquerDayYmd: digestOpts.conquerDayYmd,
    twStatsDisplayedUtcOffsetMinutes: cfg.twStatsDisplayedUtcOffsetMinutes,
  });
  // Savaş istatistikleri yalnızca /savas ve config.wars komutlarında (/vegasvsudw, /vegasvseibo, /eibovsudw, …)
  return formatDigestHtml({
    worldLabel: cfg.worldLabel || 'TW',
    results,
    timezone: cfg.timezone || 'Europe/Istanbul',
  });
}

function parseOptionalWarDateArg(text, timeZone) {
  const rest = String(text || '')
    .trim()
    .replace(/^\S+\s*/, '')
    .trim()
    .replace(/^@\S+\s*/i, '')
    .trim();
  if (!rest) return null;
  if (/^\d{8}$/.test(rest)) return conquerYmdFromDdMmYyyy(rest);
  if (/^\d{4}$/.test(rest)) return conquerYmdFromDdMm(rest, timeZone);
  throw new Error('Tarih GGAAYYYY (örn. 13102026) veya GGAŞ (örn. 1310) olmalı.');
}

function buildCommandsHelpHtml(cfg) {
  const wars = normalizeWars(cfg);
  const warLines = wars.flatMap((w) => {
    const s = warCommandSlug(w);
    return [
      `/${s} — <b>${escapeHtml(w.name)}</b> toplam skor`,
      `/${s} GGAAYYYY — o günün skoru (örn. <code>/${s} 13102026</code>)`,
    ];
  });
  return [
    '<b>Komutlar</b>',
    '',
    '<b>Özet</b>',
    '/info — Tam özet (bugün)',
    '/info2203 — 22 Mart fetih özeti (GGAŞ)',
    '/gunsonu — Dünün özeti',
    '/plan — Gönderim saatleri',
    '',
    '<b>Savaş</b>',
    '/savas — Tüm savaşlar (bugün)',
    '/savas 13102026 — Tüm savaşlar (o gün)',
    ...warLines,
    '',
    '<b>Diğer</b>',
    '/ping — Bot çalışıyor mu?',
    '/barbar — Barbar monitör durumu',
    '/komutlar — Bu liste (/help)',
    '',
    '<i>Yalnızca Vegas bildirim grubunda çalışır.</i>',
  ].join('\n');
}

function buildTelegramMenuCommands(cfg) {
  const wars = normalizeWars(cfg);
  return [
    { command: 'komutlar', description: 'Komut listesi' },
    { command: 'info', description: 'Tam özet (bugün)' },
    { command: 'gunsonu', description: 'Dünün özeti' },
    { command: 'savas', description: 'Tüm savaşlar (bugün)' },
    ...wars.map((w) => ({
      command: warCommandSlug(w),
      description: `${w.name} skoru`,
    })),
    { command: 'plan', description: 'Gönderim saatleri' },
    { command: 'ping', description: 'Bot testi' },
    { command: 'barbar', description: 'Barbar monitör durumu' },
  ];
}

async function sendDigestForSlot(cfg, slot, sendFn) {
  if (alreadySentToday(slot, cfg.timezone)) {
    console.log(`[${slot}] Bugün zaten gönderildi, atlanıyor.`);
    return;
  }
  const tz = cfg.timezone || 'Europe/Istanbul';
  const conquerDayYmd = conquerDayYmdForScheduledSlot(slot, tz);
  if (conquerDayYmd) {
    console.log(`[${slot}] Gün sonu raporu: fetih tarihi ${conquerDayYmd}`);
  }
  const text = await buildDigestHtml(cfg, conquerDayYmd ? { conquerDayYmd } : {});
  await sendFn(text);
  markSentToday(slot, cfg.timezone);
  console.log(`[${slot}] Özet gönderildi.`);
}

async function runTelegramUpdates() {
  const useBarbar = argv.includes('--barbar');
  const token = useBarbar
    ? process.env.TELEGRAM_BARBAR_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim()
    : process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.error(
      useBarbar
        ? 'TELEGRAM_BARBAR_BOT_TOKEN (veya TELEGRAM_BOT_TOKEN) .env içinde tanımlı olmalı.'
        : 'TELEGRAM_BOT_TOKEN .env içinde tanımlı olmalı.'
    );
    process.exit(1);
  }
  console.log(
    useBarbar
      ? 'Barbar bot token ile getUpdates (TELEGRAM_BARBAR_CHAT_ID için).'
      : 'Vegas/istatistik bot token ile getUpdates (TELEGRAM_CHAT_ID için).'
  );
  const base = `https://api.telegram.org/bot${token}`;
  const me = await axios.get(`${base}/getMe`, { timeout: 15000 });
  console.log('Bot:', JSON.stringify(me.data, null, 2));
  const up = await axios.get(`${base}/getUpdates`, { timeout: 15000 });
  console.log('\nSon güncellemeler (gruba/kanala bir mesaj yazın veya bota /start gönderin, sonra komutu tekrar çalıştırın):');
  console.log(JSON.stringify(up.data, null, 2));
  if (up.data?.result?.length) {
    console.log('\n--- chat_id örnekleri ---');
    for (const u of up.data.result) {
      const m = u.message || u.channel_post || u.edited_message;
      if (m?.chat?.id != null) {
        console.log(`chat.id: ${m.chat.id}\t${m.chat.title || m.chat.username || m.chat.type || ''}`);
      }
    }
  } else {
    console.log('\n(update yok.)');
    console.log(
      'Grupta yazdığınız halde boşsa: BotFather → /setprivacy → Disable — gruptaki tüm mesajları bot görür (önerilir).'
    );
    console.log('Alternatif: grupta /start@BotKullaniciAdiniz veya bota yanıt vererek yazın.');
  }
}

async function runSendTest() {
  const cfg = loadJsonConfig();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const barbarToken =
    process.env.TELEGRAM_BARBAR_BOT_TOKEN?.trim() || token;
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const barbarChatId = process.env.TELEGRAM_BARBAR_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID .env içinde gerekli.');
    process.exit(1);
  }
  const body = await buildDigestHtml(cfg);
  const { alerts, nextSnapshot } = await computeTribeTransfers(cfg, {
    userAgent: cfg.userAgent,
    delayMs: cfg.requestDelayMs ?? 0,
  });
  await sendViaTelegram({ token, chatId, text: `<i>Kurulum testi (istatistik grubu)</i>\n\n${body}` });
  try {
    if (alerts.length) {
      await sendViaTelegram({
        token,
        chatId,
        text: formatTransferAlertsHtml(alerts, cfg.worldLabel || 'TW'),
      });
    }
  } finally {
    if (nextSnapshot != null) persistTribeTransferSnapshot(nextSnapshot);
  }
  console.log('İstatistik test mesajı gönderildi.');

  if (cfg.barbarMonitor?.enabled) {
    if (!barbarChatId) {
      console.error('barbarMonitor açık ama TELEGRAM_BARBAR_CHAT_ID boş — barbar test atlandı.');
    } else if (!barbarToken) {
      console.error('TELEGRAM_BARBAR_BOT_TOKEN boş — barbar test atlandı.');
    } else {
      await sendViaTelegram({
        token: barbarToken,
        chatId: barbarChatId,
        text: '<i>Kurulum testi (barbar grubu)</i>\nBarbar bildirimleri bu sohbete gelecek.',
      });
      console.log('Barbar test mesajı gönderildi.');
    }
  }
}

function startBot() {
  const cfg = loadJsonConfig();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const barbarToken = process.env.TELEGRAM_BARBAR_BOT_TOKEN?.trim() || token;
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const barbarChatId = process.env.TELEGRAM_BARBAR_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID .env içinde gerekli.');
    console.error('chat_id için: npm run telegram-updates');
    process.exit(1);
  }
  const barbarOn = cfg.barbarMonitor?.enabled === true;
  if (barbarOn && !barbarChatId) {
    console.error('barbarMonitor.enabled=true iken TELEGRAM_BARBAR_CHAT_ID .env içinde gerekli.');
    console.error('Barbar grubunda mesaj yazıp: npm run telegram-updates -- --barbar');
    process.exit(1);
  }
  if (barbarOn && !process.env.TELEGRAM_BARBAR_BOT_TOKEN?.trim()) {
    console.warn(
      'Uyarı: TELEGRAM_BARBAR_BOT_TOKEN yok — barbar bildirimleri Vegas bot tokenı ile gidecek.'
    );
  }

  /** İstatistik / klan transfer → TELEGRAM_CHAT_ID (Vegas bot) */
  const sendText = (text) => sendViaTelegram({ token, chatId, text });
  /** Barbar bildirimleri → TELEGRAM_BARBAR_CHAT_ID (barbar bot) */
  const sendBarbar = (text) =>
    sendViaTelegram({ token: barbarToken, chatId: barbarChatId || chatId, text });
  const sendToChat = (targetChatId, text) => sendViaTelegram({ token, chatId: targetChatId, text });
  const sendWarCrossTxt = async (targetChatId, stats, worldLabel) => {
    const txt = formatWarCrossDetailsTxt(stats, { worldLabel });
    if (!txt) return;
    const dayPart = stats.targetYmd || 'toplam';
    const slug = warCommandSlug({ name: stats.warName, command: stats.warName });
    const filename = `${slug || 'savas'}-${dayPart}-koyler.txt`.replace(/[^\w.\-]+/g, '_');
    await sendViaTelegramDocument({
      token,
      chatId: targetChatId,
      filename,
      content: txt,
      caption: `${stats.warName || 'Savaş'} — taraflar arası köy listesi`,
    });
  };

  /** Komutlar yalnızca Vegas grubunda (Vegas bot polling) */
  const allowedChatIds = [chatId];

  const stopPoll = startTelegramPolling({
    token,
    allowedChatIds,
    sendHtml: sendToChat,
    commands: [
      {
        match: /^\/(komutlar|help|yardim|commands)(@\w+)?$/i,
        async run(cid) {
          await sendToChat(cid, buildCommandsHelpHtml(loadJsonConfig()));
        },
      },
      {
        match: /^\/ping(?:@\w+)?$/i,
        async run(cid) {
          await sendToChat(cid, '<b>OK</b>\nBot çalışıyor.');
        },
      },
      {
        match: /^\/barbar(?:@\w+)?$/i,
        heavy: true,
        loadingHtml: '<i>Barbar durumu alınıyor…</i>',
        async run(cid) {
          const status = await getBarbarStatus(loadJsonConfig());
          await sendToChat(cid, status);
        },
      },
      {
        match: /^\/(plan|zaman)(@\w+)?$/i,
        async run(cid) {
          const c = loadJsonConfig();
          const tz = c.timezone || 'Europe/Istanbul';
          const slots =
            Array.isArray(c.schedule) && c.schedule.length
              ? c.schedule.map((s) => `• ${escapeHtml(String(s))}`).join('\n')
              : '• (schedule tanımlı değil)';
          await sendToChat(cid, `<b>Zamanlama</b> (${escapeHtml(tz)})\n${slots}`);
        },
      },
      {
        match: /^\/(gunsonu|günsonu)(@\w+)?$/i,
        heavy: true,
        loadingHtml: '<i>Dünün özeti çekiliyor…</i>',
        async run(cid) {
          const freshCfg = loadJsonConfig();
          const tz = freshCfg.timezone || 'Europe/Istanbul';
          const y = ymdYesterdayInTimeZone(tz);
          const body = await buildDigestHtml(freshCfg, { conquerDayYmd: y });
          await sendToChat(cid, `<b>Gün sonu özeti (${escapeHtml(y)})</b>\n\n${body}`);
          console.log(`[/gunsonu] ${y} gönderildi (${cid}).`);
        },
      },
      {
        match: /^\/info\.([^@\s]+)(@\w+)?$/i,
        heavy: true,
        loadingHtml: '<i>Oyuncu fetihleri taranıyor…</i>',
        async run(cid, meta) {
          const m = /^\/info\.([^@\s]+)/i.exec(meta.commandToken);
          if (!m) throw new Error('Komut okunamadı.');
          const telegramKey = m[1];
          // #region agent log
          agentLog({
            hypothesisId: 'H1',
            location: 'index.js:/info.dot run',
            message: 'parsed player command',
            data: {
              commandToken: meta.commandToken,
              telegramKey,
              keyCharCodes: [...telegramKey].map((c) => c.charCodeAt(0)),
            },
          });
          // #endregion
          const freshCfg = loadJsonConfig();
          const rankingUrl = tribeRankingUrlFromCfg(freshCfg);
          if (!rankingUrl) {
            throw new Error('config.json: tribe_top_villages_and_today_conquers rankingUrl gerekli.');
          }
          const worldBase = worldIndexBaseFromRankingUrl(rankingUrl);
          const ingameName = resolveTelegramKeyToIngame(freshCfg, telegramKey);
          const found = await searchPlayerByName(worldBase, ingameName, {
            userAgent: freshCfg.userAgent,
          });
          // #region agent log
          agentLog({
            hypothesisId: 'H3',
            location: 'index.js:/info.dot after search',
            message: 'search result',
            data: {
              searchIngame: ingameName,
              found: found ? { id: found.playerId, matchedName: found.matchedName } : null,
            },
          });
          // #endregion
          if (!found) {
            throw new Error(
              'Oyuncu bulunamadı veya birden fazla eşleşme var. TW tam nick veya tanımlı takma ad kullanın.'
            );
          }
          const maxPages = freshCfg.maxPlayerConquerPages ?? 35;
          const tz = freshCfg.timezone || 'Europe/Istanbul';
          const statDays = freshCfg.playerConquerStatsDays ?? 3;
          const { total, byDay, minYmd, maxYmd, days } = await countPlayerConquersLastNDays({
            worldBase,
            playerId: found.playerId,
            ingameName: found.matchedName,
            timeZone: tz,
            days: statDays,
            userAgent: freshCfg.userAgent,
            delayMs: freshCfg.requestDelayMs ?? 0,
            maxPages,
            twStatsDisplayedUtcOffsetMinutes: freshCfg.twStatsDisplayedUtcOffsetMinutes,
          });
          const text = formatPlayerConquersSummaryHtml({
            worldLabel: freshCfg.worldLabel || 'TW',
            timeZone: tz,
            telegramKey,
            ingameName: found.matchedName,
            matchedName: found.matchedName,
            total,
            byDay,
            minYmd,
            maxYmd,
            days,
          });
          await sendToChat(cid, text);
          console.log(`[/info.${telegramKey}] ${found.matchedName} → ${total} köy (${cid}).`);
        },
      },
      {
        match: /^\/info(\d{4})(@\w+)?$/i,
        heavy: true,
        loadingHtml: '<i>İstatistik çekiliyor…</i>',
        async run(cid, meta) {
          const m = /^\/info(\d{4})/i.exec(meta.commandToken);
          if (!m) throw new Error('Tarih okunamadı.');
          const freshCfg = loadJsonConfig();
          const tz = freshCfg.timezone || 'Europe/Istanbul';
          const y = conquerYmdFromDdMm(m[1], tz);
          const rest = meta.text
            .trim()
            .replace(/^\S+\s*/, '')
            .trim();
          const victimTag = rest.replace(/^@\S+\s*/i, '').trim();

          if (victimTag) {
            const tribeSrc = freshCfg.sources?.find((s) => s.type === 'tribe_top_villages_and_today_conquers');
            const rankingUrl = tribeSrc?.rankingUrl || tribeSrc?.url;
            const matchHeaders = tribeSrc?.matchHeaders || [
              'Rank',
              'Tag',
              'Points of best 40',
              'Total Points',
              'Members',
              'Average points per member',
              'Villages',
              'Average points per village',
            ];
            if (!rankingUrl) {
              throw new Error('config.json: tribe_top_villages_and_today_conquers rankingUrl gerekli.');
            }
            const rankHtml = await fetchHtml(rankingUrl, { userAgent: freshCfg.userAgent });
            const { error: findErr, tribe: victim } = findTribeInRankingByTag(
              rankHtml,
              matchHeaders,
              victimTag,
              500
            );
            if (findErr || !victim) {
              throw new Error(findErr || 'Klan bulunamadı.');
            }
            const topN = tribeSrc?.victimReportTopTribes ?? 25;
            const maxTribePages = tribeSrc?.maxTribeConquerPages ?? 25;
            const { error, lines, victimName } = await countTakesFromVictimAmongTopTribes(rankingUrl, matchHeaders, {
              targetYmd: y,
              victimTribeId: victim.tribeId,
              victimName: victim.name,
              topTribeRows: topN,
              maxTribeConquerPages: maxTribePages,
              userAgent: freshCfg.userAgent,
              delayMs: freshCfg.requestDelayMs ?? 0,
              rankingHtml: rankHtml,
              timezone: tz,
              twStatsDisplayedUtcOffsetMinutes: freshCfg.twStatsDisplayedUtcOffsetMinutes,
            });
            if (error) throw new Error(error);
            const header = `<b>${escapeHtml(y)}</b> — <b>${escapeHtml(victimName)}</b> köylerini ilk <b>${topN}</b> sıradaki hangi klanlar almış\n<i>(TWStats klan fetih sayfası — kırmızı/kayıp satırlar, tarih sütunu günü)</i>`;
            const body =
              lines.length > 0
                ? lines.map((ln) => escapeHtml(ln)).join('\n')
                : '<i>O gün için bu sıra aralığında kayıt yok (veya ennoblements sayfa sınırına takıldı).</i>';
            await sendToChat(cid, `${header}\n\n${body}`);
            console.log(`[/info${m[1]} ${victimTag}] ${y} → ${lines.length} satır (${cid}).`);
            return;
          }

          const body = await buildDigestHtml(freshCfg, { conquerDayYmd: y });
          await sendToChat(cid, `<b>Tarihli özet (${escapeHtml(y)})</b>\n\n${body}`);
          console.log(`[/info${m[1]}] ${y} gönderildi (${cid}).`);
        },
      },
      {
        match: /^\/info(?:@\w+)?$/i,
        heavy: true,
        loadingHtml: '<i>İstatistik çekiliyor…</i>',
        async run(cid) {
          const freshCfg = loadJsonConfig();
          const body = await buildDigestHtml(freshCfg);
          await sendToChat(cid, `<b>Manuel özet</b>\n\n${body}`);
          console.log(`[/info] Özet gönderildi (${cid}).`);
        },
      },
      {
        match: /^\/savas(?:@\w+)?$/i,
        heavy: true,
        loadingHtml: '<i>Savaş istatistiği çekiliyor…</i>',
        async run(cid, meta) {
          const freshCfg = loadJsonConfig();
          const wars = normalizeWars(freshCfg);
          if (!wars.length) throw new Error('config.json: wars tanımlı değil.');
          const tz = freshCfg.timezone || 'Europe/Istanbul';
          const day = parseOptionalWarDateArg(meta.text, tz);
          const parts = [];
          /** @type {object[]} */
          const warStatsList = [];
          for (const war of wars) {
            const stats = await computeWarStats(freshCfg, war, {
              conquerDayYmd: day || ymdInTimeZone(tz),
            });
            warStatsList.push(stats);
            parts.push(formatWarStatsHtml(stats, { worldLabel: freshCfg.worldLabel }));
          }
          await sendToChat(cid, parts.join('\n\n'));
          for (const stats of warStatsList) {
            await sendWarCrossTxt(cid, stats, freshCfg.worldLabel);
          }
          console.log(`[/savas] ${day || 'bugün'} gönderildi (${cid}).`);
        },
      },
      ...normalizeWars(cfg).map((war) => {
        const slug = warCommandSlug(war);
        return {
          match: new RegExp(`^/${slug}(?:@\\w+)?$`, 'i'),
          heavy: true,
          loadingHtml: `<i>${escapeHtml(war.name)} çekiliyor…</i>`,
          async run(cid, meta) {
            const freshCfg = loadJsonConfig();
            const wars = normalizeWars(freshCfg);
            const live = wars.find((w) => warCommandSlug(w) === slug) || war;
            const tz = freshCfg.timezone || 'Europe/Istanbul';
            const day = parseOptionalWarDateArg(meta.text, tz);
            const stats = await computeWarStats(freshCfg, live, {
              conquerDayYmd: day,
            });
            await sendToChat(cid, formatWarStatsHtml(stats, { worldLabel: freshCfg.worldLabel }));
            await sendWarCrossTxt(cid, stats, freshCfg.worldLabel);
            console.log(
              `[/${slug}] ${day || 'toplam'} gönderildi (${cid}).`
            );
          },
        };
      }),
    ],
  });

  const stopDigest = scheduleDigestJobs({
    schedule: cfg.schedule,
    timezone: cfg.timezone,
    onTick: (slot) => sendDigestForSlot(cfg, slot, sendText),
  });

  const tribeSrc = cfg.sources?.find((s) => s.type === 'tribe_top_villages_and_today_conquers');
  const transfersOn = tribeSrc && tribeSrc.trackTribeTransfers !== false;
  const stopHourly = transfersOn
    ? scheduleHourlyOnTheHour({
        timezone: cfg.timezone,
        onTick: () => runTransferScan(cfg, sendText),
      })
    : () => {};

  const barbarIntervalMin = cfg.barbarMonitor?.intervalMinutes ?? 5;
  const stopBarbar = barbarOn
    ? scheduleEveryNMinutes({
        n: barbarIntervalMin,
        timezone: cfg.timezone,
        onTick: () => runBarbarScan({ cfg: loadJsonConfig(), sendFn: sendBarbar }),
      })
    : () => {};

  console.log(`Telegram istatistik chat_id: ${chatId}. Özet (${cfg.timezone}): ${cfg.schedule.join(', ')}`);
  if (barbarOn) {
    console.log(
      `Telegram barbar chat_id: ${barbarChatId} (ayrı bot: ${
        process.env.TELEGRAM_BARBAR_BOT_TOKEN?.trim() ? 'evet' : 'hayır — Vegas token'
      })`
    );
  }
  console.log('Telegram: /komutlar veya /help (Vegas grubunda).');
  setTelegramBotCommands(token, buildTelegramMenuCommands(cfg)).catch((e) =>
    console.warn('setMyCommands:', e instanceof Error ? e.message : e)
  );
  if (transfersOn) {
    console.log(`Klan üye taraması: her saat başı (${cfg.timezone})`);
    runTransferScan(cfg, sendText).catch((e) => console.error('Başlangıç klan taraması:', e));
  }
  if (barbarOn) {
    const conts = (cfg.barbarMonitor?.watchContinents ?? []).map((c) => `K${c}`).join(', ') || 'Tümü';
    console.log(`Barbar monitörü: her ${barbarIntervalMin} dk — kıtalar: ${conts}`);
    runBarbarScan({ cfg, sendFn: sendBarbar }).catch((e) =>
      console.error('Başlangıç barbar taraması:', e)
    );
  }

  process.on('SIGINT', () => {
    stopPoll();
    stopDigest();
    stopHourly();
    stopBarbar();
    process.exit(0);
  });
}

function main() {
  if (argv.includes('--dry-run')) {
    runDryRun().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    return;
  }

  if (argv.includes('--telegram-updates')) {
    runTelegramUpdates().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    return;
  }

  if (argv.includes('--send-test')) {
    runSendTest().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    return;
  }

  startBot();
}

main();

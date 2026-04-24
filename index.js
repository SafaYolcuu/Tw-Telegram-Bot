import 'dotenv/config';
import axios from 'axios';
import { loadJsonConfig } from './src/loadConfig.js';
import {
  collectSources,
  conquerYmdFromDdMm,
  countTakesFromVictimAmongTopTribes,
  fetchHtml,
  findTribeInRankingByTag,
  ymdYesterdayInTimeZone,
} from './src/scrape.js';
import { escapeHtml, formatDigest, formatDigestHtml } from './src/formatMessage.js';
import { scheduleDigestJobs, scheduleHourlyOnTheHour } from './src/scheduler.js';
import { alreadySentToday, markSentToday } from './src/dedupe.js';
import { sendViaTelegram } from './src/sendTelegram.js';
import { startTelegramPolling } from './src/telegramPoll.js';
import { computeTribeTransfers, persistTribeTransferSnapshot, formatTransferAlertsHtml } from './src/tribeTransfers.js';
import { agentLog } from './src/debugAgentLog.js';
import {
  countPlayerConquersLastNDays,
  formatPlayerConquersSummaryHtml,
  resolveTelegramKeyToIngame,
  searchPlayerByName,
  worldIndexBaseFromRankingUrl,
} from './src/playerConquers.js';

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
  return formatDigestHtml({
    worldLabel: cfg.worldLabel || 'TW',
    results,
    timezone: cfg.timezone || 'Europe/Istanbul',
  });
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
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN .env içinde tanımlı olmalı.');
    process.exit(1);
  }
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
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID .env içinde gerekli.');
    process.exit(1);
  }
  const body = await buildDigestHtml(cfg);
  const { alerts, nextSnapshot } = await computeTribeTransfers(cfg, {
    userAgent: cfg.userAgent,
    delayMs: cfg.requestDelayMs ?? 0,
  });
  await sendViaTelegram({ token, chatId, text: `<i>Kurulum testi</i>\n\n${body}` });
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
  console.log('Test mesajı gönderildi.');
}

function startBot() {
  const cfg = loadJsonConfig();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID .env içinde gerekli.');
    console.error('chat_id için: npm run telegram-updates');
    process.exit(1);
  }
  const sendText = (text) => sendViaTelegram({ token, chatId, text });
  const sendToChat = (targetChatId, text) => sendViaTelegram({ token, chatId: targetChatId, text });

  const stopPoll = startTelegramPolling({
    token,
    allowedChatId: chatId,
    sendHtml: sendToChat,
    commands: [
      {
        match: /^\/(komutlar|help|yardim|commands)(@\w+)?$/i,
        async run(cid) {
          await sendToChat(
            cid,
            [
              '<b>Komutlar</b>',
              '',
              '/info — Tam özet (bugünün verisi)',
              '/infoGGAŞ — Belirli günün fetih özeti (GGAŞ: gün+ay, örn. <code>/info2203</code> → 22 Mart)',
              '/infoGGAŞ klan — O günde sıralamadaki klanların o klandan aldığı köy (örn. <code>/info2404 BOMBAC</code>)',
              '/info.takma — Son N günde günlük + toplam köy (N=<code>playerConquerStatsDays</code>, takma adlar <code>telegramPlayerAliases</code>)',
              '/gunsonu — Dünün fetih özeti (manuel Z raporu)',
              '/plan — Zamanlanmış gönderim saatleri',
              '/ping — Bot çalışıyor mu?',
              '',
              '/komutlar — Bu listeyi gösterir (aynı: /help, /yardim, /commands)',
              '',
              '<i>Sıra/puan tablosu her zaman güncel TW verisidir; tarih seçimi fetih sayıları içindir.</i>',
            ].join('\n')
          );
        },
      },
      {
        match: /^\/ping(?:@\w+)?$/i,
        async run(cid) {
          await sendToChat(cid, '<b>OK</b>\nBot çalışıyor.');
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
            const topN = tribeSrc?.maxRows ?? 10;
            const maxEnn = tribeSrc?.maxEnnoblementPages ?? 40;
            const { error, lines, victimName } = await countTakesFromVictimAmongTopTribes(rankingUrl, matchHeaders, {
              targetYmd: y,
              victimTribeId: victim.tribeId,
              victimName: victim.name,
              topTribeRows: topN,
              maxEnnPages: maxEnn,
              userAgent: freshCfg.userAgent,
              delayMs: freshCfg.requestDelayMs ?? 0,
              rankingHtml: rankHtml,
            });
            if (error) throw new Error(error);
            const header = `<b>${escapeHtml(y)}</b> — <b>${escapeHtml(victimName)}</b> köylerini ilk <b>${topN}</b> sıradaki hangi klanlar almış\n<i>(TWStats dünya fetih listesi, tarih sütunu günü)</i>`;
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

  console.log(`Telegram. chat_id: ${chatId}. Özet (${cfg.timezone}): ${cfg.schedule.join(', ')}`);
  console.log('Telegram: /komutlar veya /help (yalnızca bu chat_id).');
  if (transfersOn) {
    console.log(`Klan üye taraması: her saat başı (${cfg.timezone})`);
    runTransferScan(cfg, sendText).catch((e) => console.error('Başlangıç klan taraması:', e));
  }

  process.on('SIGINT', () => {
    stopPoll();
    stopDigest();
    stopHourly();
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

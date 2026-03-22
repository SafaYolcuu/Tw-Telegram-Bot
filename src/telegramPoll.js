import axios from 'axios';
import { agentLog } from './debugAgentLog.js';
import { escapeHtml } from './formatMessage.js';

/**
 * @typedef {object} TelegramBotCommand
 * @property {RegExp} match — Mesajın ilk kelimesi (örn. `/info` veya `/info@BotAd`)
 * @property {boolean} [heavy] — TW çekimi gibi; tek seferde biri, ortak bekleme süresi
 * @property {number} [cooldownMs] — `heavy` için varsayılan: `heavyCooldownMs`
 * @property {string} [loadingHtml] — `heavy` istekten önce gönderilir
 * @property {(chatId: string | number, meta: { commandToken: string, text: string }) => Promise<void>} run
 */

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string|number} opts.allowedChatId
 * @param {(chatId: string | number, text: string) => Promise<void>} opts.sendHtml
 * @param {TelegramBotCommand[]} opts.commands — İlk eşleşen çalışır (sıra önemli)
 * @param {number} [opts.heavyCooldownMs]
 */
export function startTelegramPolling(opts) {
  const base = `https://api.telegram.org/bot${opts.token}`;
  let offset = 0;
  let stopped = false;
  let heavyInFlight = false;
  let lastHeavyAt = 0;
  const heavyCooldownMs = opts.heavyCooldownMs ?? 45_000;
  const allowed = String(opts.allowedChatId).trim();

  async function handleUpdate(update) {
    const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    if (!msg?.text || msg.chat?.id == null) return;
    const text = msg.text.trim();
    const first = text.split(/\s+/)[0] || '';
    const meta = { commandToken: first, text };

    const cmd = opts.commands.find((c) => c.match.test(first));
    if (!cmd) return;
    // #region agent log
    if (/^\/info\./i.test(first)) {
      agentLog({
        hypothesisId: 'H4',
        location: 'telegramPoll.js:handleUpdate',
        message: 'info-dot command matched router',
        data: { first, matchedHeavy: cmd.heavy === true },
      });
    }
    // #endregion

    const chatId = msg.chat.id;
    if (String(chatId) !== allowed) {
      await opts.sendHtml(chatId, escapeHtml('Bu komut yalnızca kayıtlı hedef sohbette kullanılabilir.'));
      return;
    }

    const heavy = cmd.heavy === true;
    const cooldownMs = heavy ? (cmd.cooldownMs ?? heavyCooldownMs) : (cmd.cooldownMs ?? 0);

    if (heavy) {
      if (heavyInFlight) {
        await opts.sendHtml(chatId, '<i>Önceki istek hâlen işleniyor…</i>');
        return;
      }
      if (cooldownMs > 0) {
        const now = Date.now();
        if (now - lastHeavyAt < cooldownMs) {
          await opts.sendHtml(
            chatId,
            escapeHtml(`Çok sık istek. Yaklaşık ${Math.ceil((cooldownMs - (now - lastHeavyAt)) / 1000)} sn sonra deneyin.`)
          );
          return;
        }
      }
    }

    if (heavy) {
      heavyInFlight = true;
      lastHeavyAt = Date.now();
      try {
        if (cmd.loadingHtml) await opts.sendHtml(chatId, cmd.loadingHtml);
        await cmd.run(chatId, meta);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.error('[telegram komut]', m);
        await opts.sendHtml(chatId, `<b>Hata</b>\n${escapeHtml(m)}`);
      } finally {
        heavyInFlight = false;
      }
    } else {
      try {
        await cmd.run(chatId, meta);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.error('[telegram komut]', m);
        await opts.sendHtml(chatId, `<b>Hata</b>\n${escapeHtml(m)}`);
      }
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        const { data } = await axios.get(`${base}/getUpdates`, {
          params: {
            offset,
            timeout: 50,
            allowed_updates: JSON.stringify(['message', 'edited_message', 'channel_post', 'edited_channel_post']),
          },
          timeout: 55000,
        });
        for (const u of data.result || []) {
          offset = u.update_id + 1;
          await handleUpdate(u).catch((err) => console.error('telegramPoll handleUpdate', err));
        }
      } catch (e) {
        if (stopped) break;
        console.error('getUpdates', e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  loop();
  return () => {
    stopped = true;
  };
}

import axios from 'axios';

const MAX_LEN = 4096;

/**
 * @param {{ token: string, chatId: string | number, text: string }} p
 */
export async function sendViaTelegram({ token, chatId, text }) {
  const safe = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 40)}\n…(kısaltıldı)` : text;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await axios.post(
    url,
    {
      chat_id: chatId,
      text: safe,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
    { timeout: 30000 }
  );
}

/**
 * Metin dosyası gönder (doğrulama listeleri vb.; mesaj limiti şişmez).
 * @param {{ token: string, chatId: string | number, filename: string, content: string, caption?: string }} p
 */
export async function sendViaTelegramDocument({ token, chatId, filename, content, caption }) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(
    'document',
    new Blob([content], { type: 'text/plain;charset=utf-8' }),
    filename || 'list.txt'
  );
  if (caption) form.append('caption', String(caption).slice(0, 1024));
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  await axios.post(url, form, { timeout: 60000 });
}

/**
 * Telegram / menüsünde görünen komut listesi (BotFather setcommands eşdeğeri).
 * @param {string} token
 * @param {Array<{ command: string, description: string }>} commands
 */
export async function setTelegramBotCommands(token, commands) {
  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  await axios.post(
    url,
    {
      commands: commands.map((c) => ({
        command: String(c.command).replace(/^\//, '').toLowerCase(),
        description: String(c.description).slice(0, 256),
      })),
    },
    { timeout: 15000 }
  );
}

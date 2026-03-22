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

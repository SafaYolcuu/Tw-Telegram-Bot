export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Telegram'da `<table>` yok; `─` / `│` / köşe karakterleriyle `<pre>` içinde tablo çerçevesi.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {{ maxCellWidth?: number }} [opts]
 */
export function buildAlignedTable(headers, rows, opts = {}) {
  const maxCellWidth = opts.maxCellWidth ?? 18;
  const trunc = (s) => {
    const x = String(s ?? '').trim();
    return x.length > maxCellWidth ? `${x.slice(0, maxCellWidth - 1)}…` : x;
  };
  const h = headers.map(trunc);
  const r = rows.map((row) => row.map(trunc));
  const n = Math.max(h.length, ...r.map((row) => row.length), 0);
  if (n === 0) return '';
  const pad = (s, w) => s.padEnd(w, ' ');
  const widths = Array.from({ length: n }, (_, j) =>
    Math.max((h[j] || '').length, ...r.map((row) => (row[j] || '').length))
  );

  const horizSeg = (w) => '─'.repeat(w + 2);
  const segs = widths.map(horizSeg);
  const top = `┌${segs.join('┬')}┐`;
  const mid = `├${segs.join('┼')}┤`;
  const bot = `└${segs.join('┴')}┘`;
  const rowLine = (cells) =>
    `│${Array.from({ length: n }, (_, j) => ` ${pad(cells[j] || '', widths[j])} `).join('│')}│`;

  return [top, rowLine(h), mid, ...r.map((row) => rowLine(row)), bot].join('\n');
}

function formatDigestTimeLine(timezone = 'Europe/Istanbul') {
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

/**
 * @param {{ worldLabel: string, results: Array<{ title: string, lines: string[], headers?: string[], rows?: string[][], error?: string | null }> }} params
 */
export function formatDigest({ worldLabel, results }) {
  const now = new Date().toISOString();
  const blocks = results.map((r) => {
    if (r.error) {
      return `*${r.title}*\nHata: ${r.error}`;
    }
    if (r.headers?.length && r.rows?.length) {
      return `*${r.title}*\n${buildAlignedTable(r.headers, r.rows)}`;
    }
    if (!r.lines.length) {
      return `*${r.title}*\nVeri yok.`;
    }
    const body = r.lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
    return `*${r.title}*\n${body}`;
  });
  const header = `*TW Stats — ${worldLabel}*\n_${now}_\n`;
  return header + '\n\n' + blocks.join('\n\n');
}

/**
 * Telegram Bot API `parse_mode: HTML` için.
 * Gerçek tablo etiketi yok; `rows` + `headers` varsa `<pre>` ile hizalı metin.
 * @param {{ worldLabel: string, results: Array<{ title: string, lines: string[], headers?: string[], rows?: string[][], error?: string | null }>, timezone?: string }} params
 */
export function formatDigestHtml({ worldLabel, results, timezone = 'Europe/Istanbul' }) {
  const timeLine = formatDigestTimeLine(timezone);
  const blocks = results.map((r) => {
    const title = escapeHtml(r.title);
    if (r.error) {
      return `<b>${title}</b>\n${escapeHtml(`Hata: ${r.error}`)}`;
    }
    if (r.headers?.length && r.rows?.length) {
      const table = buildAlignedTable(r.headers, r.rows);
      return `<b>${title}</b>\n<pre>${escapeHtml(table)}</pre>`;
    }
    if (!r.lines.length) {
      return `<b>${title}</b>\n${escapeHtml('Veri yok.')}`;
    }
    const body = r.lines.map((l, i) => escapeHtml(`${i + 1}. ${l}`)).join('\n');
    return `<b>${title}</b>\n${body}`;
  });
  const header = `<b>${escapeHtml(`TW Stats — ${worldLabel}`)}</b>\n<i>${escapeHtml(timeLine)}</i>`;
  return `${header}\n\n${blocks.join('\n\n')}`;
}

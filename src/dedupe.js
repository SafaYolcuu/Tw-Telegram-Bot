import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(__dirname, '..', 'last-sent.json');

function ymdInZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

export function readSentState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @param {string} scheduleSlot e.g. "09:00"
 */
export function alreadySentToday(scheduleSlot, timeZone = 'Europe/Istanbul') {
  const state = readSentState();
  return state[scheduleSlot] === ymdInZone(timeZone);
}

/**
 * @param {string} scheduleSlot
 * @param {string} [timeZone]
 */
export function markSentToday(scheduleSlot, timeZone = 'Europe/Istanbul') {
  const state = readSentState();
  state[scheduleSlot] = ymdInZone(timeZone);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 0), 'utf8');
}

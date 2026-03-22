import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _logPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'debug-7b00b4.log');

/** @param {Record<string, unknown> & { hypothesisId?: string, location?: string, message?: string }} payload */
export function agentLog(payload) {
  const body = { sessionId: '7b00b4', timestamp: Date.now(), ...payload };
  try {
    fs.appendFileSync(_logPath, `${JSON.stringify(body)}\n`);
  } catch (_) {}
  // #region agent log
  fetch('http://127.0.0.1:7725/ingest/26535152-c38b-4e64-a23c-9b35ef800eed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7b00b4' },
    body: JSON.stringify(body),
  }).catch(() => {});
  // #endregion
}

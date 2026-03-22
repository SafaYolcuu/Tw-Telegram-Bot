import cron from 'node-cron';

/**
 * @param {{ schedule: string[], timezone: string, onTick: (slot: string) => void | Promise<void> }} opts
 * @returns {() => void} stopAll
 */
export function scheduleDigestJobs({ schedule, timezone, onTick }) {
  const tasks = [];
  for (const slot of schedule) {
    const [h, m] = slot.split(':').map((x) => parseInt(x, 10));
    if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
      throw new Error(`Geçersiz saat (HH:mm bekleniyor): ${slot}`);
    }
    const expr = `${m} ${h} * * *`;
    if (!cron.validate(expr)) throw new Error(`Cron doğrulanamadı: ${slot} -> ${expr}`);
    const task = cron.schedule(
      expr,
      () => {
        Promise.resolve(onTick(slot)).catch((e) => console.error('Zamanlayıcı görev hatası:', e));
      },
      { timezone, scheduled: false }
    );
    tasks.push(task);
  }
  tasks.forEach((t) => t.start());
  return () => tasks.forEach((t) => t.stop());
}

/** Her saat başı (dakika 0), örn. 13:00, 14:00 — `timezone` ile. */
export function scheduleHourlyOnTheHour({ timezone, onTick }) {
  const expr = '0 * * * *';
  if (!cron.validate(expr)) throw new Error('Saatlik cron doğrulanamadı');
  const task = cron.schedule(
    expr,
    () => {
      Promise.resolve(onTick()).catch((e) => console.error('Saatlik görev hatası:', e));
    },
    { timezone, scheduled: false }
  );
  task.start();
  return () => task.stop();
}

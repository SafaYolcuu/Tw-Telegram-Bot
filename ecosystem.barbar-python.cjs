/**
 * İsteğe bağlı: Python barbar monitörü (scripts/tw_barbar_monitor.py).
 * Kurulum: Windows’ta Python 3 yükleyin; ardından: py -3 -m pip install requests
 * Başlat: pm2 start ecosystem.barbar-python.cjs
 *
 * Not: Aynı işi yapan Node sürümü var: config.json → barbarMonitor.
 * İkisini aynı anda açmayın (çift bildirim).
 */
const isWin = process.platform === 'win32';

module.exports = {
  apps: [
    {
      name: 'tw-barbar-monitor',
      script: 'scripts/tw_barbar_monitor.py',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      ...(isWin
        ? { interpreter: 'py', interpreter_args: '-3' }
        : { interpreter: 'python' }),
    },
  ],
};

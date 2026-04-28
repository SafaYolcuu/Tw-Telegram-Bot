/** PM2: `pm2 start ecosystem.config.cjs` — çalışma dizini bu klasör olmalı. */
/** Windows: PATH'te genelde `py` var, `python` yok — barbar monitör için `py -3` kullanılır. */

const isWin = process.platform === 'win32';

const barbarMonitor = {
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
};

module.exports = {
  apps: [
    {
      name: 'twstats-bot',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
      },
    },
    barbarMonitor,
  ],
};

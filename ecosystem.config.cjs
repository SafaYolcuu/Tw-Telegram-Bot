/** PM2: `pm2 start ecosystem.config.cjs` — çalışma dizini bu klasör olmalı. */
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
  ],
};
